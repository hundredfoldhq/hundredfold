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
    cues::render_loop,
    diag_debug, diag_info, diag_warn,
    protocol::{Mode, Onset},
    session::{Action, Input, NativeState, Session, READY_TIMEOUT_MS},
};
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, ipc::InvokeResponseBody, Runtime, State, WebviewWindow};
use tokio::sync::{
    mpsc::{self, error::TrySendError},
    oneshot,
};

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
/// How long `voice_stop` waits for the session to finish ending.
const STOP_WAIT: Duration = Duration::from_secs(3);
/// How often the session's running counts are logged.
const STATS_EVERY: Duration = Duration::from_secs(10);
/// A gap this long between gateway frames is worth a warning: the gateway sends a keepalive well inside it.
const GATEWAY_SILENCE_WARN: Duration = Duration::from_secs(15);

/// What the session asks of the platform's audio code.
#[derive(Clone, Debug, PartialEq)]
pub enum PlatformCommand {
    ConfigureOnset(Onset),
    Play {
        segment_id: u32,
        pcm: Vec<u8>,
    },
    SegmentEnd(u32),
    Flush,
    Pause,
    Resume,
    /// Loop this PCM16LE mono 24 kHz buffer as a sound cue, on a channel of its own beside the speech
    /// player (never through it, so it cannot arm the onset detector); `None` stops the cue.
    Cue(Option<Vec<u8>>),
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
    crate::ios::install_log_sink();
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
/// Capture blocks handed over by the platform, their bytes, and those dropped because the session
/// was not keeping up. Plain counters: the capture thread does no formatting for them.
static CAPTURE_BLOCKS: AtomicU64 = AtomicU64::new(0);
static CAPTURE_BYTES: AtomicU64 = AtomicU64::new(0);
static CAPTURE_DROPPED: AtomicU64 = AtomicU64::new(0);

/// Captured audio from the platform. Called on the capture thread; never
/// blocks.
#[cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(dead_code))]
pub fn platform_capture(bytes: &[u8]) {
    CAPTURE_BLOCKS.fetch_add(1, Ordering::Relaxed);
    CAPTURE_BYTES.fetch_add(bytes.len() as u64, Ordering::Relaxed);
    if let Ok(active) = ACTIVE.lock() {
        if let Some(active) = active.as_ref() {
            if let Err(TrySendError::Full(_)) = active.capture.try_send(bytes.to_vec()) {
                let dropped = CAPTURE_DROPPED.fetch_add(1, Ordering::Relaxed) + 1;
                // Powers of two only: a stuck session would otherwise log 50 lines a second.
                if dropped.is_power_of_two() {
                    diag_warn!(
                        "event=capture_queue_full run={} dropped_total={dropped} queue_frames={CAPTURE_QUEUE_FRAMES}",
                        active.id
                    );
                }
            }
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
    let started_at = Instant::now();
    let mode = Mode::parse(&input.mode).ok_or_else(NativeError::invalid_request)?;
    let path = voice_path(&input.session_id).ok_or_else(NativeError::invalid_path)?;
    let origin = CanonicalOrigin::parse(&input.target.origin)?;
    let platform = platform().ok_or_else(NativeError::unsupported)?;
    if state.credentials.get(&origin)?.is_none() {
        return Err(NativeError::not_paired());
    }

    // Reserve the single session slot before touching the platform.
    let (control_tx, control_rx) = mpsc::unbounded_channel();
    // This session's own handle, for ending it if the connect fails; the global
    // slot may already belong to a later session by then.
    let own_control = control_tx.clone();
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
            diag_warn!(
                "event=voice_start_refused run={id} session_id={} reason=busy active_run={}",
                input.session_id,
                active.as_ref().map_or(0, |a| a.id)
            );
            return Err(NativeError::voice_busy());
        }
        *active = Some(Active {
            id,
            control: control_tx.clone(),
            capture: capture_tx,
            status: status.clone(),
        });
    }
    diag_info!(
        "event=voice_start run={id} session_id={} mode={:?}",
        input.session_id,
        mode
    );
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
    diag_info!(
        "event=voice_permissions run={id} granted={} ms={}",
        matches!(permitted, Ok(Ok(()))),
        started_at.elapsed().as_millis()
    );
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
        Ok(Ok(())) => diag_info!(
            "event=platform_started run={id} ms={}",
            started_at.elapsed().as_millis()
        ),
        Ok(Err(error)) => {
            diag_warn!(
                "event=platform_start_failed run={id} code={} ms={}",
                error.code,
                started_at.elapsed().as_millis()
            );
            // The service may still come up late; make sure nothing is left running.
            platform.stop();
            release();
            return Err(error);
        }
        Err(_) => {
            diag_warn!("event=platform_start_failed run={id} code=join_error");
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
            diag_warn!("event=socket_open_failed run={id} code={}", error.code);
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
        Ok(Ok(true)) => {
            diag_info!(
                "event=voice_connected run={id} ms={}",
                started_at.elapsed().as_millis()
            );
            Ok(VoiceAck { ok: true })
        }
        outcome => {
            diag_warn!(
                "event=voice_connect_failed run={id} timed_out={} ms={}",
                outcome.is_err(),
                started_at.elapsed().as_millis()
            );
            let _ = own_control.send(Input::Stop {
                reason: "connect_failed".into(),
            });
            Err(NativeError::transport())
        }
    }
}

#[tauri::command]
pub async fn voice_stop<R: Runtime>(window: WebviewWindow<R>) -> Result<VoiceAck, NativeError> {
    confine(&window)?;
    let status = ACTIVE
        .lock()
        .ok()
        .and_then(|active| active.as_ref().map(|a| a.status.clone()));
    diag_info!(
        "event=voice_stop_command running={}",
        status.as_ref().is_some_and(|s| lock_status(s).running)
    );
    platform_event(Input::Stop {
        reason: "user".into(),
    });
    // Return once the session has ended, so a start in the same tick is not refused
    // as busy. Bounded: the stop is already on its way if the session is slow to end.
    if let Some(status) = status {
        let deadline = tokio::time::Instant::now() + STOP_WAIT;
        while lock_status(&status).running && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
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
    session.set_run_id(id);
    let clock = Instant::now();
    let mut platform_stopped = false;
    let mut last_gateway_rx = Instant::now();
    let mut last_stats = (Instant::now(), 0u64, 0u64);
    let mut play_commands = 0u64;
    // Set when the socket opens, cleared once `ready` has arrived (or the session ended).
    let mut ready_deadline: Option<tokio::time::Instant> = None;
    let mut pending = session.begin();
    loop {
        for action in pending.drain(..) {
            match action {
                Action::SendText(text) => {
                    // Client frames carry only ids and numbers, never speech.
                    diag_debug!(
                        "event=client_frame run={id} chars={} frame={text}",
                        text.chars().count()
                    );
                    if sender.send(OutgoingFrame::Text(text)).is_err() {
                        diag_warn!("event=client_frame_not_sent run={id} reason=socket_task_gone");
                    }
                }
                Action::SendBinary(bytes) => {
                    let _ = sender.send(OutgoingFrame::Binary(bytes));
                }
                Action::Forward(json) => {
                    let _ = web.send(InvokeResponseBody::Json(json));
                }
                Action::State(event) => {
                    diag_info!(
                        "event=native_state run={id} state={} reason={:?} code={}",
                        event.state.as_str(),
                        event.reason.as_deref().unwrap_or(""),
                        event.code.map_or(-1, i32::from)
                    );
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
                    play_commands += 1;
                    diag_debug!(
                        "event=platform_play run={id} segment_id={segment_id} bytes={} count={play_commands}",
                        pcm.len()
                    );
                    platform.command(PlatformCommand::Play { segment_id, pcm })
                }
                Action::SegmentEnd(segment) => {
                    diag_debug!("event=platform_segment_end run={id} segment_id={segment}");
                    platform.command(PlatformCommand::SegmentEnd(segment))
                }
                Action::SetCue(request) => {
                    diag_debug!(
                        "event=platform_cue run={id} cue={:?}",
                        request.as_ref().map(|request| request.cue)
                    );
                    platform.command(PlatformCommand::Cue(
                        request.map(|request| render_loop(request.cue, request.volume)),
                    ))
                }
                Action::FlushPlayback => {
                    diag_info!("event=platform_flush run={id} cause=gateway_stop_playback");
                    platform.command(PlatformCommand::Flush)
                }
                Action::PausePlayback => {
                    diag_info!("event=platform_pause run={id}");
                    platform.command(PlatformCommand::Pause)
                }
                Action::ResumePlayback => {
                    diag_info!("event=platform_resume run={id}");
                    platform.command(PlatformCommand::Resume)
                }
                Action::CloseSocket => {
                    let _ = sender.send(OutgoingFrame::Close);
                }
                Action::StopPlatform => {
                    if !platform_stopped {
                        platform_stopped = true;
                        diag_info!("event=platform_stop run={id}");
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
        if matches!(input, Input::GatewayText(_) | Input::GatewayBinary(_)) {
            let silent = last_gateway_rx.elapsed();
            if silent >= GATEWAY_SILENCE_WARN {
                diag_warn!(
                    "event=gateway_silence run={id} ms={} t_ms={}",
                    silent.as_millis(),
                    clock.elapsed().as_millis()
                );
            }
            last_gateway_rx = Instant::now();
        }
        if last_stats.0.elapsed() >= STATS_EVERY {
            let blocks = CAPTURE_BLOCKS.load(Ordering::Relaxed);
            let bytes = CAPTURE_BYTES.load(Ordering::Relaxed);
            let totals = session.totals();
            diag_info!(
                "event=stats run={id} t_ms={} state={} capture_blocks={} capture_bytes={} capture_dropped_total={} up_frames={} up_discarded_bytes={} down_frames={} down_bytes={} down_dropped={} down_invalid={} seq_gaps={} gateway_idle_ms={}",
                clock.elapsed().as_millis(),
                session.state().as_str(),
                blocks - last_stats.1,
                bytes - last_stats.2,
                CAPTURE_DROPPED.load(Ordering::Relaxed),
                totals.up_frames,
                totals.up_discarded_bytes,
                totals.down_frames,
                totals.down_bytes,
                totals.down_dropped,
                totals.down_invalid,
                totals.seq_gaps,
                last_gateway_rx.elapsed().as_millis()
            );
            last_stats = (Instant::now(), blocks, bytes);
        }
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
    diag_info!(
        "event=run_session_end run={id} t_ms={} capture_dropped_total={}",
        clock.elapsed().as_millis(),
        CAPTURE_DROPPED.load(Ordering::Relaxed)
    );
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
