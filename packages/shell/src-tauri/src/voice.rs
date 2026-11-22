//! The native voice session (contracts/native-voice.md).
//!
//! Voice mode must keep working with the screen locked, and a backgrounded
//! WebView may suspend JavaScript, so while it runs the whole loop is native:
//! platform audio (Kotlin on Android, Swift on iOS) captures and plays, this
//! module owns the gateway socket through the `stream` machinery, and the two
//! are joined by [`hundredfold_voice_core::session::Session`]. Binary audio
//! never reaches JavaScript. The WebView only sends the four commands below and
//! receives the gateway's JSON frames (plus `native_state` frames about the
//! native session itself) on a channel; if it is suspended or gone, the session
//! carries on.

use hundredfold_voice_core::{
    protocol::{Mode, Onset},
    session::{Action, Input, NativeState, Session, READY_TIMEOUT_MS},
};
use serde::{Deserialize, Serialize};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, ipc::InvokeResponseBody, Runtime, State, WebviewWindow};
use tokio::sync::{mpsc, oneshot};

use crate::{
    commands::{confine, NativeError, NativeState as ShellState},
    origin::{CanonicalOrigin, GatewayTarget},
    stream::{open_gateway_stream, OutgoingFrame, SocketSink},
};

/// Up-frames queued between the platform's capture thread and the session. At
/// 50 frames a second this is about five seconds; older audio is worthless to
/// a live conversation, so a full queue drops the newest frame.
const CAPTURE_QUEUE_FRAMES: usize = 256;
/// How long `voice_start` waits for the gateway socket to connect.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// What the session asks of the platform's audio code.
#[derive(Clone, Debug, PartialEq)]
pub enum PlatformCommand {
    ConfigureOnset(Onset),
    Play { segment_id: u32, pcm: Vec<u8> },
    SegmentEnd(u32),
    Flush,
    Pause,
    Resume,
}

/// The platform half of native voice. Android implements it over JNI, iOS over
/// C-ABI functions exported by Swift. Platform code reports back through
/// [`platform_capture`] and [`platform_event`].
pub trait AudioPlatform: Send + Sync + 'static {
    /// Ask for microphone (and notification) access. Blocks until answered.
    fn request_permissions(&self) -> Result<(), NativeError>;
    /// Start the audio session (Android: the foreground service). Capture runs
    /// from here on; frames are dropped by the session until the gateway is
    /// ready.
    fn start(&self, mode: Mode) -> Result<(), NativeError>;
    fn command(&self, command: PlatformCommand);
    fn stop(&self);
}

#[cfg(target_os = "android")]
fn platform() -> Option<Arc<dyn AudioPlatform>> {
    crate::android::platform()
}

#[cfg(target_os = "ios")]
fn platform() -> Option<Arc<dyn AudioPlatform>> {
    Some(Arc::new(crate::ios::IosPlatform))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn platform() -> Option<Arc<dyn AudioPlatform>> {
    None
}

#[derive(Clone, Copy)]
struct Status {
    running: bool,
    state: &'static str,
}

struct Active {
    id: u64,
    control: mpsc::UnboundedSender<Input>,
    #[cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(dead_code))]
    capture: mpsc::Sender<Vec<u8>>,
    status: Arc<Mutex<Status>>,
}

/// The one running session, reachable from platform callbacks that have no
/// access to Tauri state.
static ACTIVE: Mutex<Option<Active>> = Mutex::new(None);
static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Captured audio from the platform. Called on the capture thread; never
/// blocks.
#[cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(dead_code))]
pub fn platform_capture(bytes: &[u8]) {
    if let Ok(active) = ACTIVE.lock() {
        if let Some(active) = active.as_ref() {
            let _ = active.capture.try_send(bytes.to_vec());
        }
    }
}

/// An event from platform audio: an onset, a segment that finished playing, a
/// Stop from the notification or lock screen, or an audio interruption.
pub fn platform_event(input: Input) {
    if let Ok(active) = ACTIVE.lock() {
        if let Some(active) = active.as_ref() {
            let _ = active.control.send(input);
        }
    }
}

struct VoiceSink(mpsc::UnboundedSender<Input>);

impl SocketSink for VoiceSink {
    fn opened(&self, _: &str) -> bool {
        self.0.send(Input::SocketOpened).is_ok()
    }
    fn text(&self, _: &str, text: String) -> bool {
        self.0.send(Input::GatewayText(text)).is_ok()
    }
    fn binary(&self, _: &str, bytes: Vec<u8>) -> bool {
        self.0.send(Input::GatewayBinary(bytes)).is_ok()
    }
    fn closed(&self, _: &str, code: Option<u16>, reason: String) {
        let _ = self.0.send(Input::SocketClosed { code, reason });
    }
    fn failed(&self, _: &str) {
        let _ = self.0.send(Input::SocketClosed {
            code: None,
            reason: String::new(),
        });
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStartInput {
    pub target: GatewayTarget,
    pub session_id: String,
    pub mode: String,
}

#[derive(Deserialize)]
pub struct VoicePttInput {
    pub down: bool,
}

#[derive(Debug, Serialize)]
pub struct VoiceAck {
    pub ok: bool,
}

#[derive(Debug, Serialize)]
pub struct VoiceStatus {
    pub running: bool,
    pub state: &'static str,
}

fn valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        && id != "."
        && id != ".."
}

/// The gateway path for a voice session, or `None` for an id that is not a
/// plain identifier.
pub fn voice_path(session_id: &str) -> Option<String> {
    valid_session_id(session_id).then(|| format!("/ws/voice/{session_id}"))
}

fn lock_status(status: &Mutex<Status>) -> Status {
    status.lock().map(|s| *s).unwrap_or(Status {
        running: false,
        state: "idle",
    })
}

#[tauri::command]
pub async fn voice_start<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, ShellState>,
    input: VoiceStartInput,
    on_event: Channel<InvokeResponseBody>,
) -> Result<VoiceAck, NativeError> {
    confine(&window)?;
    let mode = Mode::parse(&input.mode).ok_or_else(NativeError::invalid_request)?;
    let path = voice_path(&input.session_id).ok_or_else(NativeError::invalid_path)?;
    let origin = CanonicalOrigin::parse(&input.target.origin)?;
    let platform = platform().ok_or_else(NativeError::unsupported)?;
    if state.credentials.get(&origin)?.is_none() {
        return Err(NativeError::not_paired());
    }

    // Reserve the single session slot before touching the platform.
    let (control_tx, control_rx) = mpsc::unbounded_channel();
    let (capture_tx, capture_rx) = mpsc::channel(CAPTURE_QUEUE_FRAMES);
    let status = Arc::new(Mutex::new(Status {
        running: true,
        state: NativeState::Connecting.as_str(),
    }));
    let id = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    {
        let mut active = ACTIVE.lock().map_err(|_| NativeError::transport())?;
        if active
            .as_ref()
            .is_some_and(|a| lock_status(&a.status).running)
        {
            return Err(NativeError::voice_busy());
        }
        *active = Some(Active {
            id,
            control: control_tx.clone(),
            capture: capture_tx,
            status: status.clone(),
        });
    }
    let release = move || {
        if let Ok(mut active) = ACTIVE.lock() {
            if active.as_ref().is_some_and(|a| a.id == id) {
                *active = None;
            }
        }
    };

    let permitted = {
        let platform = platform.clone();
        tauri::async_runtime::spawn_blocking(move || platform.request_permissions()).await
    };
    if !matches!(permitted, Ok(Ok(()))) {
        release();
        return Err(NativeError::permission_denied());
    }
    // Starting the audio session can wait on the OS (Android brings up the
    // foreground service), so it runs off the async workers.
    let started = {
        let platform = platform.clone();
        tauri::async_runtime::spawn_blocking(move || platform.start(mode)).await
    };
    match started {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            // The service may still come up late; make sure nothing is left running.
            platform.stop();
            release();
            return Err(error);
        }
        Err(_) => {
            platform.stop();
            release();
            return Err(NativeError::transport());
        }
    }
    let (_, sender) = match open_gateway_stream(
        &state.credentials,
        &state.streams,
        &input.target,
        &path,
        VoiceSink(control_tx),
    ) {
        Ok(opened) => opened,
        Err(error) => {
            platform.stop();
            release();
            return Err(error);
        }
    };

    let (started_tx, started_rx) = oneshot::channel();
    tauri::async_runtime::spawn(run_session(
        id,
        mode,
        platform.clone(),
        sender,
        control_rx,
        capture_rx,
        on_event,
        status,
        started_tx,
    ));
    match tokio::time::timeout(CONNECT_TIMEOUT, started_rx).await {
        Ok(Ok(true)) => Ok(VoiceAck { ok: true }),
        _ => {
            platform_event(Input::Stop {
                reason: "connect_failed".into(),
            });
            Err(NativeError::transport())
        }
    }
}

#[tauri::command]
pub async fn voice_stop<R: Runtime>(window: WebviewWindow<R>) -> Result<VoiceAck, NativeError> {
    confine(&window)?;
    platform_event(Input::Stop {
        reason: "user".into(),
    });
    Ok(VoiceAck { ok: true })
}

#[tauri::command]
pub async fn voice_ptt<R: Runtime>(
    window: WebviewWindow<R>,
    input: VoicePttInput,
) -> Result<VoiceAck, NativeError> {
    confine(&window)?;
    platform_event(Input::Ptt { down: input.down });
    Ok(VoiceAck { ok: true })
}

#[tauri::command]
pub async fn voice_status<R: Runtime>(
    window: WebviewWindow<R>,
) -> Result<VoiceStatus, NativeError> {
    confine(&window)?;
    let status = ACTIVE
        .lock()
        .ok()
        .and_then(|active| active.as_ref().map(|a| lock_status(&a.status)))
        .unwrap_or(Status {
            running: false,
            state: "idle",
        });
    Ok(VoiceStatus {
        running: status.running,
        state: status.state,
    })
}

#[allow(clippy::too_many_arguments)]
async fn run_session(
    id: u64,
    mode: Mode,
    platform: Arc<dyn AudioPlatform>,
    sender: mpsc::UnboundedSender<OutgoingFrame>,
    mut control: mpsc::UnboundedReceiver<Input>,
    mut capture: mpsc::Receiver<Vec<u8>>,
    web: Channel<InvokeResponseBody>,
    status: Arc<Mutex<Status>>,
    started: oneshot::Sender<bool>,
) {
    let mut started = Some(started);
    let mut session = Session::new(mode);
    let clock = Instant::now();
    let mut platform_stopped = false;
    // Set when the socket opens, cleared once `ready` has arrived (or the session ended).
    let mut ready_deadline: Option<tokio::time::Instant> = None;
    let mut pending = session.begin();
    loop {
        for action in pending.drain(..) {
            match action {
                Action::SendText(text) => {
                    let _ = sender.send(OutgoingFrame::Text(text));
                }
                Action::SendBinary(bytes) => {
                    let _ = sender.send(OutgoingFrame::Binary(bytes));
                }
                Action::Forward(json) => {
                    let _ = web.send(InvokeResponseBody::Json(json));
                }
                Action::State(event) => {
                    if let Ok(mut status) = status.lock() {
                        status.state = event.state.as_str();
                        status.running = event.state != NativeState::Stopped;
                    }
                    let _ = web.send(InvokeResponseBody::Json(event.to_json()));
                }
                Action::ConfigureOnset(onset) => {
                    platform.command(PlatformCommand::ConfigureOnset(onset))
                }
                Action::Play { segment_id, pcm } => {
                    platform.command(PlatformCommand::Play { segment_id, pcm })
                }
                Action::SegmentEnd(segment) => {
                    platform.command(PlatformCommand::SegmentEnd(segment))
                }
                Action::FlushPlayback => platform.command(PlatformCommand::Flush),
                Action::PausePlayback => platform.command(PlatformCommand::Pause),
                Action::ResumePlayback => platform.command(PlatformCommand::Resume),
                Action::CloseSocket => {
                    let _ = sender.send(OutgoingFrame::Close);
                }
                Action::StopPlatform => {
                    if !platform_stopped {
                        platform_stopped = true;
                        platform.stop();
                    }
                }
            }
        }
        if session.is_stopped() {
            break;
        }
        let input = tokio::select! {
            biased;
            _ = async {
                match ready_deadline {
                    Some(deadline) => tokio::time::sleep_until(deadline).await,
                    None => std::future::pending::<()>().await,
                }
            } => {
                ready_deadline = None;
                Input::ReadyTimeout
            }
            input = control.recv() => match input {
                Some(input) => input,
                None => Input::Stop { reason: "closed".into() },
            },
            frame = capture.recv() => match frame {
                Some(frame) => Input::Capture(frame),
                None => continue,
            },
        };
        if let Some(started) =
            started.take_if(|_| matches!(input, Input::SocketOpened | Input::SocketClosed { .. }))
        {
            let _ = started.send(matches!(input, Input::SocketOpened));
        }
        if matches!(input, Input::SocketOpened) {
            ready_deadline =
                Some(tokio::time::Instant::now() + Duration::from_millis(READY_TIMEOUT_MS));
        }
        pending = session.handle(input, clock.elapsed().as_millis() as u64);
        if session.state() != NativeState::Connecting {
            ready_deadline = None;
        }
    }
    if let Some(started) = started.take() {
        let _ = started.send(false);
    }
    if let Ok(mut status) = status.lock() {
        status.running = false;
        status.state = NativeState::Stopped.as_str();
    }
    if let Ok(mut active) = ACTIVE.lock() {
        if active.as_ref().is_some_and(|a| a.id == id) {
            *active = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{valid_session_id, voice_path, voice_ptt, voice_start, voice_status, voice_stop};
    use super::{VoicePttInput, VoiceStartInput};
    use crate::{commands::NativeState, origin::GatewayTarget};
    use tauri::{
        ipc::{Channel, InvokeResponseBody},
        test::{mock_builder, mock_context, noop_assets, MockRuntime},
        Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    };

    #[test]
    fn start_failures_use_the_contracts_kebab_case_codes() {
        use crate::commands::NativeError;
        for (error, code) in [
            (NativeError::permission_denied(), "permission-denied"),
            (NativeError::not_paired(), "not-paired"),
            (NativeError::unsupported(), "unsupported"),
            (NativeError::voice_busy(), "voice-busy"),
            (NativeError::invalid_path(), "invalid-path"),
            (NativeError::invalid_request(), "invalid-request"),
            (NativeError::transport(), "transport-failed"),
        ] {
            assert_eq!(error.code, code);
        }
    }

    #[test]
    fn session_ids_are_plain_identifiers_only() {
        assert!(valid_session_id("0b9d7f4e-2a1c-4e0a-9d52-6c1d1e1f2a3b"));
        assert!(valid_session_id("abc_DEF.123"));
        for bad in [
            "",
            ".",
            "..",
            "a/b",
            "a b",
            "a?x=1",
            "a#b",
            "%2e%2e",
            "é",
            &"a".repeat(129),
        ] {
            assert!(!valid_session_id(bad), "{bad:?}");
            assert!(voice_path(bad).is_none(), "{bad:?}");
        }
        assert_eq!(voice_path("s1").as_deref(), Some("/ws/voice/s1"));
    }

    fn app() -> tauri::App<MockRuntime> {
        let app = mock_builder()
            .build(mock_context(noop_assets()))
            .expect("mock app");
        app.manage(NativeState::new().expect("native state"));
        app
    }

    fn window(app: &tauri::App<MockRuntime>, label: &str, url: &str) -> WebviewWindow<MockRuntime> {
        WebviewWindowBuilder::new(app, label, WebviewUrl::External(url.parse().unwrap()))
            .build()
            .expect("mock window")
    }

    fn start_input() -> VoiceStartInput {
        VoiceStartInput {
            target: GatewayTarget {
                origin: "http://127.0.0.1:7779".into(),
            },
            session_id: "s1".into(),
            mode: "hands-free".into(),
        }
    }

    fn channel() -> Channel<InvokeResponseBody> {
        Channel::new(|_| Ok(()))
    }

    fn denied<T: std::fmt::Debug>(result: Result<T, crate::commands::NativeError>) -> bool {
        matches!(result, Err(error) if error.code == "denied")
    }

    #[test]
    fn every_voice_command_is_confined_to_the_local_main_window() {
        let app = app();
        let remote_main = window(&app, "main", "https://example.com/");
        let local_other = window(&app, "other", "tauri://localhost/");
        for window in [&remote_main, &local_other] {
            tauri::async_runtime::block_on(async {
                assert!(denied(
                    voice_start(
                        window.clone(),
                        app.state::<NativeState>(),
                        start_input(),
                        channel()
                    )
                    .await
                ));
                assert!(denied(voice_stop(window.clone()).await));
                assert!(denied(
                    voice_ptt(window.clone(), VoicePttInput { down: true }).await
                ));
                assert!(denied(voice_status(window.clone()).await));
            });
        }
    }

    #[test]
    fn the_local_main_window_may_ask_for_status_and_stop() {
        let app = app();
        let main = window(&app, "main", "tauri://localhost/");
        tauri::async_runtime::block_on(async {
            let status = voice_status(main.clone()).await.expect("status");
            assert!(!status.running);
            assert_eq!(status.state, "idle");
            // Stopping with nothing running is a no-op, not an error.
            assert!(voice_stop(main.clone()).await.expect("stop").ok);
            assert!(
                voice_ptt(main, VoicePttInput { down: true })
                    .await
                    .expect("ptt")
                    .ok
            );
        });
    }

    #[test]
    fn start_rejects_bad_input_before_touching_the_platform() {
        let app = app();
        let main = window(&app, "main", "tauri://localhost/");
        let code = |input: VoiceStartInput| {
            tauri::async_runtime::block_on(voice_start(
                main.clone(),
                app.state::<NativeState>(),
                input,
                channel(),
            ))
            .map(|_| "ok")
            .map_err(|error| error.code)
            .unwrap_err()
        };
        assert_eq!(
            code(VoiceStartInput {
                mode: "shout".into(),
                ..start_input()
            }),
            "invalid-request"
        );
        assert_eq!(
            code(VoiceStartInput {
                session_id: "../x".into(),
                ..start_input()
            }),
            "invalid-path"
        );
        assert_eq!(
            code(VoiceStartInput {
                target: GatewayTarget {
                    origin: "http://example.com".into()
                },
                ..start_input()
            }),
            "insecure-origin"
        );
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn desktop_has_no_native_voice() {
        let app = app();
        let main = window(&app, "main", "tauri://localhost/");
        let error = tauri::async_runtime::block_on(voice_start(
            main,
            app.state::<NativeState>(),
            start_input(),
            channel(),
        ))
        .unwrap_err();
        assert_eq!(error.code, "unsupported");
    }
}
