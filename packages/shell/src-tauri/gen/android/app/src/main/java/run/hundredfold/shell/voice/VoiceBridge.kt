package run.hundredfold.shell.voice

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
import android.util.Log
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
            val granted = missingPermissions(activity).isEmpty()
            Log.i(TAG, "event=voice_permission granted=$granted")
            VoiceNative.nativePermissionResult(granted)
        }

    /** Asks for the microphone and, on Android 13+, notification access. */
    fun requestPermissions() {
        activity.runOnUiThread {
            val missing = missingPermissions(activity)
            Log.i(TAG, "event=voice_permission_request missing=${missing.size}")
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
        val beganAt = SystemClock.elapsedRealtime()
        engineReady = CountDownLatch(1)
        startError = null
        noEngineDrops = 0L
        Log.i(TAG, "event=bridge_start hands_free=$handsFree")
        ContextCompat.startForegroundService(
            context,
            Intent(context, VoiceService::class.java).setAction(VoiceService.ACTION_START),
        )
        // Whatever goes wrong below, the service must not come up late with no session
        // behind it, so a failed start always stops it.
        if (!engineReady!!.await(START_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
            Log.w(TAG, "event=bridge_start_failed reason=timeout timeout_s=$START_TIMEOUT_SECONDS")
            stop()
            throw IllegalStateException("voice service did not start")
        }
        startError?.let {
            Log.w(TAG, "event=bridge_start_failed reason=${it.javaClass.simpleName}")
            stop()
            throw IllegalStateException("voice service failed", it)
        }
        Log.i(TAG, "event=bridge_started ms=${SystemClock.elapsedRealtime() - beganAt}")
    }

    fun configureOnset(threshold: Float, minSpeechMs: Int) {
        pendingOnset = threshold to minSpeechMs
        Log.i(TAG, "event=onset_configured threshold=$threshold min_speech_ms=$minSpeechMs engine_up=${engine != null}")
        engine?.configureOnset(threshold, minSpeechMs)
    }

    fun play(segmentId: Int, pcm: ByteArray) {
        val audio = engine
        if (audio == null) {
            // Powers of two only: frames arrive 50 times a second.
            noEngineDrops += 1
            if ((noEngineDrops and (noEngineDrops - 1)) == 0L) {
                Log.w(TAG, "event=play_dropped reason=no_engine segment=$segmentId bytes=${pcm.size} count=$noEngineDrops")
            }
            return
        }
        audio.play(segmentId, pcm)
    }

    fun segmentEnd(segmentId: Int) {
        engine?.segmentEnd(segmentId)
    }

    /** Loops a sound cue (PCM16LE mono 24 kHz) on its own track; an empty array stops it. */
    fun setCue(pcm: ByteArray) {
        engine?.setCue(pcm)
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
        Log.i(TAG, "event=bridge_stop engine_up=${engine != null}")
        val context = activity.applicationContext
        context.stopService(Intent(context, VoiceService::class.java))
    }

    companion object {
        private const val START_TIMEOUT_SECONDS = 8L
        private const val TAG = VoiceAudio.TAG
        @Volatile private var noEngineDrops = 0L

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
