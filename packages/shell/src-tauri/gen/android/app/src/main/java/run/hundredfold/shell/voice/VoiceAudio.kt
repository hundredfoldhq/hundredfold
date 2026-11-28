package run.hundredfold.shell.voice

import android.annotation.SuppressLint
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioRouting
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import java.util.Locale
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Native capture and playback for voice mode. Nothing here touches JavaScript:
 * captured frames go to Rust through [VoiceNative.nativeCapture], and audio to
 * play arrives from Rust through [play].
 *
 * Capture is `AudioRecord` with source `VOICE_COMMUNICATION` and the platform's
 * `AcousticEchoCanceler` on the same audio session as the output track, so the
 * speaker is cancelled out of the microphone. Playback is a streaming
 * `AudioTrack` that can be flushed at once. The onset detector runs in the
 * capture loop, so a barge-in stops playback within one 20 ms frame.
 *
 * Diagnostics: one line per event as `event=<name> key=value ...` under [TAG] (the same key names as the
 * Swift and Rust sides), e.g. `adb logcat -s HundredfoldVoice`. Never reply or transcript text, only ids,
 * counts, sizes and timings. Per-chunk lines are debug level: `adb shell setprop log.tag.HundredfoldVoice DEBUG`
 * before starting voice mode turns them on.
 */
class VoiceAudio(private val sink: Sink = NativeSink) {
    /** Where audio and events go. Rust in production; a recorder in tests. */
    interface Sink {
        fun capture(frame: ByteArray, length: Int)
        fun onset(segmentId: Long, playedMs: Long)
        fun played(segmentId: Long)
    }

    private object NativeSink : Sink {
        override fun capture(frame: ByteArray, length: Int) = VoiceNative.nativeCapture(frame, length)
        override fun onset(segmentId: Long, playedMs: Long) = VoiceNative.nativeOnset(segmentId, playedMs)
        override fun played(segmentId: Long) = VoiceNative.nativePlayed(segmentId)
    }

    private class Chunk(val generation: Int, val segmentId: Int, val pcm: ByteArray)

    /** The microphone level while speech was playing, the numbers a false barge-in would show up in. */
    private class ListenWindow {
        var active = false
        var frames = 0
        var over = 0
        var runMs = 0
        var longestMs = 0
        var max = 0f
        var sum = 0f
        var startedAt = 0L
        var flushesAtStart = 0

        fun begin(now: Long, flushes: Int) {
            active = true
            frames = 0
            over = 0
            runMs = 0
            longestMs = 0
            max = 0f
            sum = 0f
            startedAt = now
            flushesAtStart = flushes
        }

        fun add(level: Float, threshold: Float) {
            frames += 1
            sum += level
            if (level > max) max = level
            if (level >= threshold) {
                over += 1
                runMs += FRAME_MS
                if (runMs > longestMs) longestMs = runMs
            } else {
                runMs = 0
            }
        }
    }

    private val lock = Any()
    private val ledger = PlaybackLedger(OUTPUT_RATE)
    private val detector = OnsetDetector()
    private val queue = LinkedBlockingQueue<Chunk>()
    private val guard = InterruptGuard()

    private var record: AudioRecord? = null
    private var track: AudioTrack? = null
    private var echoCanceler: AcousticEchoCanceler? = null
    private var noiseSuppressor: NoiseSuppressor? = null
    /**
     * The sound cue: a looping static track of its own, on the same audio session as the capture (so the
     * echo canceller knows it) and never touching the playback queue or the ledger. The onset detector
     * only listens while the ledger says speech is playing, so a cue cannot trigger a barge-in.
     */
    private var cueTrack: AudioTrack? = null
    private var captureThread: Thread? = null
    private var playbackThread: Thread? = null

    @Volatile private var running = false
    @Volatile private var paused = false
    private var generation = 0
    private var headBase = 0L

    // Diagnostics only; guarded by `lock` where noted.
    private val debugLog = Log.isLoggable(TAG, Log.DEBUG)
    private val queuedAt = HashMap<Int, Long>() // lock: when each segment's audio first reached the queue
    private val audibleLogged = HashSet<Int>() // lock
    private val rejectedLogged = HashSet<Int>() // lock
    private var flushes = 0 // lock
    private var queuedChunks = 0L // lock
    private var queuedBytes = 0L // lock
    private var reportedUnderruns = 0
    private var routingListeners: List<Pair<AudioRouting, AudioRouting.OnRoutingChangedListener>> = emptyList()

    val echoCancelerEnabled: Boolean get() = echoCanceler?.enabled == true

    @SuppressLint("MissingPermission") // The bridge asks for RECORD_AUDIO before starting.
    fun start() {
        check(!running) { "already started" }
        val inMin = AudioRecord.getMinBufferSize(INPUT_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val rec = AudioRecord.Builder()
            .setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(INPUT_RATE)
                    .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                    .build(),
            )
            .setBufferSizeInBytes(maxOf(inMin, FRAME_BYTES * 8))
            .build()
        check(rec.state == AudioRecord.STATE_INITIALIZED) { "microphone unavailable" }
        if (AcousticEchoCanceler.isAvailable()) {
            echoCanceler = AcousticEchoCanceler.create(rec.audioSessionId)?.also { it.enabled = true }
        }
        if (NoiseSuppressor.isAvailable()) {
            noiseSuppressor = NoiseSuppressor.create(rec.audioSessionId)?.also { it.enabled = true }
        }
        Log.i(
            TAG,
            "event=echo_canceller available=${AcousticEchoCanceler.isAvailable()} enabled=$echoCancelerEnabled " +
                "ns_available=${NoiseSuppressor.isAvailable()} ns_enabled=${noiseSuppressor?.enabled == true}",
        )

        val outMin = AudioTrack.getMinBufferSize(OUTPUT_RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val out = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(OUTPUT_RATE)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build(),
            )
            .setTransferMode(AudioTrack.MODE_STREAM)
            .setBufferSizeInBytes(maxOf(outMin * 2, OUTPUT_RATE / 4 * 2))
            .setSessionId(rec.audioSessionId)
            .build()
        check(out.state == AudioTrack.STATE_INITIALIZED) { "speaker unavailable" }

        record = rec
        track = out
        running = true
        paused = false
        rec.startRecording()
        out.play()
        headBase = rawHead(out)
        Log.i(
            TAG,
            "event=audio_start input_rate=$INPUT_RATE output_rate=$OUTPUT_RATE in_buffer_bytes=${maxOf(inMin, FRAME_BYTES * 8)} " +
                "out_buffer_bytes=${maxOf(outMin * 2, OUTPUT_RATE / 4 * 2)} audio_session_id=${rec.audioSessionId} " +
                "source=voice_communication usage=voice_communication record_device=${deviceName(rec.routedDevice)} " +
                "track_device=${deviceName(out.routedDevice)} track_buffer_frames=${out.bufferSizeInFrames}",
        )
        watchRouting(rec, out)

        captureThread = Thread({ captureLoop(rec, out) }, "voice-capture").also { it.start() }
        playbackThread = Thread({ playbackLoop(out) }, "voice-playback").also { it.start() }
    }

    fun configureOnset(threshold: Float, minSpeechMs: Int) {
        synchronized(lock) { detector.configure(threshold, minSpeechMs) }
    }

    /** Queues PCM16LE mono at 24 kHz for a segment. */
    fun play(segmentId: Int, pcm: ByteArray) {
        if (!running) {
            Log.i(TAG, "event=play_rejected segment=$segmentId bytes=${pcm.size} reason=not_running")
            return
        }
        var info: String? = null
        var detail: String? = null
        val oddLength = pcm.size % 2 != 0
        // The ledger learns of the audio when it is queued, not when the writer thread
        // reaches it: the gateway runs ahead of playback, so a segment's end marker
        // can arrive while all of its audio is still waiting in the queue.
        synchronized(lock) {
            val now = SystemClock.elapsedRealtime()
            if (!guard.accepts(segmentId, now)) {
                if (rejectedLogged.add(segmentId)) {
                    info = "event=play_rejected segment=$segmentId bytes=${pcm.size} reason=interrupt_guard"
                }
                return@synchronized
            }
            val pendingMs = track?.let { ledger.pendingFrames(head(it)) * 1000 / OUTPUT_RATE } ?: -1L
            ledger.write(segmentId, pcm.size / 2)
            queue.put(Chunk(generation, segmentId, pcm))
            val first = !queuedAt.containsKey(segmentId)
            if (first) queuedAt[segmentId] = now
            queuedChunks += 1
            queuedBytes += pcm.size.toLong()
            if (first) {
                info = "event=segment_first_audio_queued segment=$segmentId bytes=${pcm.size} frames=${pcm.size / 2} " +
                    "queued_ms=$pendingMs generation=$generation"
            } else if (debugLog) {
                detail = "event=down_audio segment=$segmentId bytes=${pcm.size} frames=${pcm.size / 2} " +
                    "queued_ms=$pendingMs queue_chunks=${queue.size} generation=$generation"
            }
        }
        info?.let { Log.i(TAG, it) }
        detail?.let { Log.d(TAG, it) }
        if (oddLength) Log.w(TAG, "event=play_odd_length segment=$segmentId bytes=${pcm.size}")
    }

    fun segmentEnd(segmentId: Int) {
        val pendingMs = synchronized(lock) {
            ledger.end(segmentId)
            track?.let { ledger.pendingFrames(head(it)) * 1000 / OUTPUT_RATE } ?: -1L
        }
        Log.i(TAG, "event=segment_end_marker segment=$segmentId pending_ms=$pendingMs")
    }

    /** Stops playback at once and forgets everything queued. */
    fun flush() {
        val discardedFrames = synchronized(lock) { flushLocked() }
        Log.i(
            TAG,
            "event=playback_flush cause=gateway_stop_playback discarded_ms=${discardedFrames * 1000 / OUTPUT_RATE} " +
                "underruns=${track?.underrunCount ?: -1}",
        )
    }

    /** Loops [pcm] (PCM16LE mono at 24 kHz) as the sound cue, replacing any cue; an empty array stops it. */
    fun setCue(pcm: ByteArray) {
        if (debugLog) Log.d(TAG, "event=cue_set bytes=${pcm.size}")
        synchronized(lock) {
            stopCueLocked()
            val rec = record ?: return
            if (!running || paused || pcm.size < 2) return
            val frames = pcm.size / 2
            val cue = AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(OUTPUT_RATE)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build(),
                )
                .setTransferMode(AudioTrack.MODE_STATIC)
                .setBufferSizeInBytes(pcm.size)
                .setSessionId(rec.audioSessionId)
                .build()
            if (cue.state != AudioTrack.STATE_INITIALIZED) {
                Log.w(TAG, "event=cue_track_failed bytes=${pcm.size}")
                cue.release()
                return
            }
            cue.write(pcm, 0, pcm.size)
            cue.setLoopPoints(0, frames, -1)
            cue.play()
            cueTrack = cue
        }
    }

    private fun stopCueLocked() {
        cueTrack?.let {
            runCatching { it.pause(); it.flush() }
            it.release()
        }
        cueTrack = null
    }

    fun pause() {
        Log.i(TAG, "event=audio_pause underruns=${track?.underrunCount ?: -1}")
        synchronized(lock) { stopCueLocked() }
        paused = true
        track?.pause()
        record?.stop()
    }

    fun resume() {
        val rec = record ?: return
        val out = track ?: return
        Log.i(TAG, "event=audio_resume record_device=${deviceName(rec.routedDevice)} track_device=${deviceName(out.routedDevice)}")
        paused = false
        synchronized(lock) { detector.reset() }
        rec.startRecording()
        out.play()
    }

    fun stop() {
        if (!running) return
        running = false
        Log.i(
            TAG,
            "event=audio_stop underruns=${track?.underrunCount ?: -1} queued_chunks=$queuedChunks queued_bytes=$queuedBytes flushes=$flushes",
        )
        unwatchRouting()
        synchronized(lock) { stopCueLocked() }
        queue.offer(Chunk(-1, -1, ByteArray(0)))
        record?.let { runCatching { it.stop() } }
        track?.let { runCatching { it.pause(); it.flush() } }
        captureThread?.join(500)
        playbackThread?.join(500)
        echoCanceler?.release()
        noiseSuppressor?.release()
        record?.release()
        track?.release()
        record = null
        track = null
        echoCanceler = null
        noiseSuppressor = null
    }

    // ── internals ────────────────────────────────────────────────────────────

    private fun rawHead(out: AudioTrack): Long = out.playbackHeadPosition.toLong() and 0xFFFFFFFFL

    /** Frames played since the last flush. */
    private fun head(out: AudioTrack): Long = (rawHead(out) - headBase).coerceAtLeast(0)

    /** Returns the frames that were queued and not yet played, which the flush throws away. */
    private fun flushLocked(): Long {
        val out = track ?: return 0
        val discarded = ledger.pendingFrames(head(out))
        flushes += 1
        queuedAt.clear()
        audibleLogged.clear()
        rejectedLogged.clear()
        generation += 1
        queue.clear()
        out.pause()
        out.flush()
        out.play()
        headBase = rawHead(out)
        ledger.reset()
        return discarded
    }

    private fun captureLoop(rec: AudioRecord, out: AudioTrack) {
        val frame = ByteArray(FRAME_BYTES)
        var filled = 0
        // Diagnostics: plain counters, written out here on the capture thread (never a real-time callback).
        val listen = ListenWindow()
        var frames = 0L
        var partialReads = 0L
        var readErrors = 0L
        var gaps = 0L
        var maxLevel = 0f
        var statsAt = SystemClock.elapsedRealtime()
        var lastFrameAt = statsAt
        while (running) {
            if (paused) {
                Thread.sleep(20)
                filled = 0
                lastFrameAt = SystemClock.elapsedRealtime()
                continue
            }
            val read = rec.read(frame, filled, FRAME_BYTES - filled)
            if (read < 0) {
                if (!running) return
                readErrors += 1
                Log.w(TAG, "event=capture_read_failed code=$read count=$readErrors")
                Thread.sleep(20)
                continue
            }
            if (read < FRAME_BYTES - filled) partialReads += 1
            filled += read
            if (filled < FRAME_BYTES) continue
            filled = 0
            val level = OnsetDetector.rms(frame, FRAME_BYTES)
            frames += 1
            if (level > maxLevel) maxLevel = level
            val frameAt = SystemClock.elapsedRealtime()
            val sincePrevious = frameAt - lastFrameAt
            lastFrameAt = frameAt
            if (sincePrevious >= CAPTURE_GAP_WARN_MS) {
                gaps += 1
                // Powers of two only: a stalled microphone would otherwise log on every frame.
                if ((gaps and (gaps - 1)) == 0L) {
                    Log.w(TAG, "event=capture_gap ms=$sincePrevious count=$gaps frames=$frames")
                }
            }
            var onsetSegment = -1L
            var onsetPlayedMs = 0L
            var fired = false
            val finished: List<Int>
            var onsetNote: String? = null
            var windowNote: String? = null
            var audibleNote: String? = null
            val playedNotes = ArrayList<String>()
            synchronized(lock) {
                val head = head(out)
                if (ledger.isPlaying(head)) {
                    if (!listen.active) listen.begin(frameAt, flushes)
                    listen.add(level, detector.threshold)
                    val held = detector.heldMs
                    if (detector.feed(level)) {
                        onsetSegment = (ledger.currentSegment(head) ?: -1).toLong()
                        onsetPlayedMs = ledger.playedMs(head)
                        val discarded = flushLocked()
                        guard.interrupted(SystemClock.elapsedRealtime())
                        fired = true
                        onsetNote = "event=barge_in_detected segment=$onsetSegment played_ms=$onsetPlayedMs " +
                            "rms=${fmt(level)} threshold=${fmt(detector.threshold)} held_ms=${held + FRAME_MS} " +
                            "min_speech_ms=${detector.minSpeechMs} window_max_rms=${fmt(listen.max)} " +
                            "window_ms=${frameAt - listen.startedAt} discarded_ms=${discarded * 1000 / OUTPUT_RATE} " +
                            "generation=$generation"
                    } else if (debugLog && held > 0 && detector.heldMs == 0) {
                        Log.d(
                            TAG,
                            "event=onset_run_ended rms=${fmt(level)} threshold=${fmt(detector.threshold)} " +
                                "held_ms=$held min_speech_ms=${detector.minSpeechMs}",
                        )
                    }
                    if (!fired) {
                        // The head moving into a segment is the first of its audio leaving the track.
                        ledger.currentSegment(head)?.let { id ->
                            if (audibleLogged.add(id)) {
                                val queued = queuedAt[id]
                                audibleNote = "event=segment_audible segment=$id " +
                                    "since_queued_ms=${if (queued != null) frameAt - queued else -1} " +
                                    "pending_ms=${ledger.pendingFrames(head) * 1000 / OUTPUT_RATE}"
                            }
                        }
                    }
                } else {
                    detector.reset()
                }
                finished = if (fired) emptyList() else ledger.completed(head)
                for (id in finished) {
                    val queued = queuedAt.remove(id)
                    audibleLogged.remove(id)
                    playedNotes.add("event=segment_played segment=$id since_queued_ms=${if (queued != null) frameAt - queued else -1}")
                }
                // After a flush the ledger is empty, so this also ends the window of a barge-in.
                if (listen.active && !ledger.isPlaying(head)) {
                    val open = if (fired) null else ledger.openSegmentId()
                    val ended = when {
                        fired -> "barge_in"
                        listen.flushesAtStart != flushes -> "flushed"
                        open != null -> "starved"
                        else -> "drained"
                    }
                    val mean = if (listen.frames > 0) listen.sum / listen.frames else 0f
                    windowNote = "event=playback_idle ended=$ended window_ms=${frameAt - listen.startedAt} " +
                        "listen_frames=${listen.frames} over_threshold_frames=${listen.over} " +
                        "longest_over_ms=${listen.longestMs} max_rms=${fmt(listen.max)} mean_rms=${fmt(mean)} " +
                        "threshold=${fmt(detector.threshold)} min_speech_ms=${detector.minSpeechMs} open_segment=${open ?: -1}"
                    listen.active = false
                }
            }
            onsetNote?.let { Log.i(TAG, it) }
            windowNote?.let { Log.i(TAG, it) }
            audibleNote?.let { Log.i(TAG, it) }
            playedNotes.forEach { Log.i(TAG, it) }
            if (debugLog) Log.d(TAG, "event=capture_frame rms=${fmt(level)} bytes=$FRAME_BYTES")
            if (fired) sink.onset(onsetSegment, onsetPlayedMs)
            finished.forEach { sink.played(it.toLong()) }
            sink.capture(frame, FRAME_BYTES)
            if (frameAt - statsAt >= STATS_EVERY_MS) {
                Log.i(
                    TAG,
                    "event=capture_stats window_ms=${frameAt - statsAt} frames=$frames partial_reads=$partialReads " +
                        "read_errors=$readErrors gaps=$gaps max_rms=${fmt(maxLevel)} underruns=${out.underrunCount} " +
                        "queue_chunks=${queue.size}",
                )
                statsAt = frameAt
                maxLevel = 0f
            }
        }
    }

    private fun playbackLoop(out: AudioTrack) {
        while (running) {
            val chunk = queue.poll(200, TimeUnit.MILLISECONDS) ?: continue
            if (chunk.generation < 0) return
            if (synchronized(lock) { chunk.generation != generation }) continue
            var offset = 0
            while (offset < chunk.pcm.size && running) {
                if (paused) {
                    Thread.sleep(20)
                    continue
                }
                // Short slices: a flush can land between the generation check and the blocking
                // write, and then at most one slice of stale audio plays.
                val written = out.write(chunk.pcm, offset, minOf(chunk.pcm.size - offset, WRITE_SLICE_BYTES))
                if (written < 0) {
                    Log.w(TAG, "event=track_write_failed code=$written segment=${chunk.segmentId} offset=$offset bytes=${chunk.pcm.size}")
                    break
                }
                offset += written
                if (synchronized(lock) { chunk.generation != generation }) break
            }
            val underruns = out.underrunCount
            if (underruns != reportedUnderruns) {
                val pendingMs = synchronized(lock) { ledger.pendingFrames(head(out)) * 1000 / OUTPUT_RATE }
                Log.w(
                    TAG,
                    "event=track_underrun total=$underruns new=${underruns - reportedUnderruns} " +
                        "segment=${chunk.segmentId} pending_ms=$pendingMs queue_chunks=${queue.size}",
                )
                reportedUnderruns = underruns
            }
        }
    }

    private fun fmt(value: Float): String = String.format(Locale.US, "%.4f", value)

    /** Logs where the microphone and speaker are routed whenever the system moves them (speaker, headset, Bluetooth). */
    private fun watchRouting(rec: AudioRecord, out: AudioTrack) {
        // Diagnostics only: nothing here, the listener's creation included, may fail the audio start.
        runCatching {
            val handler = Handler(Looper.getMainLooper())
            val onChange = AudioRouting.OnRoutingChangedListener { router ->
                val which = if (router === rec) "record" else "track"
                Log.i(
                    TAG,
                    "event=route_change which=$which device=${deviceName(router.routedDevice)} " +
                        "record_device=${deviceName(rec.routedDevice)} track_device=${deviceName(out.routedDevice)}",
                )
            }
            rec.addOnRoutingChangedListener(onChange, handler)
            out.addOnRoutingChangedListener(onChange, handler)
            routingListeners =
                listOf<Pair<AudioRouting, AudioRouting.OnRoutingChangedListener>>(rec to onChange, out to onChange)
        }
    }

    private fun unwatchRouting() {
        routingListeners.forEach { (router, listener) -> runCatching { router.removeOnRoutingChangedListener(listener) } }
        routingListeners = emptyList()
    }

    companion object {
        const val TAG = "HundredfoldVoice"
        const val INPUT_RATE = 16_000
        const val OUTPUT_RATE = 24_000
        /** 20 ms of PCM16LE mono at 16 kHz. */
        const val FRAME_BYTES = 640
        /** 30 ms of PCM16LE mono at 24 kHz. */
        const val WRITE_SLICE_BYTES = 1_440
        private const val FRAME_MS = 20
        /** A capture frame later than this after the one before it is logged as a stall. */
        private const val CAPTURE_GAP_WARN_MS = 100L
        private const val STATS_EVERY_MS = 10_000L

        /**
         * A short name for an audio device's type (never its product name, which is the user's own),
         * e.g. `builtin_speaker`, `bluetooth_sco`; `none` when unrouted.
         */
        fun deviceName(device: AudioDeviceInfo?): String = when (device?.type) {
            null -> "none"
            AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "builtin_earpiece"
            AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "builtin_speaker"
            AudioDeviceInfo.TYPE_BUILTIN_MIC -> "builtin_mic"
            AudioDeviceInfo.TYPE_WIRED_HEADSET -> "wired_headset"
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "wired_headphones"
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "bluetooth_sco"
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "bluetooth_a2dp"
            AudioDeviceInfo.TYPE_USB_DEVICE -> "usb_device"
            AudioDeviceInfo.TYPE_USB_HEADSET -> "usb_headset"
            AudioDeviceInfo.TYPE_HEARING_AID -> "hearing_aid"
            else -> "type_${device.type}"
        }
    }
}
