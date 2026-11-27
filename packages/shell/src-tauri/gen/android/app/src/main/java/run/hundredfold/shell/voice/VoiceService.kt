package run.hundredfold.shell.voice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.AudioRecordingConfiguration
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import run.hundredfold.shell.MainActivity
import run.hundredfold.shell.R
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Foreground service of type `microphone` that owns voice mode's audio while
 * the screen is locked or the app is in the background. Its ongoing
 * notification says voice mode is on and carries the Stop action. It holds a
 * partial wake lock and a Wi-Fi lock so the socket and audio threads keep
 * running with the screen off.
 */
class VoiceService : Service() {
    private var audio: VoiceAudio? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var focusRequest: AudioFocusRequest? = null
    private var interruptedAt = 0L
    private val handler = Handler(Looper.getMainLooper())
    private var deviceCallback: AudioDeviceCallback? = null
    private var recordingCallback: AudioManager.AudioRecordingCallback? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.i(TAG, "event=service_command action=${intent?.action ?: "none"} start_id=$startId has_audio=${audio != null}")
        when (intent?.action) {
            ACTION_STOP -> {
                // Rust ends the session and calls back into VoiceBridge.stop(). If
                // no session is running (a stale notification), stop on our own.
                VoiceNative.nativeStopRequested("notification")
                handler.postDelayed({ stopSelf() }, STOP_FALLBACK_MS)
                return START_NOT_STICKY
            }
            else -> begin()
        }
        return START_NOT_STICKY
    }

    private fun begin() {
        val beganAt = SystemClock.elapsedRealtime()
        ensureChannel()
        val notification = buildNotification()
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0
        if (audio != null) {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type)
            return
        }
        try {
            // Inside the try: the system can refuse a microphone foreground service
            // (permission revoked, started from the background), and that is a failed
            // start for the caller, not a crash.
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type)
            acquireLocks()
            requestFocus()
            val engine = VoiceAudio()
            engine.start()
            audio = engine
            VoiceBridge.attach(engine)
            // Diagnostics only: nothing here may fail a session whose audio is already up.
            runCatching { watchDevices() }
            runCatching { Log.i(TAG, "event=service_audio_started ms=${SystemClock.elapsedRealtime() - beganAt} ${audioManagerState()}") }
        } catch (error: Throwable) {
            Log.w(TAG, "event=service_start_failed ms=${SystemClock.elapsedRealtime() - beganAt} error=${error.javaClass.simpleName}")
            Log.e(VoiceAudio.TAG, "voice service could not start audio", error)
            VoiceBridge.startFailed(error)
            stopSelf()
        }
    }

    // The task was removed from recents: end the session cleanly (bye, close 1000)
    // instead of letting the process die with the socket open.
    override fun onTaskRemoved(rootIntent: Intent?) {
        Log.i(TAG, "event=task_removed")
        VoiceNative.nativeStopRequested("task_removed")
        handler.postDelayed({ stopSelf() }, STOP_FALLBACK_MS)
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        Log.i(TAG, "event=service_destroy has_audio=${audio != null} interrupted=${interruptedAt != 0L}")
        VoiceBridge.detach(audio)
        audio?.stop()
        audio = null
        abandonFocus()
        releaseLocks()
        // Logging only: a failure here must not stop the teardown above or below it.
        runCatching { unwatchDevices() }
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    // ── notification ─────────────────────────────────────────────────────────

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        // Default importance, silenced: low-importance ("silent") notifications can be
        // hidden from the lock screen by a user setting, and the lock screen is where
        // this control has to be.
        val channel = NotificationChannel(CHANNEL_ID, "Voice mode", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "Shown while Hundredfold voice mode is listening"
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            setSound(null, null)
            enableVibration(false)
            enableLights(false)
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val stop = PendingIntent.getService(
            this,
            1,
            Intent(this, VoiceService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_voice_notification)
            .setContentTitle("Voice mode on")
            .setContentText("Hundredfold is listening")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setContentIntent(open)
            .addAction(0, "Stop", stop)
            .build()
    }

    // ── keep running with the screen off ─────────────────────────────────────

    private fun acquireLocks() {
        val power = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "hundredfold:voice").apply {
            setReferenceCounted(false)
            acquire(MAX_SESSION_MS)
        }
        val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            WifiManager.WIFI_MODE_FULL_LOW_LATENCY
        } else {
            @Suppress("DEPRECATION")
            WifiManager.WIFI_MODE_FULL_HIGH_PERF
        }
        wifiLock = wifi?.createWifiLock(mode, "hundredfold:voice")?.apply {
            setReferenceCounted(false)
            acquire()
        }
        Log.i(TAG, "event=locks_acquired wake=${wakeLock?.isHeld == true} wifi=${wifiLock?.isHeld == true} wifi_mode=$mode")
    }

    private fun releaseLocks() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wifiLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        wifiLock = null
    }

    // ── audio focus: calls and other apps pause voice mode, then it resumes ──

    private fun requestFocus() {
        val manager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            .setOnAudioFocusChangeListener { change ->
                Log.i(TAG, "event=audio_focus_change change=${focusName(change)} interrupted=${interruptedAt != 0L}")
                when (change) {
                    // Another app took the audio for good (music, a video): no GAIN will
                    // follow, so voice mode ends instead of sitting paused behind a
                    // notification that still says it is listening.
                    AudioManager.AUDIOFOCUS_LOSS -> VoiceNative.nativeStopRequested("focus_lost")
                    // A call or assistant: pause now, resume when focus comes back.
                    AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
                    -> if (interruptedAt == 0L) {
                        interruptedAt = SystemClock.elapsedRealtime()
                        VoiceNative.nativeInterruption(true, 0)
                    }
                    AudioManager.AUDIOFOCUS_GAIN -> if (interruptedAt != 0L) {
                        val suspended = SystemClock.elapsedRealtime() - interruptedAt
                        interruptedAt = 0L
                        VoiceNative.nativeInterruption(false, suspended)
                    }
                }
            }
            .build()
        focusRequest = request
        val result = manager.requestAudioFocus(request)
        Log.i(TAG, "event=audio_focus_request granted=${result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED} result=$result")
    }

    private fun abandonFocus() {
        val request = focusRequest ?: return
        Log.i(TAG, "event=audio_focus_abandon")
        (getSystemService(Context.AUDIO_SERVICE) as AudioManager).abandonAudioFocusRequest(request)
        focusRequest = null
    }

    // ── diagnostics ──────────────────────────────────────────────────────────

    private fun focusName(change: Int): String = when (change) {
        AudioManager.AUDIOFOCUS_GAIN -> "gain"
        AudioManager.AUDIOFOCUS_LOSS -> "loss"
        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> "loss_transient"
        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> "loss_transient_can_duck"
        else -> "other_$change"
    }

    /** The system-wide audio routing state: which devices exist and where communication audio is going. */
    @Suppress("DEPRECATION")
    private fun audioManagerState(): String {
        val manager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val inputs = manager.getDevices(AudioManager.GET_DEVICES_INPUTS).joinToString(",") { VoiceAudio.deviceName(it) }
        val outputs = manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).joinToString(",") { VoiceAudio.deviceName(it) }
        val communication = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            VoiceAudio.deviceName(manager.communicationDevice)
        } else {
            "n/a"
        }
        return "audio_mode=${manager.mode} speakerphone=${manager.isSpeakerphoneOn} bluetooth_sco=${manager.isBluetoothScoOn} " +
            "mic_muted=${manager.isMicrophoneMute} communication_device=$communication inputs=$inputs outputs=$outputs"
    }

    /** Logs devices coming and going and, on Android 10+, whether the system silences this app's microphone. */
    private fun watchDevices() {
        val manager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val devices = object : AudioDeviceCallback() {
            override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) {
                Log.i(TAG, "event=audio_devices_added devices=${addedDevices.joinToString(",") { VoiceAudio.deviceName(it) }}")
            }

            override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) {
                Log.i(TAG, "event=audio_devices_removed devices=${removedDevices.joinToString(",") { VoiceAudio.deviceName(it) }}")
            }
        }
        deviceCallback = devices
        manager.registerAudioDeviceCallback(devices, handler)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val recording = object : AudioManager.AudioRecordingCallback() {
                override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>) {
                    Log.i(TAG, "event=recording_config_changed active=${configs.size} silenced=${configs.count { it.isClientSilenced }}")
                }
            }
            recordingCallback = recording
            manager.registerAudioRecordingCallback(recording, handler)
        }
    }

    private fun unwatchDevices() {
        val manager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        deviceCallback?.let { manager.unregisterAudioDeviceCallback(it) }
        recordingCallback?.let { if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) manager.unregisterAudioRecordingCallback(it) }
        deviceCallback = null
        recordingCallback = null
    }

    companion object {
        private const val TAG = VoiceAudio.TAG
        const val ACTION_START = "run.hundredfold.shell.voice.START"
        const val ACTION_STOP = "run.hundredfold.shell.voice.STOP"
        private const val CHANNEL_ID = "voice_mode_active"
        private const val NOTIFICATION_ID = 7421
        private const val STOP_FALLBACK_MS = 3_000L
        /** Safety net: release the wake lock if a session is somehow never stopped. */
        private val MAX_SESSION_MS = TimeUnit.HOURS.toMillis(12)
    }
}
