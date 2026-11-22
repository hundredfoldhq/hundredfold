package run.hundredfold.shell.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OnsetDetectorTest {
    private fun pcm(vararg samples: Int): ByteArray {
        val bytes = ByteArray(samples.size * 2)
        samples.forEachIndexed { i, s ->
            bytes[2 * i] = (s and 0xff).toByte()
            bytes[2 * i + 1] = (s shr 8).toByte()
        }
        return bytes
    }

    @Test
    fun rmsOfSilenceIsZero() {
        assertEquals(0f, OnsetDetector.rms(pcm(0, 0, 0, 0), 8), 0f)
        assertEquals(0f, OnsetDetector.rms(ByteArray(0), 0), 0f)
    }

    @Test
    fun rmsIsNormalisedAndSignIndependent() {
        assertEquals(0.5f, OnsetDetector.rms(pcm(16384, -16384, 16384, -16384), 8), 0.001f)
        assertEquals(1f, OnsetDetector.rms(pcm(-32768, -32768), 4), 0.001f)
    }

    @Test
    fun rmsReadsLittleEndianSamplesAndIgnoresATrailingOddByte() {
        // 0x0100 = 256 little-endian is bytes [0x00, 0x01]; the trailing byte is ignored.
        val bytes = byteArrayOf(0x00, 0x01, 0x7f)
        assertEquals(256f / 32768f, OnsetDetector.rms(bytes, 3), 0.0001f)
    }

    @Test
    fun firesOnlyAfterTheLevelHoldsForMinSpeechMs() {
        val detector = OnsetDetector(threshold = 0.1f, minSpeechMs = 100)
        repeat(4) { assertFalse(detector.feed(0.2f)) } // 80 ms
        assertTrue(detector.feed(0.2f)) // 100 ms
    }

    @Test
    fun aDipBelowTheThresholdRestartsTheHold() {
        val detector = OnsetDetector(threshold = 0.1f, minSpeechMs = 100)
        repeat(4) { detector.feed(0.2f) }
        assertFalse(detector.feed(0.01f))
        repeat(4) { assertFalse(detector.feed(0.2f)) }
        assertTrue(detector.feed(0.2f))
    }

    @Test
    fun theLevelAtTheThresholdCounts() {
        val detector = OnsetDetector(threshold = 0.1f, minSpeechMs = 20)
        assertTrue(detector.feed(0.1f))
    }

    @Test
    fun firesAgainOnlyAfterAnotherFullHold() {
        val detector = OnsetDetector(threshold = 0.1f, minSpeechMs = 40)
        assertFalse(detector.feed(0.5f))
        assertTrue(detector.feed(0.5f))
        assertFalse(detector.feed(0.5f))
        assertTrue(detector.feed(0.5f))
    }

    @Test
    fun configureTakesTheGatewayParametersAndClearsTheHold() {
        val detector = OnsetDetector()
        detector.feed(1f)
        detector.configure(0.3f, 60)
        assertEquals(0.3f, detector.threshold, 0f)
        assertFalse(detector.feed(0.2f))
        assertFalse(detector.feed(0.5f))
        assertFalse(detector.feed(0.5f))
        assertTrue(detector.feed(0.5f))
    }
}
