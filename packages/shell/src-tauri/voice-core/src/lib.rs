//! Platform-independent core of the native voice client.
//!
//! The Tauri shell runs voice mode natively so it keeps working with the screen
//! locked: capture, playback and the gateway socket never pass through the
//! WebView. This crate holds everything about that loop that does not touch an
//! operating system: the wire frames of `/ws/voice/:sessionId`, the bridge
//! between platform audio and those frames, and a deterministic state machine
//! ([`session::Session`]) that turns events into actions. It has no dependency
//! on Tauri, so its tests run on any host.
//!
//! Contracts: `specs/009-voice-mode/contracts/voice-socket.md` and
//! `specs/009-voice-mode/contracts/native-voice.md`.

pub mod audio;
pub mod cues;
pub mod diag;
pub mod protocol;
pub mod session;
