package run.hundredfold.shell

import org.junit.Assert.assertEquals
import org.junit.Test

class BackActionTest {
    @Test
    fun stepsBackInsideThePageWhileItHasHistory() {
        assertEquals(BackAction.PAGE_BACK, backAction(pageCanGoBack = true))
    }

    @Test
    fun movesTheTaskToTheBackgroundAtTheRoot() {
        assertEquals(BackAction.MOVE_TO_BACKGROUND, backAction(pageCanGoBack = false))
    }
}
