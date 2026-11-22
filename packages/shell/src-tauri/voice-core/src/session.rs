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

use crate::{
    audio::{parse_down_frame, FrameChunker},
    protocol::{close_reason, ClientFrame, GatewayFrame, Mode, Onset, PROTOCOL_VERSION},
};

/// After an interruption, audio and segment announcements that were already in
/// flight when it happened keep arriving for about one round trip. Anything
/// newer than the interrupted reply that shows up inside this window is part of
/// it and is dropped too.
pub const INTERRUPT_GUARD_MS: u64 = 400;

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
}

impl StateEvent {
    /// `{"type":"native_state","state":...,"reason"?:...}`. Gateways never emit
    /// this type, so it cannot be confused with a forwarded gateway frame.
    pub fn to_json(&self) -> String {
        let mut value = serde_json::json!({
            "type": "native_state",
            "state": self.state.as_str(),
        });
        if let Some(reason) = &self.reason {
            value["reason"] = serde_json::Value::String(reason.clone());
        }
        value.to_string()
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
    PausePlayback,
    ResumePlayback,
    CloseSocket,
    StopPlatform,
}

pub struct Session {
    mode: Mode,
    phase: Phase,
    paused: bool,
    ptt_down: bool,
    highest_segment: Option<u32>,
    drop_through: Option<u32>,
    guard_until_ms: u64,
    detached_reason: Option<String>,
    chunker: FrameChunker,
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
            detached_reason: None,
            chunker: FrameChunker::default(),
        }
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
    fn dropped(&mut self, segment_id: u32, now_ms: u64) -> bool {
        match self.drop_through {
            Some(through) if segment_id <= through => true,
            Some(_) if now_ms < self.guard_until_ms => {
                self.drop_through = Some(segment_id);
                true
            }
            _ => false,
        }
    }

    fn stop(&mut self, reason: String) -> Vec<Action> {
        let was = self.phase;
        self.phase = Phase::Stopped;
        let mut actions = Vec::new();
        if matches!(was, Phase::AwaitingReady | Phase::Running) {
            actions.push(Action::SendText(ClientFrame::Bye.to_json()));
        }
        actions.push(Action::CloseSocket);
        actions.push(Action::StopPlatform);
        actions.push(state(NativeState::Stopped, Some(reason)));
        actions
    }

    pub fn handle(&mut self, input: Input, now_ms: u64) -> Vec<Action> {
        if self.phase == Phase::Stopped {
            return Vec::new();
        }
        match input {
            Input::SocketOpened => {
                if self.phase != Phase::AwaitingSocket {
                    return Vec::new();
                }
                self.phase = Phase::AwaitingReady;
                vec![Action::SendText(
                    ClientFrame::Hello {
                        protocol: PROTOCOL_VERSION,
                        mode: self.mode,
                        client: "native",
                    }
                    .to_json(),
                )]
            }
            Input::SocketClosed { code, .. } => {
                let reason = if self.phase == Phase::AwaitingSocket {
                    "connect_failed".to_owned()
                } else {
                    self.detached_reason
                        .take()
                        .unwrap_or_else(|| close_reason(code).to_owned())
                };
                self.phase = Phase::Stopped;
                vec![
                    Action::StopPlatform,
                    state(NativeState::Stopped, Some(reason)),
                ]
            }
            Input::GatewayText(text) => self.gateway_text(text, now_ms),
            Input::GatewayBinary(bytes) => {
                if self.phase != Phase::Running {
                    return Vec::new();
                }
                let Ok(frame) = parse_down_frame(&bytes) else {
                    return Vec::new();
                };
                if self.dropped(frame.segment_id, now_ms) {
                    return Vec::new();
                }
                self.highest_segment = Some(
                    self.highest_segment
                        .map_or(frame.segment_id, |h| h.max(frame.segment_id)),
                );
                if frame.pcm.is_empty() {
                    return Vec::new();
                }
                vec![Action::Play {
                    segment_id: frame.segment_id,
                    pcm: frame.pcm,
                }]
            }
            Input::Capture(bytes) => {
                if !self.sending() {
                    self.chunker.clear();
                    return Vec::new();
                }
                self.chunker
                    .push(&bytes)
                    .into_iter()
                    .map(Action::SendBinary)
                    .collect()
            }
            Input::Onset {
                segment_id,
                played_ms,
            } => {
                if self.phase != Phase::Running {
                    return Vec::new();
                }
                self.interrupt(now_ms);
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
                    return Vec::new();
                }
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
                vec![Action::SendText(
                    if down {
                        ClientFrame::PttDown
                    } else {
                        ClientFrame::PttUp
                    }
                    .to_json(),
                )]
            }
            Input::Stop { reason } => self.stop(reason),
            Input::InterruptionBegan => {
                if self.phase != Phase::Running || self.paused {
                    return Vec::new();
                }
                self.paused = true;
                self.chunker.clear();
                let mut actions = vec![Action::PausePlayback];
                if self.ptt_down {
                    self.ptt_down = false;
                    actions.push(Action::SendText(ClientFrame::PttUp.to_json()));
                }
                actions.push(state(NativeState::Paused, None));
                actions
            }
            Input::InterruptionEnded { suspended_ms } => {
                if self.phase != Phase::Running || !self.paused {
                    return Vec::new();
                }
                self.paused = false;
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
            return Vec::new();
        };
        let mut actions = vec![Action::Forward(text)];
        match frame {
            GatewayFrame::Ready(ready) => {
                if self.phase != Phase::AwaitingReady && self.phase != Phase::Running {
                    return actions;
                }
                if ready.protocol != PROTOCOL_VERSION || !ready.input_ok || !ready.output_ok {
                    actions.extend(self.stop("unsupported_format".to_owned()));
                    return actions;
                }
                self.phase = Phase::Running;
                actions.push(Action::ConfigureOnset(ready.onset));
                actions.push(state(self.state(), None));
            }
            GatewayFrame::StopPlayback => {
                if self.phase == Phase::Running {
                    self.interrupt(now_ms);
                    actions.push(Action::FlushPlayback);
                }
            }
            GatewayFrame::SegmentStart { segment_id } => {
                if self.phase == Phase::Running && !self.dropped(segment_id, now_ms) {
                    self.highest_segment = Some(
                        self.highest_segment
                            .map_or(segment_id, |h| h.max(segment_id)),
                    );
                }
            }
            GatewayFrame::SegmentEnd { segment_id } => {
                if self.phase == Phase::Running && !self.dropped(segment_id, now_ms) {
                    actions.push(Action::SegmentEnd(segment_id));
                }
            }
            GatewayFrame::Detached { reason } => {
                self.detached_reason = Some(reason);
            }
            GatewayFrame::Other => {}
        }
        actions
    }
}

fn state(state: NativeState, reason: Option<String>) -> Action {
    Action::State(StateEvent { state, reason })
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
    fn a_ready_with_another_audio_format_ends_the_session() {
        let mut session = Session::new(Mode::HandsFree);
        session.handle(Input::SocketOpened, 0);
        let odd = READY.replace("24000", "48000");
        let actions = session.handle(Input::GatewayText(odd), 0);
        assert!(session.is_stopped());
        assert!(actions.contains(&Action::CloseSocket));
        assert!(actions.contains(&Action::StopPlatform));
        assert!(actions.contains(&state(
            NativeState::Stopped,
            Some("unsupported_format".into())
        )));
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
    fn a_closed_socket_reports_why_and_stops_the_platform() {
        let cases = [
            (Some(4401), "access_lost"),
            (Some(4409), "in_use"),
            (Some(4429), "limit"),
            (Some(4404), "session_gone"),
            (Some(1000), "closed"),
            (None, "connection_lost"),
        ];
        for (code, reason) in cases {
            let mut session = running(Mode::HandsFree);
            let actions = session.handle(
                Input::SocketClosed {
                    code,
                    reason: String::new(),
                },
                1,
            );
            assert_eq!(
                actions,
                vec![
                    Action::StopPlatform,
                    state(NativeState::Stopped, Some(reason.into()))
                ]
            );
        }
    }

    #[test]
    fn a_failed_connection_reports_connect_failed() {
        let mut session = Session::new(Mode::HandsFree);
        let actions = session.handle(
            Input::SocketClosed {
                code: None,
                reason: String::new(),
            },
            0,
        );
        assert!(actions.contains(&state(NativeState::Stopped, Some("connect_failed".into()))));
    }

    #[test]
    fn detached_gives_the_stop_reason() {
        let mut session = running(Mode::HandsFree);
        session.handle(
            Input::GatewayText(r#"{"type":"detached","reason":"taken_over"}"#.into()),
            1,
        );
        let actions = session.handle(
            Input::SocketClosed {
                code: Some(1000),
                reason: String::new(),
            },
            2,
        );
        assert!(actions.contains(&state(NativeState::Stopped, Some("taken_over".into()))));
    }

    #[test]
    fn an_interruption_pauses_capture_and_playback_and_resume_tells_the_gateway() {
        let mut session = running(Mode::HandsFree);
        let began = session.handle(Input::InterruptionBegan, 10);
        assert!(began.contains(&Action::PausePlayback));
        assert!(began.contains(&state(NativeState::Paused, None)));
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
            reason: Some("access_lost".into()),
        }
        .to_json();
        assert_eq!(
            json,
            r#"{"reason":"access_lost","state":"stopped","type":"native_state"}"#
        );
        let bare = StateEvent {
            state: NativeState::Running,
            reason: None,
        }
        .to_json();
        assert_eq!(bare, r#"{"state":"running","type":"native_state"}"#);
    }
}
