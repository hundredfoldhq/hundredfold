//! Soft sound cues for the native voice client: which one should sound now, and
//! the audio for it.
//!
//! Mirrors `packages/web/src/lib/voice/cues.ts`, which is the reference: the
//! recipe (patterns, envelope, level) and the rules must match, so the web app
//! and the mobile app sound and behave alike. The session decides from the
//! gateway's own `turn`, `vad` and `background` frames; the platform audio code
//! only loops what it is handed on a channel of its own, never through the
//! speech player, so a cue never arms the barge-in detector.

use crate::protocol::OUTPUT_SAMPLE_RATE;

/// The sounds. Never both at once, and never over speech.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cue {
    /// One soft tick about once a second, while the model works and nothing is spoken yet.
    Thinking,
    /// A quicker, higher tick-tick about every 1.3 seconds, while a tool runs.
    Tool,
}

/// `ready.cues`. A gateway that predates cues sends none: the defaults then apply.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CueSettings {
    pub enabled: bool,
    /// 0 to 1.
    pub volume: f32,
}

impl Default for CueSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            volume: 0.3,
        }
    }
}

/// The gateway's turn state (`turn` frame).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Turn {
    Idle,
    Thinking,
    Working,
    Speaking,
}

impl Turn {
    pub fn parse(state: &str) -> Option<Self> {
        match state {
            "idle" => Some(Self::Idle),
            "thinking" => Some(Self::Thinking),
            "working" => Some(Self::Working),
            "speaking" => Some(Self::Speaking),
            _ => None,
        }
    }
}

/// Everything the choice depends on.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CueInputs {
    pub settings: CueSettings,
    /// Voice mode is running and not paused by a call or another app.
    pub running: bool,
    pub turn: Turn,
    /// The user is being heard: voice activity, a live partial transcript, or push-to-talk held.
    pub hearing: bool,
    /// The assistant's speech (a reply or a holding line) is audible or about to be.
    pub speech_audible: bool,
    /// The tool the turn is on was moved to the background.
    pub tool_backgrounded: bool,
}

/// Which cue should sound now, or `None`.
///
/// A `thinking` turn gets the thinking cue and a `working` turn the tool cue, until
/// the tool is moved to the background: the work then belongs to the background
/// chip and the assistant is free to answer, so the thinking cue takes over until
/// the turn ends. Background work that outlives the turn is silent. Nothing sounds
/// while speech is audible, while the user is heard, or when cues are off.
pub fn wanted(input: &CueInputs) -> Option<Cue> {
    if !input.settings.enabled || input.settings.volume <= 0.0 || !input.running {
        return None;
    }
    if input.hearing || input.speech_audible {
        return None;
    }
    match input.turn {
        Turn::Thinking => Some(Cue::Thinking),
        Turn::Working if input.tool_backgrounded => Some(Cue::Thinking),
        Turn::Working => Some(Cue::Tool),
        Turn::Idle | Turn::Speaking => None,
    }
}

/// A cue and the volume to play it at.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CueRequest {
    pub cue: Cue,
    pub volume: f32,
}

/// Loudest a tick gets (volume 1), as a share of full scale: about -14 dBFS.
/// The default volume gives about -24 dBFS.
pub const CUE_PEAK: f32 = 0.2;

/// Weight of the second harmonic, which keeps a tick audible on a phone speaker without making it sharp.
const HARMONIC: f64 = 0.25;

struct Blip {
    at_ms: u32,
    dur_ms: u32,
    hz: f64,
}

struct Pattern {
    loop_ms: u32,
    blips: &'static [Blip],
}

/// The first tick comes `at_ms` after the cue starts, so a short pause in the work makes no sound at all.
fn pattern(cue: Cue) -> Pattern {
    match cue {
        Cue::Thinking => Pattern {
            loop_ms: 1100,
            blips: &[Blip {
                at_ms: 300,
                dur_ms: 50,
                hz: 560.0,
            }],
        },
        Cue::Tool => Pattern {
            loop_ms: 1300,
            blips: &[
                Blip {
                    at_ms: 300,
                    dur_ms: 35,
                    hz: 880.0,
                },
                Blip {
                    at_ms: 390,
                    dur_ms: 35,
                    hz: 880.0,
                },
            ],
        },
    }
}

fn samples_of(ms: u32, rate: u32) -> usize {
    ((f64::from(ms) * f64::from(rate)) / 1000.0).round() as usize
}

/// One loop of a cue as mono floats with a peak of at most 1. Every tick is a
/// sine with a raised-cosine envelope, so it starts and ends at zero.
pub fn render_unit_loop(cue: Cue, sample_rate: u32) -> Vec<f32> {
    let pattern = pattern(cue);
    let mut out = vec![0f32; samples_of(pattern.loop_ms, sample_rate)];
    for blip in pattern.blips {
        let start = samples_of(blip.at_ms, sample_rate);
        let length = samples_of(blip.dur_ms, sample_rate);
        for i in 0..length {
            if start + i >= out.len() {
                break;
            }
            let t = i as f64 / f64::from(sample_rate);
            let window = (std::f64::consts::PI * i as f64 / length as f64)
                .sin()
                .powi(2);
            let tone = (2.0 * std::f64::consts::PI * blip.hz * t).sin()
                + HARMONIC * (4.0 * std::f64::consts::PI * blip.hz * t).sin();
            out[start + i] += (window * tone / (1.0 + HARMONIC)) as f32;
        }
    }
    out
}

/// One loop of a cue at `volume`, as PCM16LE mono at the gateway's output rate (24 kHz): what the
/// platform loops. The level is `CUE_PEAK * volume`, baked in.
pub fn render_loop(cue: Cue, volume: f32) -> Vec<u8> {
    let gain = CUE_PEAK * volume.clamp(0.0, 1.0);
    let mut bytes = Vec::new();
    for sample in render_unit_loop(cue, OUTPUT_SAMPLE_RATE) {
        let value = (sample * gain * 32767.0).round().clamp(-32768.0, 32767.0) as i16;
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(turn: Turn) -> CueInputs {
        CueInputs {
            settings: CueSettings::default(),
            running: true,
            turn,
            hearing: false,
            speech_audible: false,
            tool_backgrounded: false,
        }
    }

    #[test]
    fn each_turn_state_wants_its_cue() {
        assert_eq!(wanted(&input(Turn::Idle)), None);
        assert_eq!(wanted(&input(Turn::Speaking)), None);
        assert_eq!(wanted(&input(Turn::Thinking)), Some(Cue::Thinking));
        assert_eq!(wanted(&input(Turn::Working)), Some(Cue::Tool));
    }

    #[test]
    fn nothing_sounds_when_off_silent_or_not_running() {
        let mut off = input(Turn::Thinking);
        off.settings.enabled = false;
        assert_eq!(wanted(&off), None);
        let mut silent = input(Turn::Thinking);
        silent.settings.volume = 0.0;
        assert_eq!(wanted(&silent), None);
        let mut paused = input(Turn::Thinking);
        paused.running = false;
        assert_eq!(wanted(&paused), None);
    }

    #[test]
    fn nothing_sounds_while_the_user_is_heard_or_speech_is_audible() {
        let mut heard = input(Turn::Working);
        heard.hearing = true;
        assert_eq!(wanted(&heard), None);
        let mut spoken = input(Turn::Thinking);
        spoken.speech_audible = true;
        assert_eq!(wanted(&spoken), None);
    }

    #[test]
    fn a_backgrounded_tool_hands_over_to_the_thinking_cue() {
        let mut moved = input(Turn::Working);
        moved.tool_backgrounded = true;
        assert_eq!(wanted(&moved), Some(Cue::Thinking));
    }

    #[test]
    fn a_loop_has_the_declared_length_and_a_peak_under_the_level() {
        for (cue, ms) in [(Cue::Thinking, 1100usize), (Cue::Tool, 1300)] {
            let pcm = render_loop(cue, 1.0);
            assert_eq!(pcm.len(), ms * 24 * 2);
            let peak = pcm
                .chunks_exact(2)
                .map(|b| i16::from_le_bytes([b[0], b[1]]).unsigned_abs())
                .max()
                .unwrap();
            let ceiling = (CUE_PEAK * 32767.0) as u16;
            assert!(peak <= ceiling, "{peak} > {ceiling}");
            assert!(peak > ceiling / 2, "{peak} is too quiet for {cue:?}");
        }
    }

    #[test]
    fn the_default_volume_is_quiet_and_zero_is_silent() {
        let quiet = render_loop(Cue::Thinking, 0.3);
        let peak = quiet
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]).unsigned_abs())
            .max()
            .unwrap();
        assert!(f32::from(peak) / 32767.0 < 0.065, "default peak {peak}");
        assert!(render_loop(Cue::Tool, 0.0).iter().all(|b| *b == 0));
    }

    #[test]
    fn the_first_tick_comes_after_its_lead_and_ticks_fade_in_and_out() {
        for cue in [Cue::Thinking, Cue::Tool] {
            let loop_ = render_unit_loop(cue, 24_000);
            let lead = samples_of(300, 24_000);
            assert!(loop_[..lead].iter().all(|s| *s == 0.0));
            assert_eq!(loop_[lead], 0.0);
            let first = loop_.iter().position(|s| *s != 0.0).unwrap();
            let last = loop_.iter().rposition(|s| *s != 0.0).unwrap();
            assert!(loop_[first].abs() < 0.01 && loop_[last].abs() < 0.01);
            let active = loop_.iter().filter(|s| **s != 0.0).count();
            assert!((active as f32 / loop_.len() as f32) < 0.15);
        }
    }

    /// The same samples the web synthesiser (`cues.ts`) makes at 24 kHz, so the two apps sound alike.
    /// `packages/web/src/lib/voice/__tests__/cues.test.ts` holds the same table.
    #[test]
    fn it_renders_the_same_samples_as_the_web_synthesiser() {
        let table: [(Cue, &[(usize, f32)]); 2] = [
            (
                Cue::Thinking,
                &[
                    (7313, -0.034656),
                    (7421, 0.254384),
                    (7633, 0.555066),
                    (7907, 0.007738),
                    (8051, -0.515088),
                ],
            ),
            (
                Cue::Tool,
                &[
                    (7333, -0.172966),
                    (7457, 0.138743),
                    (7601, -0.651875),
                    (9411, -0.028135),
                    (9533, 0.175136),
                    (9777, 0.67843),
                ],
            ),
        ];
        for (cue, samples) in table {
            let loop_ = render_unit_loop(cue, 24_000);
            for (index, expected) in samples {
                assert!(
                    (loop_[*index] - expected).abs() < 1e-5,
                    "{cue:?}[{index}] = {} vs {expected}",
                    loop_[*index]
                );
            }
        }
    }

    #[test]
    fn the_two_cues_differ_in_length_and_in_number_of_ticks() {
        let thinking = render_unit_loop(Cue::Thinking, 24_000);
        let tool = render_unit_loop(Cue::Tool, 24_000);
        assert_ne!(thinking.len(), tool.len());
        let ticks = |v: &[f32]| v.windows(2).filter(|w| w[0] == 0.0 && w[1] != 0.0).count();
        assert!(ticks(&tool) > ticks(&thinking));
    }
}
