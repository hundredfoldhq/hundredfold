package run.hundredfold.shell.voice

/**
 * The JNI surface of native voice. The `native*` functions are implemented in
 * Rust (`src/android.rs`); audio frames and events go straight there and never
 * through the WebView.
 */
object VoiceNative {
    init {
        // Already loaded by the Tauri activity; loading again is a no-op, and it
        // lets unit tests and the service resolve the symbols on their own.
        System.loadLibrary("hundredfold_shell_lib")
    }

    /** Hands Rust the bridge it calls to start, play, flush and stop. */
    @JvmStatic external fun nativeRegister(bridge: VoiceBridge)

    /** One block of captured PCM16LE mono at 16 kHz. */
    @JvmStatic external fun nativeCapture(frame: ByteArray, length: Int)

    /** The onset detector fired over playback; playback is already stopped. */
    @JvmStatic external fun nativeOnset(segmentId: Long, playedMs: Long)

    /** A segment finished playing in full. */
    @JvmStatic external fun nativePlayed(segmentId: Long)

    /** Stop from the notification. */
    @JvmStatic external fun nativeStopRequested(reason: String)

    /** Audio focus was lost to, or returned from, a call or another app. */
    @JvmStatic external fun nativeInterruption(began: Boolean, suspendedMs: Long)

    @JvmStatic external fun nativePermissionResult(granted: Boolean)
}
