//! Android half of native voice: a JNI bridge to the Kotlin audio code in
//! `gen/android/.../voice/`.
//!
//! Kotlin registers its `VoiceBridge` object once at startup
//! ([`Java_run_hundredfold_shell_voice_VoiceNative_nativeRegister`]). Rust calls
//! the bridge to start the foreground service and to hand it audio to play;
//! Kotlin calls the `native*` functions below with captured audio and events.
//! Audio frames cross as byte arrays, never through JSON or the WebView.

use hundredfold_voice_core::{
    protocol::{Mode, Onset},
    session::Input,
};
use jni::{
    objects::{GlobalRef, JByteArray, JClass, JObject, JString, JValue},
    sys::{jboolean, jint, jlong, JNI_TRUE},
    JNIEnv, JavaVM,
};
use std::{
    sync::{Arc, Condvar, Mutex},
    time::Duration,
};

use crate::{
    commands::NativeError,
    voice::{platform_capture, platform_event, AudioPlatform, PlatformCommand},
};

/// Time allowed for the user to answer the permission prompts.
const PERMISSION_TIMEOUT: Duration = Duration::from_secs(120);

struct Bridge {
    vm: JavaVM,
    object: GlobalRef,
}

/// The activity's bridge. A recreated activity registers a new one, so the latest
/// registration wins and a destroyed activity's bridge is never called.
static BRIDGE: Mutex<Option<Arc<Bridge>>> = Mutex::new(None);
static PERMISSION: (Mutex<Option<bool>>, Condvar) = (Mutex::new(None), Condvar::new());

fn bridge() -> Option<Arc<Bridge>> {
    BRIDGE.lock().ok()?.clone()
}

pub fn platform() -> Option<Arc<dyn AudioPlatform>> {
    bridge().map(|_| Arc::new(AndroidPlatform) as Arc<dyn AudioPlatform>)
}

struct AndroidPlatform;

impl AndroidPlatform {
    /// Calls a method on the Kotlin bridge. Rust worker threads attach to the
    /// JVM permanently, so the audio path pays for that once.
    fn call(&self, name: &str, signature: &str, args: &[JValue]) -> Result<(), NativeError> {
        let bridge = bridge().ok_or_else(NativeError::unsupported)?;
        let mut env = bridge
            .vm
            .attach_current_thread_permanently()
            .map_err(|_| NativeError::transport())?;
        let result = env.call_method(&bridge.object, name, signature, args);
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
            return Err(NativeError::transport());
        }
        result.map(|_| ()).map_err(|_| NativeError::transport())
    }

    fn play(&self, segment_id: u32, pcm: &[u8]) -> Result<(), NativeError> {
        let bridge = bridge().ok_or_else(NativeError::unsupported)?;
        let mut env = bridge
            .vm
            .attach_current_thread_permanently()
            .map_err(|_| NativeError::transport())?;
        let array = env
            .byte_array_from_slice(pcm)
            .map_err(|_| NativeError::transport())?;
        let result = env.call_method(
            &bridge.object,
            "play",
            "(I[B)V",
            &[JValue::Int(segment_id as jint), JValue::Object(&array)],
        );
        let _ = env.delete_local_ref(array);
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
            return Err(NativeError::transport());
        }
        result.map(|_| ()).map_err(|_| NativeError::transport())
    }
}

impl AudioPlatform for AndroidPlatform {
    fn request_permissions(&self) -> Result<(), NativeError> {
        let (lock, condvar) = &PERMISSION;
        *lock.lock().map_err(|_| NativeError::transport())? = None;
        self.call("requestPermissions", "()V", &[])?;
        let guard = lock.lock().map_err(|_| NativeError::transport())?;
        let (guard, _) = condvar
            .wait_timeout_while(guard, PERMISSION_TIMEOUT, |answer| answer.is_none())
            .map_err(|_| NativeError::transport())?;
        match *guard {
            Some(true) => Ok(()),
            _ => Err(NativeError::permission_denied()),
        }
    }

    fn start(&self, mode: Mode) -> Result<(), NativeError> {
        self.call(
            "start",
            "(Z)V",
            &[JValue::Bool(u8::from(mode == Mode::HandsFree))],
        )
    }

    fn command(&self, command: PlatformCommand) {
        let _ = match command {
            PlatformCommand::ConfigureOnset(Onset {
                threshold,
                min_speech_ms,
            }) => self.call(
                "configureOnset",
                "(FI)V",
                &[JValue::Float(threshold), JValue::Int(min_speech_ms as jint)],
            ),
            PlatformCommand::Play { segment_id, pcm } => self.play(segment_id, &pcm),
            PlatformCommand::SegmentEnd(segment) => {
                self.call("segmentEnd", "(I)V", &[JValue::Int(segment as jint)])
            }
            PlatformCommand::Flush => self.call("flush", "()V", &[]),
            PlatformCommand::Pause => self.call("pause", "()V", &[]),
            PlatformCommand::Resume => self.call("resume", "()V", &[]),
        };
    }

    fn stop(&self) {
        let _ = self.call("stop", "()V", &[]);
    }
}

// ── Kotlin → Rust (`run.hundredfold.shell.voice.VoiceNative`) ────────────────

#[no_mangle]
pub extern "system" fn Java_run_hundredfold_shell_voice_VoiceNative_nativeRegister(
    env: JNIEnv,
    _class: JClass,
    bridge: JObject,
) {
    if let (Ok(vm), Ok(object)) = (env.get_java_vm(), env.new_global_ref(&bridge)) {
        if let Ok(mut current) = BRIDGE.lock() {
            *current = Some(Arc::new(Bridge { vm, object }));
        }
    }
}

#[no_mangle]
pub extern "system" fn Java_run_hundredfold_shell_voice_VoiceNative_nativeCapture(
    env: JNIEnv,
    _class: JClass,
    frame: JByteArray,
    length: jint,
) {
    let length = usize::try_from(length).unwrap_or(0);
    if length == 0 || length > 16 * 1024 {
        return;
    }
    let mut bytes = vec![0i8; length];
    if env.get_byte_array_region(&frame, 0, &mut bytes).is_err() {
        return;
    }
    // SAFETY: i8 and u8 have the same size and alignment.
    let bytes: &[u8] = unsafe { std::slice::from_raw_parts(bytes.as_ptr().cast(), bytes.len()) };
    platform_capture(bytes);
}

#[no_mangle]
pub extern "system" fn Java_run_hundredfold_shell_voice_VoiceNative_nativeOnset(
    _env: JNIEnv,
    _class: JClass,
    segment_id: jlong,
    played_ms: jlong,
) {
    platform_event(Input::Onset {
        segment_id: u32::try_from(segment_id).ok(),
        played_ms: u64::try_from(played_ms).unwrap_or(0),
    });
}

#[no_mangle]
pub extern "system" fn Java_run_hundredfold_shell_voice_VoiceNative_nativePlayed(
    _env: JNIEnv,
    _class: JClass,
    segment_id: jlong,
) {
    if let Ok(segment_id) = u32::try_from(segment_id) {
        platform_event(Input::SegmentPlayed(segment_id));
    }
}

#[no_mangle]
pub extern "system" fn Java_run_hundredfold_shell_voice_VoiceNative_nativeStopRequested(
    mut env: JNIEnv,
    _class: JClass,
    reason: JString,
) {
    let reason = env
        .get_string(&reason)
        .map(String::from)
        .unwrap_or_else(|_| "notification".into());
    platform_event(Input::Stop { reason });
}

#[no_mangle]
pub extern "system" fn Java_run_hundredfold_shell_voice_VoiceNative_nativeInterruption(
    _env: JNIEnv,
    _class: JClass,
    began: jboolean,
    suspended_ms: jlong,
) {
    platform_event(if began == JNI_TRUE {
        Input::InterruptionBegan
    } else {
        Input::InterruptionEnded {
            suspended_ms: u64::try_from(suspended_ms).unwrap_or(0),
        }
    });
}

#[no_mangle]
pub extern "system" fn Java_run_hundredfold_shell_voice_VoiceNative_nativePermissionResult(
    _env: JNIEnv,
    _class: JClass,
    granted: jboolean,
) {
    let (lock, condvar) = &PERMISSION;
    if let Ok(mut answer) = lock.lock() {
        *answer = Some(granted == JNI_TRUE);
        condvar.notify_all();
    }
}
