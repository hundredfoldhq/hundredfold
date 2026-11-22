package run.hundredfold.shell

/** What the system Back button does in the main activity. */
enum class BackAction {
  /** The page has an in-app history entry: step back inside the web app. */
  PAGE_BACK,

  /** At the app root: send the task to the background and keep the process alive. */
  MOVE_TO_BACKGROUND,
}

/**
 * Back never finishes the activity. Finishing it tears the Rust runtime down while
 * its worker threads are still running, which aborts the whole process (a destroyed
 * mutex), and drops every socket and in-memory state with it.
 */
fun backAction(pageCanGoBack: Boolean): BackAction =
  if (pageCanGoBack) BackAction.PAGE_BACK else BackAction.MOVE_TO_BACKGROUND
