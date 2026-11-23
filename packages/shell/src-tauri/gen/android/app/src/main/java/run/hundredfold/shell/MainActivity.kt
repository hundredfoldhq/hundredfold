package run.hundredfold.shell

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import run.hundredfold.shell.voice.VoiceBridge
import run.hundredfold.shell.voice.VoiceNative

class MainActivity : TauriActivity() {
  private var voiceBridge: VoiceBridge? = null
  private var webView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Native voice mode: Rust drives audio through this bridge (see src/android.rs).
    voiceBridge = VoiceBridge(this).also { VoiceNative.nativeRegister(it) }
    // TauriActivity turns off the wrapper's own Back handling, so handle it here: step
    // back through the page's history, and at the root move the task to the background
    // instead of finishing the activity (which aborts the process; see BackAction).
    // This also keeps a running voice session alive, since the process survives.
    onBackPressedDispatcher.addCallback(
      this,
      object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
          val page = webView
          when (backAction(page?.canGoBack() == true)) {
            BackAction.PAGE_BACK -> page?.goBack()
            BackAction.MOVE_TO_BACKGROUND -> moveTaskToBack(true)
          }
        }
      },
    )
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
  }
}
