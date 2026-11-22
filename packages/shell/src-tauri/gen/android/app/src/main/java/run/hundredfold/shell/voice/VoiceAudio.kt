package run.hundredfold.shell.voice

import android.annotation.SuppressLint
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.os.SystemClock
import android.util.Log
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

    private val lock = Any()
    private val ledger = PlaybackLedger(OUTPUT_RATE)
    private val detector = OnsetDetector()
    private val queue = LinkedBlockingQueue<Chunk>()
    private val guard = InterruptGuard()

    private var record: AudioRecord? = null
    private var track: AudioTrack? = null
    private var echoCanceler: AcousticEchoCanceler? = null
    private var noiseSuppressor: NoiseSuppressor? = null
    private var captureThread: Thread? = null
    private var playbackThread: Thread? = null

    @Volatile private var running = false
    @Volatile private var paused = false
    private var generation = 0
    private var headBase = 0L

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
        Log.i(TAG, "echo canceller available=${AcousticEchoCanceler.isAvailable()} enabled=$echoCancelerEnabled")

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

        captureThread = Thread({ captureLoop(rec, out) }, "voice-capture").also { it.start() }
        playbackThread = Thread({ playbackLoop(out) }, "voice-playback").also { it.start() }
    }

    fun configureOnset(threshold: Float, minSpeechMs: Int) {
        synchronized(lock) { detector.configure(threshold, minSpeechMs) }
    }

    /** Queues PCM16LE mono at 24 kHz for a segment. */
    fun play(segmentId: Int, pcm: ByteArray) {
        if (!running) return
        // The ledger learns of the audio when it is queued, not when the writer thread
        // reaches it: the gateway runs ahead of playback, so a segment's end marker
        // can arrive while all of its audio is still waiting in the queue.
        synchronized(lock) {
            if (!guard.accepts(segmentId, SystemClock.elapsedRealtime())) return
            ledger.write(segmentId, pcm.size / 2)
            queue.put(Chunk(generation, segmentId, pcm))
        }
    }

    fun segmentEnd(segmentId: Int) {
        synchronized(lock) { ledger.end(segmentId) }
    }

    /** Stops playback at once and forgets everything queued. */
    fun flush() {
        synchronized(lock) { flushLocked() }
    }

    fun pause() {
        paused = true
        track?.pause()
        record?.stop()
    }

    fun resume() {
        val rec = record ?: return
        val out = track ?: return
        paused = false
        synchronized(lock) { detector.reset() }
        rec.startRecording()
        out.play()
    }

    fun stop() {
        if (!running) return
        running = false
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

    private fun flushLocked() {
        val out = track ?: return
        generation += 1
        queue.clear()
        out.pause()
        out.flush()
        out.play()
        headBase = rawHead(out)
        ledger.reset()
    }

    private fun captureLoop(rec: AudioRecord, out: AudioTrack) {
        val frame = ByteArray(FRAME_BYTES)
        var filled = 0
        while (running) {
            if (paused) {
                Thread.sleep(20)
                filled = 0
                continue
            }
            val read = rec.read(frame, filled, FRAME_BYTES - filled)
            if (read < 0) {
                if (!running) return
                Log.w(TAG, "capture read failed: $read")
                Thread.sleep(20)
                continue
            }
            filled += read
            if (filled < FRAME_BYTES) continue
            filled = 0
            val level = OnsetDetector.rms(frame, FRAME_BYTES)
            var onsetSegment = -1L
            var onsetPlayedMs = 0L
            var fired = false
            val finished: List<Int>
            synchronized(lock) {
                val head = head(out)
                if (ledger.isPlaying(head)) {
                    if (detector.feed(level)) {
                        onsetSegment = (ledger.currentSegment(head) ?: -1).toLong()
                        onsetPlayedMs = ledger.playedMs(head)
                        flushLocked()
                        guard.interrupted(SystemClock.elapsedRealtime())
                        fired = true
                    }
                } else {
                    detector.reset()
                }
                finished = if (fired) emptyList() else ledger.completed(head)
            }
            if (fired) sink.onset(onsetSegment, onsetPlayedMs)
            finished.forEach { sink.played(it.toLong()) }
            sink.capture(frame, FRAME_BYTES)
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
                if (written < 0) break
                offset += written
                if (synchronized(lock) { chunk.generation != generation }) break
            }
        }
    }

    companion object {
        const val TAG = "HundredfoldVoice"
        const val INPUT_RATE = 16_000
        const val OUTPUT_RATE = 24_000
        /** 20 ms of PCM16LE mono at 16 kHz. */
        const val FRAME_BYTES = 640
        /** 30 ms of PCM16LE mono at 24 kHz. */
        const val WRITE_SLICE_BYTES = 1_440
    }
}
