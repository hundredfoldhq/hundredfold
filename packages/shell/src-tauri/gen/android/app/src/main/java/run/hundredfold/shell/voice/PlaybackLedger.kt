package run.hundredfold.shell.voice

/**
 * Accounts for which segment is under the playback head, so the client can say
 * how much of a segment played before a barge-in and report each segment that
 * played in full. Positions are frames written to the output since the last
 * flush; the caller passes the track's head position relative to that point.
 */
class PlaybackLedger(private val sampleRate: Int) {
    private class Segment(val id: Int, val startFrame: Long) {
        var endFrame: Long = startFrame
        var ended = false
    }

    private val segments = ArrayDeque<Segment>()
    private var written = 0L

    /** Appends `frames` of audio for `segmentId`. */
    fun write(segmentId: Int, frames: Int) {
        val last = segments.lastOrNull()
        val segment = if (last != null && last.id == segmentId && !last.ended) {
            last
        } else {
            Segment(segmentId, written).also { segments.addLast(it) }
        }
        written += frames
        segment.endFrame = written
    }

    /**
     * The gateway sent the segment's last frame. A segment that had no audio is
     * recorded as already complete, so it is still reported played.
     */
    fun end(segmentId: Int) {
        val segment = segments.lastOrNull { it.id == segmentId }
        if (segment != null) {
            segment.ended = true
        } else {
            segments.addLast(Segment(segmentId, written).also { it.ended = true })
        }
    }

    /** True while audio written to the output has not finished playing. */
    fun isPlaying(head: Long): Boolean = head < written

    /** Frames written and not yet played, for diagnostics. */
    fun pendingFrames(head: Long): Long = (written - head).coerceAtLeast(0)

    /** The newest segment the gateway has not finished sending, for diagnostics. */
    fun openSegmentId(): Int? = segments.lastOrNull()?.takeIf { !it.ended }?.id

    /** The segment under the head, or null when nothing is playing. */
    fun currentSegment(head: Long): Int? =
        if (head >= written) null else segments.firstOrNull { head < it.endFrame }?.id

    /** Milliseconds of the current segment that have played. */
    fun playedMs(head: Long): Long {
        val segment = segments.firstOrNull { head < it.endFrame } ?: return 0
        return (head - segment.startFrame).coerceAtLeast(0) * 1000 / sampleRate
    }

    /** Removes and returns the ids of segments that ended and have fully played. */
    fun completed(head: Long): List<Int> {
        val done = ArrayList<Int>()
        while (true) {
            val first = segments.firstOrNull() ?: break
            if (!first.ended || head < first.endFrame) break
            done.add(first.id)
            segments.removeFirst()
        }
        return done
    }

    /** Playback was flushed: forget everything. */
    fun reset() {
        segments.clear()
        written = 0
    }
}
