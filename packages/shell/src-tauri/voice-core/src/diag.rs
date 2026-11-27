//! One-line diagnostic events for the native voice path.
//!
//! Every line reads `event=<snake_case_name> key=value key=value` and uses the same key
//! names as the Swift and Kotlin audio code (`segment_id`, `seq`, `bytes`, `frames`, `ms`,
//! `rms`, `threshold`, `reason`, `code`), so one timeline can be read across all three.
//! Lines never carry transcripts, reply text, credentials or URLs: only ids, counts, sizes
//! and timings.
//!
//! Levels: `warn` for something that is wrong, `info` for lifecycle and per-segment
//! summaries (the default), `debug` for per-frame detail. Debug lines are dropped unless
//! this is a debug build or `HF_VOICE_LOG=debug` is set in the environment.
//!
//! Lines go to stderr by default. A host that has a better place for them (iOS, where the
//! stderr redirect only logs in debug builds) installs a [`Sink`] with [`set_sink`].

use std::{fmt, sync::OnceLock};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Debug,
    Info,
    Warn,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Warn => "warn",
        }
    }
}

/// Receives one finished line (no trailing newline).
pub type Sink = fn(Level, &str);

static SINK: OnceLock<Sink> = OnceLock::new();
static DEBUG: OnceLock<bool> = OnceLock::new();

/// Routes every later line to `sink`. Only the first call has any effect.
pub fn set_sink(sink: Sink) {
    let _ = SINK.set(sink);
}

pub fn debug_enabled() -> bool {
    *DEBUG.get_or_init(|| {
        cfg!(debug_assertions)
            || std::env::var("HF_VOICE_LOG").is_ok_and(|value| value.eq_ignore_ascii_case("debug"))
    })
}

pub fn emit(level: Level, args: fmt::Arguments<'_>) {
    if level == Level::Debug && !debug_enabled() {
        return;
    }
    let line = args.to_string();
    match SINK.get() {
        Some(sink) => sink(level, &line),
        None => eprintln!("hf_voice {} {line}", level.as_str()),
    }
}

#[macro_export]
macro_rules! diag_debug {
    ($($arg:tt)*) => {
        $crate::diag::emit($crate::diag::Level::Debug, format_args!($($arg)*))
    };
}

#[macro_export]
macro_rules! diag_info {
    ($($arg:tt)*) => {
        $crate::diag::emit($crate::diag::Level::Info, format_args!($($arg)*))
    };
}

#[macro_export]
macro_rules! diag_warn {
    ($($arg:tt)*) => {
        $crate::diag::emit($crate::diag::Level::Warn, format_args!($($arg)*))
    };
}
