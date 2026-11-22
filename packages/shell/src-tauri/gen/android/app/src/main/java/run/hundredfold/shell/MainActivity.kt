package run.hundredfold.shell

import android.os.Bundle
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import run.hundredfold.shell.voice.VoiceBridge
import run.hundredfold.shell.voice.VoiceNative

class MainActivity : TauriActivity() {
  private var voiceBridge: VoiceBridge? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Native voice mode: Rust drives audio through this bridge (see src/android.rs).
    voiceBridge = VoiceBridge(this).also { VoiceNative.nativeRegister(it) }
    // This callback is registered last, so it sees BACK before the webview's own
    // handling, whatever the page history holds. While voice runs the session outlives
    // the UI: move the task to the background instead of navigating back or finishing
    // the activity. Otherwise hand BACK to the default onBackPressed (page history,
    // then finish) by switching this callback off for the call.
    onBackPressedDispatcher.addCallback(
      this,
      object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
          if (VoiceBridge.isRunning) {
            moveTaskToBack(true)
          } else {
            isEnabled = false
            this@MainActivity.onBackPressed()
            isEnabled = true
          }
        }
      },
    )
  }
}
