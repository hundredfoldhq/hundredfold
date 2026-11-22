//! Frames of `/ws/voice/:sessionId`, as the native client speaks them.
//!
//! Mirrors `packages/gateway-events/src/voice-protocol.ts`; that file is the
//! source of truth and the constants below must match it.

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;
pub const INPUT_SAMPLE_RATE: u32 = 16_000;
pub const OUTPUT_SAMPLE_RATE: u32 = 24_000;
/// One 20 ms up-frame: PCM16LE mono at 16 kHz.
pub const UP_FRAME_BYTES: usize = 640;
/// Largest binary frame a client may send.
pub const MAX_UP_FRAME_BYTES: usize = 4096;
pub const DOWN_AUDIO_KIND: u8 = 1;
pub const DOWN_HEADER_BYTES: usize = 8;
/// Largest PCM payload of one down-frame.
pub const MAX_DOWN_PCM_BYTES: usize = 16 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Mode {
    #[serde(rename = "hands-free")]
    HandsFree,
    #[serde(rename = "push-to-talk")]
    PushToTalk,
}

impl Mode {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "hands-free" => Some(Self::HandsFree),
            "push-to-talk" => Some(Self::PushToTalk),
            _ => None,
        }
    }
}

/// Client → gateway frames.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientFrame {
    Hello {
        protocol: u32,
        mode: Mode,
        client: &'static str,
    },
    PttDown,
    PttUp,
    BargeIn {
        #[serde(rename = "segmentId")]
        segment_id: Option<u32>,
        #[serde(rename = "playedMs")]
        played_ms: u64,
    },
    Played {
        #[serde(rename = "segmentId")]
        segment_id: u32,
    },
    Resume {
        #[serde(rename = "suspendedMs")]
        suspended_ms: u64,
    },
    Bye,
}

impl ClientFrame {
    pub fn to_json(&self) -> String {
        // Serializing these plain structs cannot fail.
        serde_json::to_string(self).unwrap_or_default()
    }
}

/// The parts of a gateway frame the native client acts on. Every frame is also
/// forwarded to the web UI untouched, so unknown fields and types are fine.
#[derive(Clone, Debug, PartialEq)]
pub enum GatewayFrame {
    Ready(Ready),
    StopPlayback,
    SegmentStart { segment_id: u32 },
    SegmentEnd { segment_id: u32 },
    Detached { reason: String },
    Other,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Ready {
    pub protocol: u32,
    pub input_ok: bool,
    pub output_ok: bool,
    pub onset: Onset,
}

/// Parameters of the client's playback-stopping onset detector (`ready.onset`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Onset {
    pub threshold: f32,
    pub min_speech_ms: u32,
}

impl Default for Onset {
    fn default() -> Self {
        Self {
            threshold: 0.05,
            min_speech_ms: 200,
        }
    }
}

fn segment_id_of(value: &serde_json::Value) -> Option<u32> {
    u32::try_from(value.get("segmentId")?.as_u64()?).ok()
}

impl GatewayFrame {
    /// Returns `None` when the text is not a JSON object with a `type`.
    pub fn parse(text: &str) -> Option<Self> {
        let value: serde_json::Value = serde_json::from_str(text).ok()?;
        let kind = value.get("type")?.as_str()?;
        Some(match kind {
            "ready" => {
                let format_ok = |key: &str, rate: u32| {
                    value.get(key).is_some_and(|f| {
                        f.get("encoding").and_then(|e| e.as_str()) == Some("pcm16")
                            && f.get("sampleRate").and_then(|r| r.as_u64()) == Some(rate as u64)
                    })
                };
                let defaults = Onset::default();
                let onset = value.get("onset");
                let threshold = onset
                    .and_then(|o| o.get("threshold"))
                    .and_then(|t| t.as_f64())
                    .map(|t| t as f32)
                    .filter(|t| t.is_finite() && *t > 0.0 && *t <= 1.0)
                    .unwrap_or(defaults.threshold);
                let min_speech_ms = onset
                    .and_then(|o| o.get("minSpeechMs"))
                    .and_then(|t| t.as_u64())
                    .and_then(|t| u32::try_from(t).ok())
                    .filter(|t| (20..=5_000).contains(t))
                    .unwrap_or(defaults.min_speech_ms);
                Self::Ready(Ready {
                    protocol: value
                        .get("protocol")
                        .and_then(|p| p.as_u64())
                        .and_then(|p| u32::try_from(p).ok())
                        .unwrap_or(0),
                    input_ok: format_ok("input", INPUT_SAMPLE_RATE),
                    output_ok: format_ok("output", OUTPUT_SAMPLE_RATE),
                    onset: Onset {
                        threshold,
                        min_speech_ms,
                    },
                })
            }
            "stop_playback" => Self::StopPlayback,
            "segment_start" => segment_id_of(&value)
                .map(|segment_id| Self::SegmentStart { segment_id })
                .unwrap_or(Self::Other),
            "segment_end" => segment_id_of(&value)
                .map(|segment_id| Self::SegmentEnd { segment_id })
                .unwrap_or(Self::Other),
            "detached" => Self::Detached {
                reason: value
                    .get("reason")
                    .and_then(|r| r.as_str())
                    .unwrap_or("detached")
                    .to_owned(),
            },
            _ => Self::Other,
        })
    }
}
