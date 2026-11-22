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
    // BACK at the app root, once the page has no history left, goes here. While voice
    // runs the session outlives the UI: move the task to the background instead of
    // finishing the activity. Otherwise behave as before.
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
