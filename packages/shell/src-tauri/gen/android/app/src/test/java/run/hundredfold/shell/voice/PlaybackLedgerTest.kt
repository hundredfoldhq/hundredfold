package run.hundredfold.shell.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PlaybackLedgerTest {
    private val rate = 24_000

    @Test
    fun reportsTheSegmentUnderTheHeadAndHowMuchOfItPlayed() {
        val ledger = PlaybackLedger(rate)
        ledger.write(1, 24_000) // 1 s
        ledger.write(2, 12_000) // 0.5 s
        assertEquals(1, ledger.currentSegment(0))
        assertEquals(500L, ledger.playedMs(12_000))
        assertEquals(1, ledger.currentSegment(23_999))
        assertEquals(2, ledger.currentSegment(24_000))
        assertEquals(250L, ledger.playedMs(24_000 + 6_000))
        assertNull(ledger.currentSegment(36_000))
    }

    @Test
    fun framesForTheSameSegmentJoinOneSegment() {
        val ledger = PlaybackLedger(rate)
        ledger.write(7, 480)
        ledger.write(7, 480)
        assertEquals(7, ledger.currentSegment(900))
        assertEquals(39L, ledger.playedMs(959)) // 959 frames at 24 kHz is just under 40 ms
    }

    @Test
    fun isPlayingUntilTheHeadReachesTheEndOfTheWrittenAudio() {
        val ledger = PlaybackLedger(rate)
        assertFalse(ledger.isPlaying(0))
        ledger.write(1, 100)
        assertTrue(ledger.isPlaying(99))
        assertFalse(ledger.isPlaying(100))
    }

    @Test
    fun aSegmentCompletesOnlyOnceItEndedAndFullyPlayed() {
        val ledger = PlaybackLedger(rate)
        ledger.write(1, 100)
        assertEquals(emptyList<Int>(), ledger.completed(100)) // played but the gateway has not ended it
        ledger.end(1)
        assertEquals(emptyList<Int>(), ledger.completed(99))
        assertEquals(listOf(1), ledger.completed(100))
        assertEquals(emptyList<Int>(), ledger.completed(200)) // reported once
    }

    @Test
    fun segmentsCompleteInOrder() {
        val ledger = PlaybackLedger(rate)
        ledger.write(1, 100)
        ledger.write(2, 100)
        ledger.end(2)
        // Segment 1 is not ended yet, so it holds back segment 2.
        assertEquals(emptyList<Int>(), ledger.completed(200))
        ledger.end(1)
        assertEquals(listOf(1, 2), ledger.completed(200))
    }

    @Test
    fun resetForgetsEverythingSoAFlushedSegmentIsNeverReportedPlayed() {
        val ledger = PlaybackLedger(rate)
        ledger.write(1, 100)
        ledger.end(1)
        ledger.reset()
        assertFalse(ledger.isPlaying(0))
        assertNull(ledger.currentSegment(0))
        assertEquals(emptyList<Int>(), ledger.completed(1_000))
        // New audio starts again from frame zero.
        ledger.write(2, 50)
        assertEquals(2, ledger.currentSegment(0))
    }

    @Test
    fun aSegmentEndedBeforeItsAudioPlayedStillCompletesOnceItHas() {
        val ledger = PlaybackLedger(rate)
        // The gateway runs ahead: everything is queued and ended long before it plays.
        ledger.write(4, 1_000)
        ledger.end(4)
        ledger.write(5, 1_000)
        ledger.end(5)
        assertEquals(emptyList<Int>(), ledger.completed(500))
        assertEquals(listOf(4), ledger.completed(1_000))
        assertEquals(listOf(5), ledger.completed(2_000))
    }

    @Test
    fun aSegmentWithNoAudioIsReportedPlayedOnceTheHeadReachesIt() {
        val ledger = PlaybackLedger(rate)
        ledger.write(1, 100)
        ledger.end(1)
        ledger.end(2) // no audio was ever written for 2
        assertEquals(listOf(1, 2), ledger.completed(100))
    }
}
