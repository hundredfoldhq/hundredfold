package run.hundredfold.shell

import android.os.Bundle
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
  }
}
