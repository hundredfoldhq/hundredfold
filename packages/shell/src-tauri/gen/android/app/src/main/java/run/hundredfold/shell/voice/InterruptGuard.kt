package run.hundredfold.shell.voice

/**
 * Drops audio that is still in flight when the client's own onset detector
 * stops playback. The platform flushes at once, but frames the Rust side had
 * already handed over keep arriving until it processes the barge-in, so the
 * interrupted reply would otherwise start playing again for a moment (and fire
 * the detector a second time). Mirrors the session's rule in the Rust core: the
 * segments seen so far are dropped, and so is anything newer that arrives within
 * [guardMs], which is the same reply still on the wire.
 */
class InterruptGuard(private val guardMs: Long = 400) {
    private var highestSeen = -1
    private var dropThrough = -1
    private var guardUntil = 0L

    /** Playback was stopped by the onset detector at [now] (milliseconds). */
    fun interrupted(now: Long) {
        dropThrough = highestSeen
        guardUntil = now + guardMs
    }

    /** Whether audio for [segmentId], arriving at [now], should play. */
    fun accepts(segmentId: Int, now: Long): Boolean {
        if (segmentId > highestSeen) highestSeen = segmentId
        if (segmentId <= dropThrough) return false
        if (now < guardUntil && dropThrough >= 0) {
            dropThrough = segmentId
            return false
        }
        return true
    }
}
