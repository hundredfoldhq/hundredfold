package run.hundredfold.shell.voice

import kotlin.math.sqrt

/**
 * The client's playback-stopping onset detector: RMS over 20 ms frames, fired
 * once the level has held at or above the threshold for `minSpeechMs`. The
 * parameters come from the gateway's `ready.onset`; the gateway's own VAD does
 * the real speech detection and can stop playback too.
 */
class OnsetDetector(
    var threshold: Float = 0.05f,
    var minSpeechMs: Int = 200,
    private val frameMs: Int = 20,
) {
    /** How long the level has held at or above the threshold so far; read for diagnostics. */
    var heldMs = 0
        private set

    fun configure(threshold: Float, minSpeechMs: Int) {
        this.threshold = threshold
        this.minSpeechMs = minSpeechMs
        heldMs = 0
    }

    /** Feed one frame's level; true when speech has held long enough. */
    fun feed(level: Float): Boolean {
        heldMs = if (level >= threshold) heldMs + frameMs else 0
        if (heldMs >= minSpeechMs) {
            heldMs = 0
            return true
        }
        return false
    }

    fun reset() {
        heldMs = 0
    }

    companion object {
        /** RMS of PCM16LE mono samples, normalised to 0..1. */
        fun rms(pcm: ByteArray, length: Int): Float {
            val samples = length / 2
            if (samples == 0) return 0f
            var sum = 0.0
            for (i in 0 until samples) {
                val lo = pcm[2 * i].toInt() and 0xff
                val hi = pcm[2 * i + 1].toInt()
                val sample = (hi shl 8) or lo
                sum += sample.toDouble() * sample.toDouble()
            }
            return (sqrt(sum / samples) / 32768.0).toFloat()
        }
    }
}
