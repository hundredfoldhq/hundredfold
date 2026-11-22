package run.hundredfold.shell.voice

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InterruptGuardTest {
    @Test
    fun playsEverythingUntilAnInterruption() {
        val guard = InterruptGuard()
        assertTrue(guard.accepts(1, 0))
        assertTrue(guard.accepts(2, 10))
    }

    @Test
    fun dropsTheInterruptedSegmentsEvenLate() {
        val guard = InterruptGuard(guardMs = 400)
        guard.accepts(1, 0)
        guard.accepts(2, 100)
        guard.interrupted(now = 200)
        assertFalse(guard.accepts(2, 250))
        assertFalse(guard.accepts(1, 10_000))
    }

    @Test
    fun dropsAnewerSegmentAlreadyOnTheWireInsideTheWindow() {
        val guard = InterruptGuard(guardMs = 400)
        guard.accepts(1, 0)
        guard.interrupted(now = 100)
        assertFalse(guard.accepts(2, 150)) // part of the same reply, in flight
        assertFalse(guard.accepts(2, 10_000)) // and it stays dropped
    }

    @Test
    fun aNewReplyAfterTheWindowPlays() {
        val guard = InterruptGuard(guardMs = 400)
        guard.accepts(1, 0)
        guard.interrupted(now = 100)
        assertTrue(guard.accepts(3, 100 + 401))
        assertTrue(guard.accepts(3, 100 + 500))
    }

    @Test
    fun anInterruptionBeforeAnyAudioDropsNothing() {
        val guard = InterruptGuard()
        guard.interrupted(now = 0)
        assertTrue(guard.accepts(1, 10))
    }
}
