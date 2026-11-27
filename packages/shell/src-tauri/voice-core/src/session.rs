//! The native voice session as a pure state machine.
//!
//! The Tauri layer feeds [`Input`]s in (gateway frames, captured audio, events
//! from the platform audio code) and carries out the returned [`Action`]s. Nothing
//! here touches a socket, a clock or an audio API, so every rule below is
//! covered by a unit test.
//!
//! The gateway owns voice activity detection and the turn logic; the client
//! captures, sends, plays, and stops playing on its own onset or on
//! `stop_playback` (contracts/native-voice.md).

use std::collections::{HashMap, HashSet};

use crate::{
    audio::{parse_down_frame, FrameChunker},
    cues::{wanted, Cue, CueInputs, CueRequest, CueSettings, Turn},
    diag_debug, diag_info, diag_warn,
    protocol::{ClientFrame, GatewayFrame, Mode, Onset, OUTPUT_SAMPLE_RATE, PROTOCOL_VERSION},
};

/// After an interruption, audio and segment announcements that were already in
/// flight when it happened keep arriving for about one round trip. Anything
/// newer than the interrupted reply that shows up inside this window is part of
/// it and is dropped too.
pub const INTERRUPT_GUARD_MS: u64 = 400;

/// How long the gateway has, after the socket opens, to answer `hello` with `ready`.
pub const READY_TIMEOUT_MS: u64 = 10_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    AwaitingSocket,
    AwaitingReady,
    Running,
    Stopped,
}

/// What the web UI is told about the native session itself, next to the
/// gateway's own frames.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeState {
    Connecting,
    Running,
    Paused,
    Stopped,
}

impl NativeState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Connecting => "connecting",
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Stopped => "stopped",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StateEvent {
    pub state: NativeState,
    pub reason: Option<String>,
    /// The WebSocket close code, only with the `socket_closed` reason, so the web
    /// can say why (in use by someone else, attachment limit, access lost, ...).
    pub code: Option<u16>,
}

impl StateEvent {
    /// `{"type":"native_state","state":...,"reason"?:...}` as specified in
    /// contracts/native-voice.md. Gateways never emit this type, so it cannot be
    /// confused with a forwarded gateway frame.
    pub fn to_json(&self) -> String {
        let mut value = serde_json::json!({
            "type": "native_state",
            "state": self.state.as_str(),
        });
        if let Some(reason) = &self.reason {
            value["reason"] = serde_json::Value::String(reason.clone());
        }
        if let Some(code) = self.code {
            value["code"] = serde_json::Value::from(code);
        }
        value.to_string()
    }
}

/// The `reason` values of a `native_state` frame (contracts/native-voice.md).
pub mod reason {
    /// Voice mode was turned off from the app.
    pub const USER: &str = "user";
    /// Stop from the lock screen or the notification.
    pub const NOTIFICATION: &str = "notification";
    /// A system interruption (a call, Siri, another app) paused voice mode.
    pub const INTERRUPTION: &str = "interruption";
    /// The session could not start or had to end: no connection, an audio format
    /// the client does not speak.
    pub const ERROR: &str = "error";
    /// The gateway closed the socket, or the connection was lost.
    pub const SOCKET_CLOSED: &str = "socket_closed";

    /// Maps what the platform says caused a stop onto the contract's values.
    pub fn of_stop(requested: &str) -> &'static str {
        match requested {
            "user" => USER,
            "notification" | "lock_screen" => NOTIFICATION,
            // Another app took the audio for good, or the system ended an interruption
            // without letting the session resume: not a failure.
            "focus_lost" | "interruption" => INTERRUPTION,
            // The task was swiped away from recents: the user ended it.
            "task_removed" => USER,
            _ => ERROR,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Input {
    /// The socket connected.
    SocketOpened,
    /// The socket closed, or never connected.
    SocketClosed {
        code: Option<u16>,
        reason: String,
    },
    GatewayText(String),
    GatewayBinary(Vec<u8>),
    /// Captured PCM16LE mono at 16 kHz, any length.
    Capture(Vec<u8>),
    /// The platform's onset detector fired and playback is already stopped.
    Onset {
        segment_id: Option<u32>,
        played_ms: u64,
    },
    /// A segment finished playing in full.
    SegmentPlayed(u32),
    Ptt {
        down: bool,
    },
    /// The user (or the system) asked to end voice mode.
    Stop {
        reason: String,
    },
    /// The gateway did not send `ready` in time after the socket opened.
    ReadyTimeout,
    /// A phone call, Siri or another app took the audio.
    InterruptionBegan,
    InterruptionEnded {
        suspended_ms: u64,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    SendText(String),
    SendBinary(Vec<u8>),
    /// A gateway JSON frame, unchanged, for the web UI.
    Forward(String),
    State(StateEvent),
    ConfigureOnset(Onset),
    Play {
        segment_id: u32,
        pcm: Vec<u8>,
    },
    /// The gateway's last audio frame for the segment has been handed over.
    SegmentEnd(u32),
    FlushPlayback,
    /// Play this cue on its own channel, looping, until the next `SetCue`; `None` stops it. The
    /// session only asks when the cue changes. Never routed through the speech player.
    SetCue(Option<CueRequest>),
    PausePlayback,
    ResumePlayback,
    CloseSocket,
    StopPlatform,
}

/// Running counts for the diagnostic log; they never influence a decision.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Totals {
    pub down_frames: u64,
    pub down_bytes: u64,
    /// Binary frames that did not parse.
    pub down_invalid: u64,
    /// Audio frames thrown away by the interruption rules.
    pub down_dropped: u64,
    /// Times `seq` skipped ahead, and how many frames that skipped in all.
    pub seq_gaps: u64,
    pub seq_missing: u64,
    pub up_frames: u64,
    /// Capture bytes discarded because the session was not sending (not ready, paused, push-to-talk up).
    pub up_discarded_bytes: u64,
    pub barge_ins: u64,
    pub stop_playbacks: u64,
}

/// What arrived for one segment, for the per-segment summary lines.
#[derive(Default)]
struct SegStats {
    announced_ms: Option<u64>,
    first_frame_ms: Option<u64>,
    last_frame_ms: u64,
    max_gap_ms: u64,
    frames: u32,
    bytes: u64,
    dropped: u32,
}

impl SegStats {
    fn audio_ms(&self) -> u64 {
        self.bytes / 2 * 1000 / u64::from(OUTPUT_SAMPLE_RATE)
    }
}

/// The last barge-in this client sent and whether the gateway has answered it with `stop_playback`.
#[derive(Clone, Copy)]
struct BargeIn {
    at_ms: u64,
    answered: bool,
}

/// `-1` stands for "not known" in a log line.
fn opt(value: Option<u64>) -> i64 {
    value.map_or(-1, |value| i64::try_from(value).unwrap_or(i64::MAX))
}

pub struct Session {
    mode: Mode,
    phase: Phase,
    paused: bool,
    ptt_down: bool,
    highest_segment: Option<u32>,
    drop_through: Option<u32>,
    guard_until_ms: u64,
    chunker: FrameChunker,
    cues: CueState,
    run_id: u64,
    segments: HashMap<u32, SegStats>,
    last_seq: Option<u16>,
    barge_in: Option<BargeIn>,
    totals: Totals,
}

/// What the cue decision depends on besides the phase, kept from the gateway's frames.
struct CueState {
    settings: CueSettings,
    turn: Turn,
    tool_backgrounded: bool,
    vad_speaking: bool,
    partial: bool,
    /// Segments announced and not yet played out: speech is audible or about to be.
    speech: HashSet<u32>,
    /// What the platform was last told to play.
    playing: Option<Cue>,
}

impl CueState {
    fn new() -> Self {
        Self {
            settings: CueSettings::default(),
            turn: Turn::Idle,
            tool_backgrounded: false,
            vad_speaking: false,
            partial: false,
            speech: HashSet::new(),
            playing: None,
        }
    }
}

impl Session {
    pub fn new(mode: Mode) -> Self {
        Self {
            mode,
            phase: Phase::AwaitingSocket,
            paused: false,
            ptt_down: false,
            highest_segment: None,
            drop_through: None,
            guard_until_ms: 0,
            chunker: FrameChunker::default(),
            cues: CueState::new(),
            run_id: 0,
            segments: HashMap::new(),
            last_seq: None,
            barge_in: None,
            totals: Totals::default(),
        }
    }

    /// Labels this session's diagnostic lines (`run=`) so they can be told apart from an earlier one's.
    pub fn set_run_id(&mut self, run_id: u64) {
        self.run_id = run_id;
    }

    pub fn totals(&self) -> Totals {
        self.totals
    }

    pub fn is_stopped(&self) -> bool {
        self.phase == Phase::Stopped
    }

    pub fn state(&self) -> NativeState {
        match self.phase {
            Phase::AwaitingSocket | Phase::AwaitingReady => NativeState::Connecting,
            Phase::Running if self.paused => NativeState::Paused,
            Phase::Running => NativeState::Running,
            Phase::Stopped => NativeState::Stopped,
        }
    }

    /// The first event of a session, before the socket exists.
    pub fn begin(&self) -> Vec<Action> {
        vec![state(NativeState::Connecting, None)]
    }

    fn sending(&self) -> bool {
        self.phase == Phase::Running
            && !self.paused
            && (self.mode == Mode::HandsFree || self.ptt_down)
    }

    fn interrupt(&mut self, now_ms: u64) {
        self.drop_through = self.highest_segment.or(self.drop_through);
        self.guard_until_ms = now_ms.saturating_add(INTERRUPT_GUARD_MS);
    }

    /// Whether audio for `segment_id` must be thrown away, extending the
    /// dropped range while the post-interruption guard window is open.
    fn dropped(&mut self, segment_id: u32, now_ms: u64, what: &'static str) -> bool {
        let reason = match self.drop_through {
            Some(through) if segment_id <= through => "interrupted_segment",
            Some(_) if now_ms < self.guard_until_ms => {
                self.drop_through = Some(segment_id);
                "guard_window"
            }
            _ => return false,
        };
        let stats = self.segments.entry(segment_id).or_default();
        stats.dropped += 1;
        if stats.dropped == 1 {
            diag_info!(
                "event=segment_dropped run={} segment={segment_id} what={what} reason={reason} t_ms={now_ms} guard_left_ms={} drop_through={}",
                self.run_id,
                self.guard_until_ms.saturating_sub(now_ms),
                opt(self.drop_through.map(u64::from)),
            );
        }
        true
    }

    /// Logs the summary of one segment that will not be heard (or has been heard) in full, and forgets it.
    fn finish_segment(
        &mut self,
        segment_id: u32,
        outcome: &str,
        played_ms: Option<u64>,
        now_ms: u64,
    ) {
        let Some(stats) = self.segments.remove(&segment_id) else {
            diag_info!(
                "event=segment_outcome run={} segment={segment_id} outcome={outcome} frames=0 bytes=0 played_ms={} t_ms={now_ms} known=false",
                self.run_id,
                opt(played_ms),
            );
            return;
        };
        if stats.frames == 0 && stats.dropped > 0 {
            return;
        }
        let since = stats.announced_ms.or(stats.first_frame_ms);
        diag_info!(
            "event=segment_outcome run={} segment={segment_id} outcome={outcome} frames={} bytes={} audio_ms={} played_ms={} since_announce_ms={} t_ms={now_ms} known=true",
            self.run_id,
            stats.frames,
            stats.bytes,
            stats.audio_ms(),
            opt(played_ms),
            opt(since.map(|at| now_ms.saturating_sub(at))),
        );
    }

    /// Every segment still tracked was cut off: `cut` for the one that was playing, `discarded` for the rest.
    fn finish_all(
        &mut self,
        current: Option<u32>,
        cut: &str,
        discarded: &str,
        played_ms: Option<u64>,
        now_ms: u64,
    ) {
        let mut ids: Vec<u32> = self.segments.keys().copied().collect();
        ids.sort_unstable();
        for id in ids {
            if Some(id) == current {
                self.finish_segment(id, cut, played_ms, now_ms);
            } else {
                self.finish_segment(id, discarded, None, now_ms);
            }
        }
    }

    /// Notes a down-frame's sequence number; the gateway counts every frame it sends, so a jump means frames were lost
    /// (or deliberately discarded by the gateway after it stopped playback).
    fn note_seq(&mut self, seq: u16, now_ms: u64) {
        if let Some(last) = self.last_seq {
            let expected = last.wrapping_add(1);
            if seq != expected {
                let missing = seq.wrapping_sub(expected);
                // A number behind the expected one is a repeat or a reordering, not a skip.
                let reordered = missing > u16::MAX / 2;
                self.totals.seq_gaps += 1;
                if !reordered {
                    self.totals.seq_missing += u64::from(missing);
                }
                diag_info!(
                    "event=down_seq_gap run={} seq={seq} expected={expected} missing={missing} reordered={reordered} t_ms={now_ms}",
                    self.run_id
                );
            }
        }
        self.last_seq = Some(seq);
    }

    /// Bounds the per-segment bookkeeping if segments are announced and never finish.
    fn trim_segments(&mut self, now_ms: u64) {
        if self.segments.len() > 64 {
            if let Some(oldest) = self.segments.keys().min().copied() {
                diag_warn!(
                    "event=segment_stats_overflow run={} evicted_segment={oldest} t_ms={now_ms}",
                    self.run_id
                );
                self.segments.remove(&oldest);
            }
        }
    }

    fn log_end(&self, before: Phase, how: &str, reason: &str, now_ms: u64) {
        let totals = self.totals;
        diag_info!(
            "event=session_end run={} how={how} reason={reason} phase_before={before:?} t_ms={now_ms} down_frames={} down_bytes={} down_invalid={} down_dropped={} seq_gaps={} seq_missing={} up_frames={} up_discarded_bytes={} barge_ins={} stop_playbacks={}",
            self.run_id,
            totals.down_frames,
            totals.down_bytes,
            totals.down_invalid,
            totals.down_dropped,
            totals.seq_gaps,
            totals.seq_missing,
            totals.up_frames,
            totals.up_discarded_bytes,
            totals.barge_ins,
            totals.stop_playbacks,
        );
    }

    fn stop(&mut self, reason: &'static str, now_ms: u64) -> Vec<Action> {
        let was = self.phase;
        self.phase = Phase::Stopped;
        self.log_end(was, "stop", reason, now_ms);
        let mut actions = Vec::new();
        if matches!(was, Phase::AwaitingReady | Phase::Running) {
            actions.push(Action::SendText(ClientFrame::Bye.to_json()));
        }
        actions.push(Action::CloseSocket);
        actions.push(Action::StopPlatform);
        actions.push(state(NativeState::Stopped, Some(reason.to_owned())));
        actions
    }

    pub fn handle(&mut self, input: Input, now_ms: u64) -> Vec<Action> {
        if self.phase == Phase::Stopped {
            return Vec::new();
        }
        if let Input::SegmentPlayed(id) = &input {
            self.cues.speech.remove(id);
        }
        if matches!(input, Input::Onset { .. }) {
            self.cues.speech.clear();
        }
        let mut actions = self.handle_input(input, now_ms);
        match self.cue_change() {
            // Silence first: before anything else the same input asks of the platform.
            Some(None) => actions.insert(0, Action::SetCue(None)),
            Some(request) => actions.push(Action::SetCue(request)),
            None => {}
        }
        actions
    }

    /// The cue to start, switch or stop, when it differs from what the platform was last told.
    fn cue_change(&mut self) -> Option<Option<CueRequest>> {
        let wanted = wanted(&CueInputs {
            settings: self.cues.settings,
            running: self.phase == Phase::Running && !self.paused,
            turn: self.cues.turn,
            hearing: self.cues.vad_speaking
                || self.cues.partial
                || (self.mode == Mode::PushToTalk && self.ptt_down),
            speech_audible: !self.cues.speech.is_empty(),
            tool_backgrounded: self.cues.tool_backgrounded,
        });
        if wanted == self.cues.playing {
            return None;
        }
        diag_debug!(
            "event=cue_change run={} cue={:?} previous={:?}",
            self.run_id,
            wanted,
            self.cues.playing
        );
        self.cues.playing = wanted;
        let volume = self.cues.settings.volume;
        Some(wanted.map(|cue| CueRequest { cue, volume }))
    }

    fn handle_input(&mut self, input: Input, now_ms: u64) -> Vec<Action> {
        match input {
            Input::SocketOpened => {
                if self.phase != Phase::AwaitingSocket {
                    return Vec::new();
                }
                self.phase = Phase::AwaitingReady;
                diag_info!(
                    "event=hello_sent run={} protocol={PROTOCOL_VERSION} mode={:?} t_ms={now_ms}",
                    self.run_id,
                    self.mode
                );
                vec![Action::SendText(
                    ClientFrame::Hello {
                        protocol: PROTOCOL_VERSION,
                        mode: self.mode,
                        client: "native",
                    }
                    .to_json(),
                )]
            }
            Input::SocketClosed { code, reason } => {
                let connected = self.phase != Phase::AwaitingSocket;
                let before = self.phase;
                self.phase = Phase::Stopped;
                diag_warn!(
                    "event=socket_closed run={} connected={connected} code={} reason={:?} t_ms={now_ms}",
                    self.run_id,
                    code.map_or(-1, i32::from),
                    reason.chars().take(64).collect::<String>(),
                );
                self.log_end(before, "socket_closed", "socket_closed", now_ms);
                vec![
                    Action::StopPlatform,
                    Action::State(StateEvent {
                        state: NativeState::Stopped,
                        reason: Some(
                            if connected {
                                reason::SOCKET_CLOSED
                            } else {
                                reason::ERROR
                            }
                            .to_owned(),
                        ),
                        // Only a socket that was open reports why it closed.
                        code: if connected { code } else { None },
                    }),
                ]
            }
            Input::GatewayText(text) => self.gateway_text(text, now_ms),
            Input::GatewayBinary(bytes) => {
                if self.phase != Phase::Running {
                    return Vec::new();
                }
                let frame = match parse_down_frame(&bytes) {
                    Ok(frame) => frame,
                    Err(error) => {
                        self.totals.down_invalid += 1;
                        if self.totals.down_invalid.is_power_of_two() {
                            diag_warn!(
                                "event=down_frame_invalid run={} error={error:?} bytes={} count={} t_ms={now_ms}",
                                self.run_id,
                                bytes.len(),
                                self.totals.down_invalid
                            );
                        }
                        return Vec::new();
                    }
                };
                self.note_seq(frame.seq, now_ms);
                if self.dropped(frame.segment_id, now_ms, "audio") {
                    self.totals.down_dropped += 1;
                    diag_debug!(
                        "event=down_frame_dropped run={} seq={} segment={} bytes={} t_ms={now_ms}",
                        self.run_id,
                        frame.seq,
                        frame.segment_id,
                        frame.pcm.len()
                    );
                    return Vec::new();
                }
                self.highest_segment = Some(
                    self.highest_segment
                        .map_or(frame.segment_id, |h| h.max(frame.segment_id)),
                );
                if frame.pcm.is_empty() {
                    diag_debug!(
                        "event=down_frame_empty run={} seq={} segment={} t_ms={now_ms}",
                        self.run_id,
                        frame.seq,
                        frame.segment_id
                    );
                    return Vec::new();
                }
                self.totals.down_frames += 1;
                self.totals.down_bytes += frame.pcm.len() as u64;
                let stats = self.segments.entry(frame.segment_id).or_default();
                let gap_ms = if stats.frames == 0 {
                    0
                } else {
                    now_ms.saturating_sub(stats.last_frame_ms)
                };
                if stats.first_frame_ms.is_none() {
                    stats.first_frame_ms = Some(now_ms);
                    diag_info!(
                        "event=segment_first_frame run={} segment={} seq={} bytes={} since_announce_ms={} t_ms={now_ms}",
                        self.run_id,
                        frame.segment_id,
                        frame.seq,
                        frame.pcm.len(),
                        opt(stats.announced_ms.map(|at| now_ms.saturating_sub(at))),
                    );
                }
                stats.frames += 1;
                stats.bytes += frame.pcm.len() as u64;
                stats.max_gap_ms = stats.max_gap_ms.max(gap_ms);
                stats.last_frame_ms = now_ms;
                diag_debug!(
                    "event=down_frame run={} seq={} segment={} bytes={} frames={} gap_ms={gap_ms} t_ms={now_ms}",
                    self.run_id,
                    frame.seq,
                    frame.segment_id,
                    frame.pcm.len(),
                    stats.frames
                );
                self.trim_segments(now_ms);
                vec![Action::Play {
                    segment_id: frame.segment_id,
                    pcm: frame.pcm,
                }]
            }
            Input::Capture(bytes) => {
                if !self.sending() {
                    self.totals.up_discarded_bytes += bytes.len() as u64;
                    self.chunker.clear();
                    return Vec::new();
                }
                let frames: Vec<Action> = self
                    .chunker
                    .push(&bytes)
                    .into_iter()
                    .map(Action::SendBinary)
                    .collect();
                self.totals.up_frames += frames.len() as u64;
                frames
            }
            Input::Onset {
                segment_id,
                played_ms,
            } => {
                if self.phase != Phase::Running {
                    diag_debug!(
                        "event=barge_in_ignored run={} phase={:?} t_ms={now_ms}",
                        self.run_id,
                        self.phase
                    );
                    return Vec::new();
                }
                self.interrupt(now_ms);
                self.totals.barge_ins += 1;
                self.barge_in = Some(BargeIn {
                    at_ms: now_ms,
                    answered: false,
                });
                diag_info!(
                    "event=barge_in_sent run={} segment={} played_ms={played_ms} drop_through={} guard_ms={INTERRUPT_GUARD_MS} open_segments={} t_ms={now_ms}",
                    self.run_id,
                    opt(segment_id.map(u64::from)),
                    opt(self.drop_through.map(u64::from)),
                    self.segments.len()
                );
                self.finish_all(
                    segment_id,
                    "cut_onset",
                    "discarded_by_onset",
                    Some(played_ms),
                    now_ms,
                );
                vec![Action::SendText(
                    ClientFrame::BargeIn {
                        segment_id,
                        played_ms,
                    }
                    .to_json(),
                )]
            }
            Input::SegmentPlayed(segment_id) => {
                if self.phase != Phase::Running
                    || self
                        .drop_through
                        .is_some_and(|through| segment_id <= through)
                {
                    diag_info!(
                        "event=played_suppressed run={} segment={segment_id} drop_through={} t_ms={now_ms}",
                        self.run_id,
                        opt(self.drop_through.map(u64::from))
                    );
                    self.segments.remove(&segment_id);
                    return Vec::new();
                }
                self.finish_segment(segment_id, "played", None, now_ms);
                diag_debug!(
                    "event=played_sent run={} segment={segment_id} t_ms={now_ms}",
                    self.run_id
                );
                vec![Action::SendText(
                    ClientFrame::Played { segment_id }.to_json(),
                )]
            }
            Input::Ptt { down } => {
                if self.phase != Phase::Running
                    || self.mode != Mode::PushToTalk
                    || self.paused
                    || self.ptt_down == down
                {
                    return Vec::new();
                }
                self.ptt_down = down;
                if !down {
                    self.chunker.clear();
                }
                diag_info!("event=ptt run={} down={down} t_ms={now_ms}", self.run_id);
                vec![Action::SendText(
                    if down {
                        ClientFrame::PttDown
                    } else {
                        ClientFrame::PttUp
                    }
                    .to_json(),
                )]
            }
            Input::Stop { reason } => {
                let mapped = reason::of_stop(&reason);
                diag_info!(
                    "event=stop_requested run={} requested={reason} reason={mapped} t_ms={now_ms}",
                    self.run_id
                );
                self.stop(mapped, now_ms)
            }
            Input::ReadyTimeout => {
                if self.phase == Phase::AwaitingReady {
                    diag_warn!(
                        "event=ready_timeout run={} t_ms={now_ms} timeout_ms={READY_TIMEOUT_MS}",
                        self.run_id
                    );
                    self.stop(reason::ERROR, now_ms)
                } else {
                    Vec::new()
                }
            }
            Input::InterruptionBegan => {
                if self.phase != Phase::Running || self.paused {
                    return Vec::new();
                }
                self.paused = true;
                self.chunker.clear();
                diag_info!(
                    "event=interruption_began run={} ptt_down={} t_ms={now_ms}",
                    self.run_id,
                    self.ptt_down
                );
                let mut actions = vec![Action::PausePlayback];
                if self.ptt_down {
                    self.ptt_down = false;
                    actions.push(Action::SendText(ClientFrame::PttUp.to_json()));
                }
                actions.push(state(
                    NativeState::Paused,
                    Some(reason::INTERRUPTION.to_owned()),
                ));
                actions
            }
            Input::InterruptionEnded { suspended_ms } => {
                if self.phase != Phase::Running || !self.paused {
                    return Vec::new();
                }
                self.paused = false;
                diag_info!(
                    "event=interruption_ended run={} suspended_ms={suspended_ms} t_ms={now_ms}",
                    self.run_id
                );
                vec![
                    Action::ResumePlayback,
                    Action::SendText(ClientFrame::Resume { suspended_ms }.to_json()),
                    state(NativeState::Running, None),
                ]
            }
        }
    }

    fn gateway_text(&mut self, text: String, now_ms: u64) -> Vec<Action> {
        let Some(frame) = GatewayFrame::parse(&text) else {
            diag_debug!(
                "event=gateway_text_ignored run={} chars={} t_ms={now_ms}",
                self.run_id,
                text.chars().count()
            );
            return Vec::new();
        };
        let mut actions = vec![Action::Forward(text)];
        match frame {
            GatewayFrame::Ready(ready) => {
                if self.phase != Phase::AwaitingReady && self.phase != Phase::Running {
                    return actions;
                }
                diag_info!(
                    "event=ready run={} protocol={} expected_protocol={PROTOCOL_VERSION} input_ok={} output_ok={} threshold={} min_speech_ms={} cues_enabled={} cues_volume={} phase={:?} t_ms={now_ms}",
                    self.run_id,
                    ready.protocol,
                    ready.input_ok,
                    ready.output_ok,
                    ready.onset.threshold,
                    ready.onset.min_speech_ms,
                    ready.cues.enabled,
                    ready.cues.volume,
                    self.phase
                );
                if ready.protocol != PROTOCOL_VERSION || !ready.input_ok || !ready.output_ok {
                    diag_warn!("event=ready_rejected run={} t_ms={now_ms}", self.run_id);
                    actions.extend(self.stop(reason::ERROR, now_ms));
                    return actions;
                }
                self.phase = Phase::Running;
                self.cues = CueState {
                    settings: ready.cues,
                    // What the platform plays carries over, so a second `ready` can still stop it.
                    playing: self.cues.playing,
                    ..CueState::new()
                };
                actions.push(Action::ConfigureOnset(ready.onset));
                actions.push(state(self.state(), None));
            }
            GatewayFrame::StopPlayback { new_reply } => {
                if self.phase == Phase::Running {
                    self.totals.stop_playbacks += 1;
                    let since_barge_in = self.barge_in.map(|b| now_ms.saturating_sub(b.at_ms));
                    if let Some(barge_in) = self.barge_in.as_mut() {
                        barge_in.answered = true;
                    }
                    diag_info!(
                        "event=stop_playback_received run={} new_reply={new_reply} since_barge_in_ms={} open_segments={} highest_segment={} drop_through_before={} t_ms={now_ms}",
                        self.run_id,
                        opt(since_barge_in),
                        self.segments.len(),
                        opt(self.highest_segment.map(u64::from)),
                        opt(self.drop_through.map(u64::from)),
                    );
                    self.finish_all(
                        None,
                        "stopped_by_gateway",
                        "stopped_by_gateway",
                        None,
                        now_ms,
                    );
                    self.interrupt(now_ms);
                    self.cues.speech.clear();
                    if new_reply {
                        // The gateway cut the old reply and goes on to speak the new one on this same
                        // socket, in order: the guard window would throw the new text away.
                        self.guard_until_ms = 0;
                    }
                    actions.push(Action::FlushPlayback);
                }
            }
            GatewayFrame::SegmentStart { segment_id } => {
                if let Some(barge_in) = self.barge_in.filter(|b| !b.answered) {
                    // The gateway went on speaking after this client stopped its own playback and told it so.
                    diag_warn!(
                        "event=segment_start_after_unanswered_barge_in run={} segment={segment_id} since_barge_in_ms={} t_ms={now_ms}",
                        self.run_id,
                        now_ms.saturating_sub(barge_in.at_ms)
                    );
                    self.barge_in = None;
                }
                diag_debug!(
                    "event=segment_start run={} segment={segment_id} highest_segment={} drop_through={} t_ms={now_ms}",
                    self.run_id,
                    opt(self.highest_segment.map(u64::from)),
                    opt(self.drop_through.map(u64::from)),
                );
                if self.phase == Phase::Running && !self.dropped(segment_id, now_ms, "start") {
                    self.segments.entry(segment_id).or_default().announced_ms = Some(now_ms);
                    self.highest_segment = Some(
                        self.highest_segment
                            .map_or(segment_id, |h| h.max(segment_id)),
                    );
                    self.cues.speech.insert(segment_id);
                }
            }
            GatewayFrame::Turn(turn) => {
                diag_info!(
                    "event=turn run={} state={turn:?} t_ms={now_ms}",
                    self.run_id
                );
                // A new turn state is new work: only the tool running when the task was announced counts as moved.
                self.cues.turn = turn;
                self.cues.tool_backgrounded = false;
                if turn == Turn::Idle {
                    self.cues.speech.clear();
                }
                if turn == Turn::Thinking {
                    self.cues.partial = false;
                }
            }
            GatewayFrame::Vad { speaking } => {
                diag_info!(
                    "event=vad run={} speaking={speaking} playing_segments={} t_ms={now_ms}",
                    self.run_id,
                    self.cues.speech.len()
                );
                self.cues.vad_speaking = speaking
            }
            GatewayFrame::Transcript { live } => {
                diag_debug!(
                    "event=transcript run={} live={live} t_ms={now_ms}",
                    self.run_id
                );
                self.cues.partial = live
            }
            GatewayFrame::Background => {
                if self.cues.turn == Turn::Working {
                    self.cues.tool_backgrounded = true;
                }
            }
            GatewayFrame::SegmentEnd { segment_id } => {
                if self.phase == Phase::Running && !self.dropped(segment_id, now_ms, "end") {
                    match self.segments.get(&segment_id) {
                        Some(stats) => diag_info!(
                            "event=segment_received run={} segment={segment_id} frames={} bytes={} audio_ms={} first_frame_ms={} span_ms={} max_frame_gap_ms={} t_ms={now_ms}",
                            self.run_id,
                            stats.frames,
                            stats.bytes,
                            stats.audio_ms(),
                            opt(stats
                                .first_frame_ms
                                .zip(stats.announced_ms)
                                .map(|(first, announced)| first.saturating_sub(announced))),
                            opt(stats.announced_ms.map(|at| now_ms.saturating_sub(at))),
                            stats.max_gap_ms,
                        ),
                        None => diag_info!(
                            "event=segment_received run={} segment={segment_id} frames=0 bytes=0 audio_ms=0 t_ms={now_ms}",
                            self.run_id
                        ),
                    }
                    actions.push(Action::SegmentEnd(segment_id));
                }
            }
            // The frame is forwarded above; the gateway closes the socket next.
            GatewayFrame::Detached { reason } => {
                diag_warn!(
                    "event=detached run={} reason={reason:?} t_ms={now_ms}",
                    self.run_id
                );
            }
            GatewayFrame::Other => {}
        }
        actions
    }
}

fn state(state: NativeState, reason: Option<String>) -> Action {
    Action::State(StateEvent {
        state,
        reason,
        code: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::UP_FRAME_BYTES;

    const READY: &str = r#"{"type":"ready","protocol":1,"sessionId":"s","input":{"encoding":"pcm16","sampleRate":16000},"output":{"encoding":"pcm16","sampleRate":24000},"stt":{"provider":"x","partials":true},"tts":{"provider":"y","voice":null},"onset":{"threshold":0.08,"minSpeechMs":240},"backgrounding":"native","limits":{"maxUtteranceSeconds":60}}"#;

    fn down(segment: u32, pcm: &[u8]) -> Vec<u8> {
        let mut bytes = vec![1, 0, 0, 0];
        bytes.extend_from_slice(&segment.to_le_bytes());
        bytes.extend_from_slice(pcm);
        bytes
    }

    fn running(mode: Mode) -> Session {
        let mut session = Session::new(mode);
        session.handle(Input::SocketOpened, 0);
        session.handle(Input::GatewayText(READY.into()), 0);
        assert_eq!(session.state(), NativeState::Running);
        session
    }

    fn texts(actions: &[Action]) -> Vec<String> {
        actions
            .iter()
            .filter_map(|a| match a {
                Action::SendText(t) => Some(t.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn opening_the_socket_sends_hello_as_the_native_client() {
        let mut session = Session::new(Mode::HandsFree);
        assert_eq!(session.begin(), vec![state(NativeState::Connecting, None)]);
        let actions = session.handle(Input::SocketOpened, 0);
        assert_eq!(
            texts(&actions),
            vec![r#"{"type":"hello","protocol":1,"mode":"hands-free","client":"native"}"#]
        );
    }

    #[test]
    fn ready_configures_the_onset_detector_and_starts_the_session() {
        let mut session = Session::new(Mode::HandsFree);
        session.handle(Input::SocketOpened, 0);
        let actions = session.handle(Input::GatewayText(READY.into()), 0);
        assert_eq!(actions[0], Action::Forward(READY.into()));
        assert!(actions.contains(&Action::ConfigureOnset(Onset {
            threshold: 0.08,
            min_speech_ms: 240
        })));
        assert!(actions.contains(&state(NativeState::Running, None)));
    }

    #[test]
    fn a_gateway_that_never_sends_ready_ends_the_session_with_an_error() {
        let mut session = Session::new(Mode::HandsFree);
        session.handle(Input::SocketOpened, 0);
        let actions = session.handle(Input::ReadyTimeout, READY_TIMEOUT_MS);
        assert!(session.is_stopped());
        assert_eq!(texts(&actions), vec![r#"{"type":"bye"}"#]);
        assert!(actions.contains(&Action::CloseSocket));
        assert!(actions.contains(&Action::StopPlatform));
        assert!(actions.contains(&state(NativeState::Stopped, Some("error".into()))));
    }

    #[test]
    fn the_ready_timeout_is_ignored_once_ready_arrived_or_the_session_ended() {
        let mut running = running(Mode::HandsFree);
        assert!(running
            .handle(Input::ReadyTimeout, READY_TIMEOUT_MS)
            .is_empty());
        assert_eq!(running.state(), NativeState::Running);
        let mut stopped = Session::new(Mode::HandsFree);
        stopped.handle(
            Input::Stop {
                reason: "user".into(),
            },
            0,
        );
        assert!(stopped
            .handle(Input::ReadyTimeout, READY_TIMEOUT_MS)
            .is_empty());
    }

    #[test]
    fn a_ready_with_another_audio_format_ends_the_session() {
        let mut session = Session::new(Mode::HandsFree);
        session.handle(Input::SocketOpened, 0);
        let odd = READY.replace("24000", "48000");
        let actions = session.handle(Input::GatewayText(odd), 0);
        assert!(session.is_stopped());
        assert!(actions.contains(&Action::CloseSocket));
        assert!(actions.contains(&Action::StopPlatform));
        assert!(actions.contains(&state(NativeState::Stopped, Some("error".into()))));
    }

    #[test]
    fn gateway_frames_are_forwarded_unchanged_and_garbage_is_dropped() {
        let mut session = running(Mode::HandsFree);
        let frame =
            r#"{"type":"transcript","utteranceId":"u","text":"hi","final":true,"extra":[1]}"#;
        assert_eq!(
            session.handle(Input::GatewayText(frame.into()), 1),
            vec![Action::Forward(frame.into())]
        );
        assert!(session
            .handle(Input::GatewayText("not json".into()), 1)
            .is_empty());
        assert!(session
            .handle(Input::GatewayText("{}".into()), 1)
            .is_empty());
    }

    #[test]
    fn hands_free_capture_is_sent_continuously_in_exact_frames() {
        let mut session = running(Mode::HandsFree);
        let actions = session.handle(Input::Capture(vec![7; UP_FRAME_BYTES * 2 + 10]), 1);
        assert_eq!(actions.len(), 2);
        assert!(actions
            .iter()
            .all(|a| matches!(a, Action::SendBinary(f) if f.len() == UP_FRAME_BYTES)));
    }

    #[test]
    fn capture_is_not_sent_before_ready() {
        let mut session = Session::new(Mode::HandsFree);
        session.handle(Input::SocketOpened, 0);
        assert!(session.handle(Input::Capture(vec![0; 640]), 0).is_empty());
    }

    #[test]
    fn push_to_talk_sends_audio_only_between_down_and_up() {
        let mut session = running(Mode::PushToTalk);
        assert!(session.handle(Input::Capture(vec![0; 640]), 1).is_empty());
        let down = session.handle(Input::Ptt { down: true }, 2);
        assert_eq!(texts(&down), vec![r#"{"type":"ptt_down"}"#]);
        assert_eq!(session.handle(Input::Capture(vec![0; 640]), 3).len(), 1);
        let up = session.handle(Input::Ptt { down: false }, 4);
        assert_eq!(texts(&up), vec![r#"{"type":"ptt_up"}"#]);
        assert!(session.handle(Input::Capture(vec![0; 640]), 5).is_empty());
    }

    #[test]
    fn ptt_is_ignored_in_hands_free_and_repeats_are_not_resent() {
        let mut hands_free = running(Mode::HandsFree);
        assert!(hands_free.handle(Input::Ptt { down: true }, 1).is_empty());
        let mut ptt = running(Mode::PushToTalk);
        assert_eq!(ptt.handle(Input::Ptt { down: true }, 1).len(), 1);
        assert!(ptt.handle(Input::Ptt { down: true }, 2).is_empty());
    }

    #[test]
    fn down_audio_becomes_playback_and_bad_frames_are_dropped() {
        let mut session = running(Mode::HandsFree);
        assert_eq!(
            session.handle(Input::GatewayBinary(down(1, &[1, 2, 3, 4])), 1),
            vec![Action::Play {
                segment_id: 1,
                pcm: vec![1, 2, 3, 4]
            }]
        );
        assert!(session
            .handle(Input::GatewayBinary(vec![9; 3]), 1)
            .is_empty());
        assert!(session
            .handle(Input::GatewayBinary(down(1, &[])), 1)
            .is_empty());
        let mut early = Session::new(Mode::HandsFree);
        early.handle(Input::SocketOpened, 0);
        assert!(early
            .handle(Input::GatewayBinary(down(1, &[1, 2])), 0)
            .is_empty());
    }

    #[test]
    fn segment_end_is_passed_to_playback_so_it_can_report_played() {
        let mut session = running(Mode::HandsFree);
        let end = r#"{"type":"segment_end","segmentId":4}"#;
        let actions = session.handle(Input::GatewayText(end.into()), 1);
        assert_eq!(
            actions,
            vec![Action::Forward(end.into()), Action::SegmentEnd(4)]
        );
        assert_eq!(
            texts(&session.handle(Input::SegmentPlayed(4), 2)),
            vec![r#"{"type":"played","segmentId":4}"#]
        );
    }

    #[test]
    fn onset_reports_a_barge_in_and_drops_the_interrupted_reply() {
        let mut session = running(Mode::HandsFree);
        session.handle(
            Input::GatewayText(
                r#"{"type":"segment_start","segmentId":3,"messageId":null,"text":"x"}"#.into(),
            ),
            10,
        );
        session.handle(Input::GatewayBinary(down(3, &[1, 2])), 11);
        let actions = session.handle(
            Input::Onset {
                segment_id: Some(3),
                played_ms: 1200,
            },
            1000,
        );
        assert_eq!(
            texts(&actions),
            vec![r#"{"type":"barge_in","segmentId":3,"playedMs":1200}"#]
        );
        // Audio and the end marker of the interrupted segment no longer play,
        // and it is never reported as played.
        assert!(session
            .handle(Input::GatewayBinary(down(3, &[1, 2])), 2000)
            .is_empty());
        let end = session.handle(
            Input::GatewayText(r#"{"type":"segment_end","segmentId":3}"#.into()),
            2000,
        );
        assert_eq!(end.len(), 1);
        assert!(matches!(end[0], Action::Forward(_)));
        assert!(session.handle(Input::SegmentPlayed(3), 2001).is_empty());
        // The next reply plays.
        assert_eq!(
            session
                .handle(Input::GatewayBinary(down(4, &[1, 2])), 2002)
                .len(),
            1
        );
    }

    #[test]
    fn a_barge_in_without_a_playing_segment_carries_null() {
        let mut session = running(Mode::HandsFree);
        let actions = session.handle(
            Input::Onset {
                segment_id: None,
                played_ms: 0,
            },
            5,
        );
        assert_eq!(
            texts(&actions),
            vec![r#"{"type":"barge_in","segmentId":null,"playedMs":0}"#]
        );
    }

    #[test]
    fn audio_in_flight_when_playback_stopped_is_dropped_inside_the_guard_window() {
        let mut session = running(Mode::HandsFree);
        session.handle(Input::GatewayBinary(down(3, &[1, 2])), 10);
        session.handle(
            Input::Onset {
                segment_id: Some(3),
                played_ms: 500,
            },
            100,
        );
        // Segment 4 was already on the wire: its start and audio arrive after
        // the onset but inside the guard window.
        session.handle(
            Input::GatewayText(
                r#"{"type":"segment_start","segmentId":4,"messageId":null,"text":"x"}"#.into(),
            ),
            150,
        );
        assert!(session
            .handle(Input::GatewayBinary(down(4, &[1, 2])), 160)
            .is_empty());
        // After the window a new segment 5 is a new reply and plays.
        assert_eq!(
            session
                .handle(
                    Input::GatewayBinary(down(5, &[1, 2])),
                    100 + INTERRUPT_GUARD_MS + 1
                )
                .len(),
            1
        );
        // And 4 stays dropped even late.
        assert!(session
            .handle(
                Input::GatewayBinary(down(4, &[1, 2])),
                100 + INTERRUPT_GUARD_MS + 2
            )
            .is_empty());
    }

    #[test]
    fn stop_playback_flushes_and_drops_what_is_queued() {
        let mut session = running(Mode::HandsFree);
        session.handle(Input::GatewayBinary(down(7, &[1, 2])), 10);
        let frame = r#"{"type":"stop_playback","reason":"speech"}"#;
        let actions = session.handle(Input::GatewayText(frame.into()), 20);
        assert_eq!(
            actions,
            vec![Action::Forward(frame.into()), Action::FlushPlayback]
        );
        assert!(session
            .handle(Input::GatewayBinary(down(7, &[1, 2])), 30)
            .is_empty());
        // The gateway initiated it, so the client does not send a barge_in.
        assert!(texts(&actions).is_empty());
    }

    #[test]
    fn a_new_reply_stop_drops_the_old_audio_but_not_the_new_text_that_follows_at_once() {
        let mut session = running(Mode::HandsFree);
        session.handle(Input::GatewayBinary(down(7, &[1, 2])), 10);
        let frame = r#"{"type":"stop_playback","reason":"new_reply"}"#;
        let actions = session.handle(Input::GatewayText(frame.into()), 20);
        assert_eq!(
            actions,
            vec![Action::Forward(frame.into()), Action::FlushPlayback]
        );
        // What was queued of the old reply stays dropped, even late.
        assert!(session
            .handle(Input::GatewayBinary(down(7, &[1, 2])), 30)
            .is_empty());
        // The new reply's first audio, well inside the speech guard window, is played.
        assert_eq!(
            session
                .handle(Input::GatewayBinary(down(8, &[1, 2])), 170)
                .len(),
            1
        );
    }

    #[test]
    fn stop_says_bye_closes_the_socket_and_stops_the_platform_once() {
        let mut session = running(Mode::HandsFree);
        let actions = session.handle(
            Input::Stop {
                reason: "notification".into(),
            },
            1,
        );
        assert_eq!(texts(&actions), vec![r#"{"type":"bye"}"#]);
        assert!(actions.contains(&Action::CloseSocket));
        assert!(actions.contains(&Action::StopPlatform));
        assert!(actions.contains(&state(NativeState::Stopped, Some("notification".into()))));
        assert!(session.is_stopped());
        // Everything after the stop is ignored, including a second stop.
        assert!(session
            .handle(
                Input::Stop {
                    reason: "user".into()
                },
                2
            )
            .is_empty());
        assert!(session.handle(Input::Capture(vec![0; 640]), 2).is_empty());
        assert!(session
            .handle(
                Input::SocketClosed {
                    code: Some(1000),
                    reason: String::new()
                },
                3
            )
            .is_empty());
    }

    #[test]
    fn stopping_before_the_socket_opened_sends_no_bye() {
        let mut session = Session::new(Mode::HandsFree);
        let actions = session.handle(
            Input::Stop {
                reason: "user".into(),
            },
            0,
        );
        assert!(texts(&actions).is_empty());
        assert!(actions.contains(&Action::CloseSocket));
    }

    #[test]
    fn a_closed_socket_reports_the_close_code_to_the_web() {
        for code in [4401u16, 4404, 4409, 4429, 1000, 1001] {
            let mut session = running(Mode::HandsFree);
            let actions = session.handle(
                Input::SocketClosed {
                    code: Some(code),
                    reason: String::new(),
                },
                1,
            );
            assert_eq!(
                actions,
                vec![
                    Action::StopPlatform,
                    Action::State(StateEvent {
                        state: NativeState::Stopped,
                        reason: Some("socket_closed".into()),
                        code: Some(code),
                    })
                ]
            );
        }
    }

    #[test]
    fn a_4409_close_reaches_the_web_as_stopped_socket_closed_4409() {
        let mut session = running(Mode::HandsFree);
        let actions = session.handle(
            Input::SocketClosed {
                code: Some(4409),
                reason: "in_use".into(),
            },
            1,
        );
        let json = actions
            .iter()
            .find_map(|a| match a {
                Action::State(event) => Some(event.to_json()),
                _ => None,
            })
            .expect("a state event");
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "type": "native_state",
                "state": "stopped",
                "reason": "socket_closed",
                "code": 4409
            })
        );
    }

    #[test]
    fn a_connection_lost_without_a_close_frame_has_no_code() {
        let mut session = running(Mode::HandsFree);
        let actions = session.handle(
            Input::SocketClosed {
                code: None,
                reason: String::new(),
            },
            1,
        );
        assert!(actions.contains(&state(NativeState::Stopped, Some("socket_closed".into()))));
    }

    #[test]
    fn a_failed_connection_reports_an_error() {
        let mut session = Session::new(Mode::HandsFree);
        let actions = session.handle(
            Input::SocketClosed {
                code: None,
                reason: String::new(),
            },
            0,
        );
        assert!(actions.contains(&state(NativeState::Stopped, Some("error".into()))));
    }

    #[test]
    fn a_close_code_before_the_socket_opened_is_an_error_without_a_code() {
        let mut session = Session::new(Mode::HandsFree);
        let actions = session.handle(
            Input::SocketClosed {
                code: Some(1006),
                reason: String::new(),
            },
            0,
        );
        assert!(actions.contains(&Action::State(StateEvent {
            state: NativeState::Stopped,
            reason: Some("error".into()),
            code: None,
        })));
    }

    #[test]
    fn detached_is_forwarded_and_the_close_that_follows_stops_the_session() {
        let mut session = running(Mode::HandsFree);
        let detached = r#"{"type":"detached","reason":"taken_over"}"#;
        assert_eq!(
            session.handle(Input::GatewayText(detached.into()), 1),
            vec![Action::Forward(detached.into())]
        );
        let actions = session.handle(
            Input::SocketClosed {
                code: Some(1000),
                reason: String::new(),
            },
            2,
        );
        assert!(actions.contains(&Action::State(StateEvent {
            state: NativeState::Stopped,
            reason: Some("socket_closed".into()),
            code: Some(1000),
        })));
    }

    #[test]
    fn stop_reasons_map_onto_the_contract_values() {
        for (asked, reported) in [
            ("user", "user"),
            ("notification", "notification"),
            ("lock_screen", "notification"),
            ("focus_lost", "interruption"),
            ("interruption", "interruption"),
            ("task_removed", "user"),
            ("connect_failed", "error"),
            ("anything else", "error"),
        ] {
            let mut session = running(Mode::HandsFree);
            let actions = session.handle(
                Input::Stop {
                    reason: asked.into(),
                },
                1,
            );
            assert!(
                actions.contains(&state(NativeState::Stopped, Some(reported.into()))),
                "{asked}"
            );
        }
    }

    #[test]
    fn an_interruption_pauses_capture_and_playback_and_resume_tells_the_gateway() {
        let mut session = running(Mode::HandsFree);
        let began = session.handle(Input::InterruptionBegan, 10);
        assert!(began.contains(&Action::PausePlayback));
        assert!(began.contains(&state(NativeState::Paused, Some("interruption".into()))));
        assert_eq!(session.state(), NativeState::Paused);
        assert!(session.handle(Input::Capture(vec![0; 640]), 11).is_empty());
        // A second begin is a no-op.
        assert!(session.handle(Input::InterruptionBegan, 12).is_empty());
        let ended = session.handle(Input::InterruptionEnded { suspended_ms: 4200 }, 4210);
        assert_eq!(
            texts(&ended),
            vec![r#"{"type":"resume","suspendedMs":4200}"#]
        );
        assert!(ended.contains(&Action::ResumePlayback));
        assert!(ended.contains(&state(NativeState::Running, None)));
        assert_eq!(session.handle(Input::Capture(vec![0; 640]), 4211).len(), 1);
        // An end without a begin is a no-op.
        assert!(session
            .handle(Input::InterruptionEnded { suspended_ms: 1 }, 5000)
            .is_empty());
    }

    #[test]
    fn an_interruption_releases_a_held_push_to_talk_button() {
        let mut session = running(Mode::PushToTalk);
        session.handle(Input::Ptt { down: true }, 1);
        let began = session.handle(Input::InterruptionBegan, 2);
        assert_eq!(texts(&began), vec![r#"{"type":"ptt_up"}"#]);
        session.handle(Input::InterruptionEnded { suspended_ms: 10 }, 12);
        // The user has to press again.
        assert!(session.handle(Input::Capture(vec![0; 640]), 13).is_empty());
    }

    #[test]
    fn a_route_change_is_not_an_interruption() {
        // Headphones coming and going never reach the core: the platform keeps
        // the session going. The core has no input for it by design.
        let session = running(Mode::HandsFree);
        assert_eq!(session.state(), NativeState::Running);
    }

    #[test]
    fn state_events_serialize_as_native_state_frames() {
        let json = StateEvent {
            state: NativeState::Stopped,
            reason: Some("socket_closed".into()),
            code: None,
        }
        .to_json();
        assert_eq!(
            json,
            r#"{"reason":"socket_closed","state":"stopped","type":"native_state"}"#
        );
        let bare = StateEvent {
            state: NativeState::Running,
            reason: None,
            code: None,
        }
        .to_json();
        assert_eq!(bare, r#"{"state":"running","type":"native_state"}"#);
    }

    // ── sound cues ──────────────────────────────────────────────────────────

    fn cue_actions(actions: &[Action]) -> Vec<Option<Cue>> {
        actions
            .iter()
            .filter_map(|a| match a {
                Action::SetCue(request) => Some(request.map(|r| r.cue)),
                _ => None,
            })
            .collect()
    }

    /// Feeds a gateway frame and returns the cue changes it caused.
    fn frame(session: &mut Session, json: &str) -> Vec<Option<Cue>> {
        cue_actions(&session.handle(Input::GatewayText(json.into()), 1))
    }

    fn turn(session: &mut Session, state: &str) -> Vec<Option<Cue>> {
        frame(session, &format!(r#"{{"type":"turn","state":"{state}"}}"#))
    }

    fn ready_with(cues: &str) -> String {
        READY.replace(
            r#""backgrounding""#,
            &format!(r#""cues":{cues},"backgrounding""#),
        )
    }

    fn running_with(cues: &str) -> Session {
        let mut session = Session::new(Mode::HandsFree);
        session.handle(Input::SocketOpened, 0);
        session.handle(Input::GatewayText(ready_with(cues)), 0);
        session
    }

    fn start_speech(session: &mut Session, id: u32) -> Vec<Option<Cue>> {
        frame(
            session,
            &format!(
                r#"{{"type":"segment_start","segmentId":{id},"messageId":null,"text":"Hi."}}"#
            ),
        )
    }

    #[test]
    fn a_ready_with_cue_settings_is_read_and_one_without_means_the_defaults() {
        let loud = GatewayFrame::parse(&ready_with(r#"{"enabled":false,"volume":0.8}"#));
        let Some(GatewayFrame::Ready(loud)) = loud else {
            panic!("not ready")
        };
        assert_eq!(
            loud.cues,
            CueSettings {
                enabled: false,
                volume: 0.8
            }
        );
        let Some(GatewayFrame::Ready(plain)) = GatewayFrame::parse(READY) else {
            panic!("not ready")
        };
        assert_eq!(plain.cues, CueSettings::default());
        let Some(GatewayFrame::Ready(odd)) =
            GatewayFrame::parse(&ready_with(r#"{"enabled":"no","volume":9}"#))
        else {
            panic!("not ready")
        };
        assert_eq!(
            odd.cues,
            CueSettings {
                enabled: true,
                volume: 1.0
            }
        );
    }

    #[test]
    fn thinking_starts_the_cue_a_tool_switches_it_and_speech_stops_it() {
        let mut session = running(Mode::HandsFree);
        assert_eq!(turn(&mut session, "thinking"), vec![Some(Cue::Thinking)]);
        assert_eq!(turn(&mut session, "working"), vec![Some(Cue::Tool)]);
        assert_eq!(turn(&mut session, "thinking"), vec![Some(Cue::Thinking)]);
        assert_eq!(turn(&mut session, "speaking"), vec![None]);
        assert!(start_speech(&mut session, 1).is_empty());
    }

    #[test]
    fn the_request_carries_the_configured_volume() {
        let mut session = running_with(r#"{"enabled":true,"volume":0.45}"#);
        let actions = session.handle(
            Input::GatewayText(r#"{"type":"turn","state":"thinking"}"#.into()),
            1,
        );
        assert!(actions.contains(&Action::SetCue(Some(CueRequest {
            cue: Cue::Thinking,
            volume: 0.45
        }))));
    }

    #[test]
    fn the_cue_is_asked_for_once_not_on_every_frame() {
        let mut session = running(Mode::HandsFree);
        assert_eq!(turn(&mut session, "thinking").len(), 1);
        assert!(frame(
            &mut session,
            r#"{"type":"metrics","utteranceId":"u","sttMs":1,"ttfaMs":null}"#
        )
        .is_empty());
        assert!(frame(&mut session, r#"{"type":"holding","text":"x"}"#).is_empty());
    }

    #[test]
    fn nothing_sounds_when_cues_are_off_or_silent() {
        for cues in [
            r#"{"enabled":false,"volume":0.3}"#,
            r#"{"enabled":true,"volume":0}"#,
        ] {
            let mut session = running_with(cues);
            assert!(turn(&mut session, "thinking").is_empty());
            assert!(turn(&mut session, "working").is_empty());
            start_speech(&mut session, 1);
            assert!(turn(&mut session, "idle").is_empty());
        }
    }

    #[test]
    fn a_gateway_without_cue_settings_gets_the_defaults() {
        let mut session = running(Mode::HandsFree);
        let actions = session.handle(
            Input::GatewayText(r#"{"type":"turn","state":"working"}"#.into()),
            1,
        );
        assert!(actions.contains(&Action::SetCue(Some(CueRequest {
            cue: Cue::Tool,
            volume: 0.3
        }))));
    }

    #[test]
    fn the_cue_is_silent_while_the_user_is_heard_and_returns_after() {
        let mut session = running(Mode::HandsFree);
        turn(&mut session, "thinking");
        assert_eq!(
            frame(&mut session, r#"{"type":"vad","speaking":true}"#),
            vec![None]
        );
        assert_eq!(
            frame(&mut session, r#"{"type":"vad","speaking":false}"#),
            vec![Some(Cue::Thinking)]
        );
        assert_eq!(
            frame(
                &mut session,
                r#"{"type":"transcript","utteranceId":"u","text":"wait","final":false}"#
            ),
            vec![None]
        );
        assert_eq!(
            frame(
                &mut session,
                r#"{"type":"transcript","utteranceId":"u","text":"wait","final":true}"#
            ),
            vec![Some(Cue::Thinking)]
        );
    }

    #[test]
    fn push_to_talk_held_silences_the_cue() {
        let mut session = running(Mode::PushToTalk);
        turn(&mut session, "thinking");
        assert_eq!(
            cue_actions(&session.handle(Input::Ptt { down: true }, 2)),
            vec![None]
        );
        assert_eq!(
            cue_actions(&session.handle(Input::Ptt { down: false }, 3)),
            vec![Some(Cue::Thinking)]
        );
    }

    #[test]
    fn a_holding_line_over_long_work_silences_the_tool_cue_until_it_has_played() {
        let mut session = running(Mode::HandsFree);
        turn(&mut session, "working");
        assert_eq!(start_speech(&mut session, 4), vec![None]);
        session.handle(Input::GatewayBinary(down(4, &[1, 0, 2, 0])), 2);
        frame(&mut session, r#"{"type":"segment_end","segmentId":4}"#);
        assert_eq!(
            cue_actions(&session.handle(Input::SegmentPlayed(4), 3)),
            vec![Some(Cue::Tool)]
        );
    }

    #[test]
    fn a_stop_playback_frees_the_cue_because_the_dropped_speech_never_reports_played() {
        let mut session = running(Mode::HandsFree);
        turn(&mut session, "working");
        assert_eq!(start_speech(&mut session, 7), vec![None]);
        assert_eq!(
            frame(&mut session, r#"{"type":"stop_playback"}"#),
            vec![Some(Cue::Tool)]
        );
    }

    #[test]
    fn the_end_of_a_turn_frees_the_cue_from_speech_that_never_reported_played() {
        let mut session = running(Mode::HandsFree);
        turn(&mut session, "thinking");
        assert_eq!(start_speech(&mut session, 3), vec![None]);
        assert!(turn(&mut session, "idle").is_empty());
        assert_eq!(turn(&mut session, "thinking"), vec![Some(Cue::Thinking)]);
    }

    #[test]
    fn a_new_thinking_turn_forgets_a_live_transcript_that_never_ended() {
        let mut session = running(Mode::HandsFree);
        frame(
            &mut session,
            r#"{"type":"transcript","utteranceId":"u","text":"hm","final":false}"#,
        );
        assert_eq!(turn(&mut session, "thinking"), vec![Some(Cue::Thinking)]);
    }

    #[test]
    fn a_second_ready_can_still_stop_the_cue_it_found_playing() {
        for cues in [
            r#"{"enabled":false,"volume":0.3}"#,
            r#"{"enabled":true,"volume":0.3}"#,
        ] {
            let mut session = running(Mode::HandsFree);
            assert_eq!(turn(&mut session, "thinking"), vec![Some(Cue::Thinking)]);
            // The new ready starts the turn state over, so nothing is wanted: the platform must be told.
            let again = session.handle(Input::GatewayText(ready_with(cues)), 5);
            assert_eq!(cue_actions(&again), vec![None], "cues {cues}");
        }
    }

    #[test]
    fn a_barge_in_clears_the_speech_that_was_cut() {
        let mut session = running(Mode::HandsFree);
        turn(&mut session, "thinking");
        start_speech(&mut session, 1);
        turn(&mut session, "speaking");
        let cut = session.handle(
            Input::Onset {
                segment_id: Some(1),
                played_ms: 100,
            },
            4,
        );
        assert!(cue_actions(&cut).is_empty());
        // The gateway then runs a new turn that is thinking: the cue is not held back by the cut speech.
        assert_eq!(turn(&mut session, "thinking"), vec![Some(Cue::Thinking)]);
    }

    #[test]
    fn a_tool_moved_to_the_background_hands_over_to_thinking_and_the_turn_ending_stops_it() {
        let mut session = running(Mode::HandsFree);
        turn(&mut session, "working");
        assert_eq!(
            frame(
                &mut session,
                r#"{"type":"background","taskId":"t","description":"build"}"#
            ),
            vec![Some(Cue::Thinking)]
        );
        assert!(turn(&mut session, "thinking").is_empty());
        assert_eq!(turn(&mut session, "idle"), vec![None]);
        // Background work outliving the turn is silent, and a background frame while idle changes nothing.
        assert!(frame(
            &mut session,
            r#"{"type":"background","taskId":"u","description":null}"#
        )
        .is_empty());
    }

    #[test]
    fn a_new_tool_after_a_backgrounded_one_gets_the_tool_cue_again() {
        let mut session = running(Mode::HandsFree);
        turn(&mut session, "working");
        frame(
            &mut session,
            r#"{"type":"background","taskId":"t","description":null}"#,
        );
        turn(&mut session, "thinking");
        assert_eq!(turn(&mut session, "working"), vec![Some(Cue::Tool)]);
    }

    #[test]
    fn a_call_pauses_the_cue_and_the_end_of_the_call_brings_it_back() {
        let mut session = running(Mode::HandsFree);
        turn(&mut session, "thinking");
        let paused = session.handle(Input::InterruptionBegan, 2);
        assert_eq!(cue_actions(&paused), vec![None]);
        let resumed = session.handle(Input::InterruptionEnded { suspended_ms: 500 }, 3);
        assert_eq!(cue_actions(&resumed), vec![Some(Cue::Thinking)]);
    }

    #[test]
    fn stopping_silences_the_cue_before_the_platform_is_stopped() {
        for end in [
            Input::Stop {
                reason: "user".into(),
            },
            Input::SocketClosed {
                code: Some(1006),
                reason: String::new(),
            },
        ] {
            let mut session = running(Mode::HandsFree);
            turn(&mut session, "working");
            let actions = session.handle(end, 5);
            let silence = actions.iter().position(|a| *a == Action::SetCue(None));
            let stop = actions.iter().position(|a| *a == Action::StopPlatform);
            assert!(
                silence.is_some() && stop.is_some() && silence < stop,
                "{actions:?}"
            );
        }
    }

    #[test]
    fn cue_frames_are_still_forwarded_to_the_web_ui() {
        let mut session = running(Mode::HandsFree);
        let json = r#"{"type":"turn","state":"thinking"}"#;
        let actions = session.handle(Input::GatewayText(json.into()), 1);
        assert_eq!(actions[0], Action::Forward(json.into()));
    }

    fn down_seq(seq: u16, segment: u32, pcm: &[u8]) -> Vec<u8> {
        let mut bytes = down(segment, pcm);
        bytes[2..4].copy_from_slice(&seq.to_le_bytes());
        bytes
    }

    #[test]
    fn the_diagnostic_totals_count_frames_gaps_and_drops_without_changing_the_actions() {
        let mut session = running(Mode::HandsFree);
        session.handle(Input::GatewayBinary(down_seq(0, 1, &[1, 2, 3, 4])), 1);
        // Two frames lost, then a frame that repeats an earlier number.
        session.handle(Input::GatewayBinary(down_seq(3, 1, &[1, 2])), 2);
        session.handle(Input::GatewayBinary(down_seq(3, 1, &[1, 2])), 3);
        session.handle(Input::GatewayBinary(vec![9; 3]), 4);
        let totals = session.totals();
        assert_eq!(totals.down_frames, 3);
        assert_eq!(totals.down_bytes, 8);
        assert_eq!(totals.seq_gaps, 2);
        assert_eq!(totals.seq_missing, 2);
        assert_eq!(totals.down_invalid, 1);
        session.handle(
            Input::Onset {
                segment_id: Some(1),
                played_ms: 10,
            },
            5,
        );
        session.handle(Input::GatewayBinary(down_seq(4, 1, &[1, 2])), 6);
        assert_eq!(session.totals().down_dropped, 1);
        assert_eq!(session.totals().barge_ins, 1);
    }
}
