//! iOS half of native voice: C-ABI glue to the Swift audio code in
//! `gen/apple/Sources/hundredfold-shell/voice/`.
//!
//! Swift implements the `hf_voice_*` functions with `@_cdecl` and calls the
//! `hf_voice_on_*` functions below with captured audio and events. Both live in
//! the same app binary, so there is no bridge object to register.
//!
//! This file is written to contracts/native-voice.md and has only been checked
//! against the contract: it needs a Mac with Xcode and an Apple team to build
//! and run.

use hundredfold_voice_core::{
    protocol::{Mode, Onset},
    session::Input,
};
use std::ffi::{c_char, CStr};

use crate::{
    commands::NativeError,
    voice::{platform_capture, platform_event, AudioPlatform, PlatformCommand},
};

extern "C" {
    /// Asks for microphone access and blocks until answered. Returns true when
    /// granted.
    fn hf_voice_request_permissions() -> bool;
    /// Configures `AVAudioSession`, starts capture and playback. Returns false
    /// when the session could not be activated.
    fn hf_voice_start(hands_free: bool) -> bool;
    fn hf_voice_configure_onset(threshold: f32, min_speech_ms: u32);
    fn hf_voice_play(segment_id: u32, pcm: *const u8, length: usize);
    fn hf_voice_segment_end(segment_id: u32);
    fn hf_voice_flush();
    fn hf_voice_pause();
    fn hf_voice_resume();
    fn hf_voice_stop();
}

pub struct IosPlatform;

impl AudioPlatform for IosPlatform {
    fn request_permissions(&self) -> Result<(), NativeError> {
        // SAFETY: plain call into the Swift implementation; no pointers.
        if unsafe { hf_voice_request_permissions() } {
            Ok(())
        } else {
            Err(NativeError::permission_denied())
        }
    }

    fn start(&self, mode: Mode) -> Result<(), NativeError> {
        // SAFETY: plain call into the Swift implementation; no pointers.
        if unsafe { hf_voice_start(mode == Mode::HandsFree) } {
            Ok(())
        } else {
            Err(NativeError::transport())
        }
    }

    fn command(&self, command: PlatformCommand) {
        // SAFETY: the pointer passed to `hf_voice_play` is valid for `length`
        // bytes for the duration of the call; Swift copies it before returning.
        unsafe {
            match command {
                PlatformCommand::ConfigureOnset(Onset {
                    threshold,
                    min_speech_ms,
                }) => hf_voice_configure_onset(threshold, min_speech_ms),
                PlatformCommand::Play { segment_id, pcm } => {
                    hf_voice_play(segment_id, pcm.as_ptr(), pcm.len())
                }
                PlatformCommand::SegmentEnd(segment) => hf_voice_segment_end(segment),
                PlatformCommand::Flush => hf_voice_flush(),
                PlatformCommand::Pause => hf_voice_pause(),
                PlatformCommand::Resume => hf_voice_resume(),
            }
        }
    }

    fn stop(&self) {
        // SAFETY: plain call into the Swift implementation; no pointers.
        unsafe { hf_voice_stop() }
    }
}

// ── Swift → Rust ─────────────────────────────────────────────────────────────

/// PCM16LE mono at 16 kHz, any length; the session re-slices it into 20 ms frames.
///
/// # Safety
/// `bytes` must point to `length` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn hf_voice_on_capture(bytes: *const u8, length: usize) {
    if bytes.is_null() || length == 0 || length > 64 * 1024 {
        return;
    }
    platform_capture(std::slice::from_raw_parts(bytes, length));
}

/// The onset detector fired over playback and playback has stopped. A negative
/// `segment_id` means no segment was playing.
#[no_mangle]
pub extern "C" fn hf_voice_on_onset(segment_id: i64, played_ms: i64) {
    platform_event(Input::Onset {
        segment_id: u32::try_from(segment_id).ok(),
        played_ms: u64::try_from(played_ms).unwrap_or(0),
    });
}

#[no_mangle]
pub extern "C" fn hf_voice_on_played(segment_id: u32) {
    platform_event(Input::SegmentPlayed(segment_id));
}

/// Stop from the lock screen or Control Center. `reason` is a NUL-terminated
/// UTF-8 string, or null.
///
/// # Safety
/// `reason` must be null or a valid NUL-terminated string.
#[no_mangle]
pub unsafe extern "C" fn hf_voice_on_stop(reason: *const c_char) {
    let reason = if reason.is_null() {
        "lock_screen".to_owned()
    } else {
        CStr::from_ptr(reason).to_string_lossy().into_owned()
    };
    platform_event(Input::Stop { reason });
}

/// `AVAudioSession` interruption began (`began` true) or ended.
#[no_mangle]
pub extern "C" fn hf_voice_on_interruption(began: bool, suspended_ms: u64) {
    platform_event(if began {
        Input::InterruptionBegan
    } else {
        Input::InterruptionEnded { suspended_ms }
    });
}
