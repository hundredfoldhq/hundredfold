package run.hundredfold.shell.voice

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * What Rust calls. One instance is created with the activity and registered
 * with [VoiceNative.nativeRegister]; Rust then drives the permission prompt,
 * the foreground service and the audio engine through it, from its own
 * threads. Calls are cheap hand-offs, never JavaScript.
 */
class VoiceBridge(private val activity: ComponentActivity) {
    private val permissionLauncher =
        activity.registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
            VoiceNative.nativePermissionResult(missingPermissions(activity).isEmpty())
        }

    /** Asks for the microphone and, on Android 13+, notification access. */
    fun requestPermissions() {
        activity.runOnUiThread {
            val missing = missingPermissions(activity)
            if (missing.isEmpty()) {
                VoiceNative.nativePermissionResult(true)
            } else {
                permissionLauncher.launch(missing.toTypedArray())
            }
        }
    }

    /**
     * Starts the foreground service and waits for its audio engine, so a start
     * that cannot work (microphone busy, service refused) fails here.
     */
    fun start(@Suppress("UNUSED_PARAMETER") handsFree: Boolean) {
        val context = activity.applicationContext
        engineReady = CountDownLatch(1)
        startError = null
        ContextCompat.startForegroundService(
            context,
            Intent(context, VoiceService::class.java).setAction(VoiceService.ACTION_START),
        )
        // Whatever goes wrong below, the service must not come up late with no session
        // behind it, so a failed start always stops it.
        if (!engineReady!!.await(START_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
            stop()
            throw IllegalStateException("voice service did not start")
        }
        startError?.let {
            stop()
            throw IllegalStateException("voice service failed", it)
        }
    }

    fun configureOnset(threshold: Float, minSpeechMs: Int) {
        pendingOnset = threshold to minSpeechMs
        engine?.configureOnset(threshold, minSpeechMs)
    }

    fun play(segmentId: Int, pcm: ByteArray) {
        engine?.play(segmentId, pcm)
    }

    fun segmentEnd(segmentId: Int) {
        engine?.segmentEnd(segmentId)
    }

    fun flush() {
        engine?.flush()
    }

    fun pause() {
        engine?.pause()
    }

    fun resume() {
        engine?.resume()
    }

    fun stop() {
        val context = activity.applicationContext
        context.stopService(Intent(context, VoiceService::class.java))
    }

    companion object {
        private const val START_TIMEOUT_SECONDS = 8L

        @Volatile private var engine: VoiceAudio? = null
        @Volatile private var engineReady: CountDownLatch? = null
        @Volatile private var startError: Throwable? = null
        @Volatile private var pendingOnset: Pair<Float, Int>? = null

        /** True while a voice session's audio engine is up. */
        val isRunning: Boolean get() = engine != null

        /** The service's engine is up. */
        internal fun attach(audio: VoiceAudio) {
            pendingOnset?.let { (threshold, minSpeechMs) -> audio.configureOnset(threshold, minSpeechMs) }
            engine = audio
            engineReady?.countDown()
        }

        internal fun startFailed(error: Throwable) {
            startError = error
            engineReady?.countDown()
        }

        internal fun detach(audio: VoiceAudio?) {
            if (audio != null && engine === audio) engine = null
            pendingOnset = null
        }

        fun missingPermissions(context: Context): List<String> {
            val needed = buildList {
                add(Manifest.permission.RECORD_AUDIO)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) add(Manifest.permission.POST_NOTIFICATIONS)
            }
            return needed.filter {
                ContextCompat.checkSelfPermission(context, it) != PackageManager.PERMISSION_GRANTED
            }
        }
    }
}
