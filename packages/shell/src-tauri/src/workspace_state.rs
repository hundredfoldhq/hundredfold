//! The paired-workspace record (which workspaces exist, which one is active),
//! kept in a file the shell writes itself.
//!
//! The web layer keeps the same record in `localStorage`, but a WebView writes
//! that behind the page: a selection made just before the OS ends the app is
//! lost, and the next launch opens on the previous workspace. A file written and
//! synced here has reached the disk by the time the write command returns.
//!
//! The record names gateways and nothing else. Credentials never pass through
//! it; they stay in the credential store.

use std::{
    fs::{self, File},
    io::{self, Write},
    path::Path,
};

use serde::Deserialize;
use tauri::{AppHandle, Manager, WebviewWindow};

use crate::commands::{confine, NativeError};

const FILE_NAME: &str = "workspace-state.json";
const TEMP_NAME: &str = ".workspace-state.json.tmp";
/// A record of a few paired gateways is well under a kilobyte.
const MAX_BYTES: usize = 64 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum StateError {
    TooLarge,
    NotJson,
    Io,
}

pub fn read_record(dir: &Path) -> Result<Option<String>, StateError> {
    match fs::read_to_string(dir.join(FILE_NAME)) {
        Ok(text) if text.len() <= MAX_BYTES => Ok(Some(text)),
        Ok(_) => Err(StateError::TooLarge),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(StateError::Io),
    }
}

/// Replaces the record atomically: a reader sees the old one or the new one,
/// never a torn file, and the new bytes are on disk before this returns.
pub fn write_record(dir: &Path, document: &str) -> Result<(), StateError> {
    if document.len() > MAX_BYTES {
        return Err(StateError::TooLarge);
    }
    if !matches!(
        serde_json::from_str::<serde_json::Value>(document),
        Ok(serde_json::Value::Object(_))
    ) {
        return Err(StateError::NotJson);
    }
    fs::create_dir_all(dir).map_err(|_| StateError::Io)?;
    let temp = dir.join(TEMP_NAME);
    let result = (|| {
        let mut file = File::create(&temp)?;
        file.write_all(document.as_bytes())?;
        file.sync_all()?;
        fs::rename(&temp, dir.join(FILE_NAME))?;
        // Make the rename itself durable. Not every platform can open a
        // directory; the file contents are already synced either way.
        if let Ok(handle) = File::open(dir) {
            let _ = handle.sync_all();
        }
        Ok::<(), io::Error>(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(|_| StateError::Io)
}

impl From<StateError> for NativeError {
    fn from(error: StateError) -> Self {
        match error {
            StateError::TooLarge | StateError::NotJson => NativeError::invalid_request(),
            StateError::Io => NativeError::state_store(),
        }
    }
}

#[derive(Deserialize)]
pub struct WriteInput {
    pub document: String,
}

#[tauri::command]
pub fn workspace_state_read(
    window: WebviewWindow,
    app: AppHandle,
) -> Result<Option<String>, NativeError> {
    confine(&window)?;
    let dir = app.path().app_data_dir().map_err(|_| NativeError::state_store())?;
    Ok(read_record(&dir)?)
}

#[tauri::command]
pub fn workspace_state_write(
    window: WebviewWindow,
    app: AppHandle,
    input: WriteInput,
) -> Result<(), NativeError> {
    confine(&window)?;
    let dir = app.path().app_data_dir().map_err(|_| NativeError::state_store())?;
    Ok(write_record(&dir, &input.document)?)
}

#[cfg(test)]
mod tests {
    use super::{read_record, write_record, StateError, FILE_NAME, MAX_BYTES, TEMP_NAME};
    use std::{fs, path::PathBuf};

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hf-workspace-state-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn a_record_written_is_the_record_read_back() {
        let dir = scratch("roundtrip");
        assert_eq!(read_record(&dir), Ok(None), "no record yet is not an error");
        write_record(&dir, r#"{"version":1,"revision":3,"activeId":"native:http://127.0.0.1:7780","profiles":[]}"#).unwrap();
        assert_eq!(
            read_record(&dir).unwrap().as_deref(),
            Some(r#"{"version":1,"revision":3,"activeId":"native:http://127.0.0.1:7780","profiles":[]}"#)
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_second_write_replaces_the_first_and_leaves_no_temp_file() {
        let dir = scratch("replace");
        write_record(&dir, r#"{"revision":1}"#).unwrap();
        write_record(&dir, r#"{"revision":2}"#).unwrap();
        assert_eq!(read_record(&dir).unwrap().as_deref(), Some(r#"{"revision":2}"#));
        assert!(!dir.join(TEMP_NAME).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_record_that_is_not_a_json_object_is_refused_and_the_old_one_stays() {
        let dir = scratch("refuse");
        write_record(&dir, r#"{"revision":1}"#).unwrap();
        assert_eq!(write_record(&dir, "not json"), Err(StateError::NotJson));
        assert_eq!(write_record(&dir, "[1]"), Err(StateError::NotJson));
        assert_eq!(read_record(&dir).unwrap().as_deref(), Some(r#"{"revision":1}"#));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_oversized_record_is_refused_on_write_and_on_read() {
        let dir = scratch("large");
        let huge = format!(r#"{{"pad":"{}"}}"#, "x".repeat(MAX_BYTES));
        assert_eq!(write_record(&dir, &huge), Err(StateError::TooLarge));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(FILE_NAME), &huge).unwrap();
        assert_eq!(read_record(&dir), Err(StateError::TooLarge));
        let _ = fs::remove_dir_all(&dir);
    }
}
