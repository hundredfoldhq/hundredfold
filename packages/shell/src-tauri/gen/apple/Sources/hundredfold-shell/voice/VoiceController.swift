import AVFoundation
import MediaPlayer
import UIKit
import os

// Diagnostic log for native voice. One line per event, `event=<name> key=value ...`, with the same key names
// the Kotlin and Rust sides use. Never carries reply or transcript text, only ids, counts, sizes and timings.
// Read it with Console.app (or `log stream`) filtered to subsystem `run.hundredfold.shell`, category `voice`
// (this file) and `voice.core` (the Rust session and socket, routed here through `hf_voice_log`).
// Per-frame lines are `debug`: they are emitted in debug builds, or in a release build started with
// HF_VOICE_LOG=debug, and Console shows them with "Include Debug Messages".
enum VoiceLog {
    private static let swiftLog = Logger(subsystem: "run.hundredfold.shell", category: "voice")
    private static let coreLog = Logger(subsystem: "run.hundredfold.shell", category: "voice.core")

    static let debugEnabled: Bool = {
        #if DEBUG
        return true
        #else
        return ProcessInfo.processInfo.environment["HF_VOICE_LOG"]?.lowercased() == "debug"
        #endif
    }()

    static func debug(_ line: @autoclosure () -> String) {
        guard debugEnabled else { return }
        let text = line()
        swiftLog.debug("\(text, privacy: .public)")
    }

    static func info(_ line: String) { swiftLog.info("\(line, privacy: .public)") }

    static func warn(_ line: String) { swiftLog.warning("\(line, privacy: .public)") }

    /// A line from the Rust side: 0 debug, 1 info, 2 warning.
    static func core(level: UInt8, _ line: String) {
        switch level {
        case 0: coreLog.debug("\(line, privacy: .public)")
        case 2: coreLog.warning("\(line, privacy: .public)")
        default: coreLog.info("\(line, privacy: .public)")
        }
    }

    static func f(_ value: Float) -> String { String(format: "%.4f", value) }

    /// The port types of a route (`Speaker`, `BluetoothHFP`, ...), never the device names.
    static func route(_ route: AVAudioSessionRouteDescription) -> String {
        let inputs = route.inputs.map { $0.portType.rawValue }.joined(separator: ",")
        let outputs = route.outputs.map { $0.portType.rawValue }.joined(separator: ",")
        return "in=\(inputs.isEmpty ? "none" : inputs) out=\(outputs.isEmpty ? "none" : outputs)"
    }

    static func reason(_ raw: UInt?) -> String {
        guard let raw, let reason = AVAudioSession.RouteChangeReason(rawValue: raw) else { return "unknown" }
        switch reason {
        case .newDeviceAvailable: return "new_device_available"
        case .oldDeviceUnavailable: return "old_device_unavailable"
        case .categoryChange: return "category_change"
        case .override: return "override"
        case .wakeFromSleep: return "wake_from_sleep"
        case .noSuitableRouteForCategory: return "no_suitable_route"
        case .routeConfigurationChange: return "route_configuration_change"
        case .unknown: return "unknown"
        @unknown default: return "other_\(raw)"
        }
    }
}

/// Counters for the log lines; they never influence a decision. Guarded by the controller's `state` queue.
private struct VoiceDiag {
    /// Mic level while speech was playing: the numbers a false barge-in would show up in.
    var listenFrames = 0
    var overFrames = 0
    var runMs = 0
    var longestRunMs = 0
    var maxLevel: Float = 0
    var sumLevel: Float = 0
    var windowStartMs: Int64 = 0
    var windowFlushes = 0
    var flushes = 0
    var wasPlaying = false
    /// When each segment's audio was first handed to the player, and which already reported a first chunk.
    var firstQueuedMs: [Int: Int64] = [:]
    var rejected: Set<Int> = []
    var queuedChunks = 0
    var queuedBytes = 0
    /// Capture side.
    var captureBlocks = 0
    var captureBytes = 0
    var convertErrors = 0
    var pausedFrames = 0
    var frames = 0
    var maxCaptureLevel: Float = 0
    var lastStatsMs: Int64 = 0

    mutating func beginWindow(now: Int64) {
        listenFrames = 0
        overFrames = 0
        runMs = 0
        longestRunMs = 0
        maxLevel = 0
        sumLevel = 0
        windowStartMs = now
        windowFlushes = flushes
        wasPlaying = true
    }
}

// Native voice mode on iOS (specs/009-voice-mode/contracts/native-voice.md).
//
// Written to the contract and not yet built or run: it needs a Mac with Xcode and
// an Apple team. While voice runs, capture, playback and the gateway socket are all
// native; the Rust side (src/voice.rs, src/ios.rs) owns the socket and drives this
// class through the `hf_voice_*` C functions at the bottom, and this class reports
// captured audio and events back through the `hf_voice_on_*` functions declared in
// the bridging header.
//
//   AVAudioSession   .playAndRecord, mode .voiceChat (echo cancellation);
//                    UIBackgroundModes: audio keeps it running with the screen locked
//   capture          AVAudioEngine input, voice processing on, converted to 16 kHz PCM16
//   playback         AVAudioPlayerNode, 24 kHz, flushable
//   onset detector   RMS over 20 ms frames, parameters from the gateway's `ready.onset`
//   lock screen      Now Playing "Voice mode on"; pause / stop commands end the session
//   interruptions    a call or Siri pauses capture and playback; they resume afterwards,
//                    or the session ends when the system does not allow a resume
//   route changes    a changed input format rebuilds the capture path and keeps going
final class VoiceController {
    static let shared = VoiceController()

    private static let inputRate = 16_000.0
    private static let outputRate = 24_000.0
    private static let frameBytes = 640 // 20 ms of PCM16 mono at 16 kHz
    private static let playbackChunkFrames = 960 // 40 ms: the granularity of "played"

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    /// The sound cue's own node: looped beside the speech player, never through it or the ledger, so the
    /// onset detector (which only listens while the ledger says speech is playing) cannot hear a cue as barge-in.
    private let cuePlayer = AVAudioPlayerNode()
    /// Serial queue guarding all mutable state below.
    private let state = DispatchQueue(label: "run.hundredfold.voice.state")
    /// Player stop/play and buffer scheduling run here, never under `state` and never on the capture
    /// tap's thread: `AVAudioPlayerNode.stop()` waits on the engine, which can be waiting on that tap
    /// (a barge-in flush from the tap thread deadlocked and trapped in libdispatch).
    private let audioOps = DispatchQueue(label: "run.hundredfold.voice.audio")
    /// Serialises `start` and `stop` end to end. Rust calls both from its own threads: a
    /// `start` arriving while a `stop` is still inside `teardown` would otherwise pass the
    /// `running` check (already false) and build a new engine that the old teardown then
    /// removes the tap from, stops and detaches. Taken before `state`, never inside it.
    private let lifecycle = NSLock()
    private let clock = DispatchTime.now()

    private let captureFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: inputRate, channels: 1, interleaved: true)!
    private let playbackFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: outputRate, channels: 1, interleaved: false)!

    private var running = false
    private var playerAttached = false
    private var converter: AVAudioConverter?
    private var detector = OnsetDetector()
    private var ledger = PlaybackLedger(sampleRate: Int(outputRate))
    private var interruptGuard = InterruptGuard()
    private var generation = 0
    private var playedFrames: Int64 = 0
    private var pendingCapture = Data()
    private var interruptedAt: DispatchTime?
    private var observers: [NSObjectProtocol] = []
    /// The cue the session last asked for (PCM16LE mono), kept so a restarted engine can play it again. Guarded by `state`.
    private var cuePCM: Data?
    private var diag = VoiceDiag()

    private func nowMs() -> Int64 {
        Int64((DispatchTime.now().uptimeNanoseconds - clock.uptimeNanoseconds) / 1_000_000)
    }

    // MARK: diagnostics

    /// Session-level numbers that explain what the hardware is doing: the rates it runs at and its latency.
    private func audioState(_ session: AVAudioSession) -> String {
        let ms = { (seconds: TimeInterval) in Int((seconds * 1000).rounded()) }
        return "session_rate=\(Int(session.sampleRate)) io_buffer_ms=\(ms(session.ioBufferDuration)) input_latency_ms=\(ms(session.inputLatency)) output_latency_ms=\(ms(session.outputLatency)) \(VoiceLog.route(session.currentRoute))"
    }

    private func engineFormats() -> String {
        let input = engine.inputNode.outputFormat(forBus: 0)
        let output = engine.outputNode.outputFormat(forBus: 0)
        return "hw_input_rate=\(Int(input.sampleRate)) hw_input_channels=\(input.channelCount) hw_output_rate=\(Int(output.sampleRate)) hw_output_channels=\(output.channelCount) engine_running=\(engine.isRunning)"
    }

    private func voiceProcessingState() -> String {
        let input = engine.inputNode
        return "voice_processing=\(input.isVoiceProcessingEnabled) vp_bypassed=\(input.isVoiceProcessingBypassed) vp_agc=\(input.isVoiceProcessingAGCEnabled)"
    }

    // MARK: permissions and lifecycle

    func requestPermissions() -> Bool {
        let semaphore = DispatchSemaphore(value: 0)
        var granted = false
        let answer: (Bool) -> Void = { value in
            granted = value
            semaphore.signal()
        }
        if #available(iOS 17.0, *) {
            AVAudioApplication.requestRecordPermission(completionHandler: answer)
        } else {
            AVAudioSession.sharedInstance().requestRecordPermission(answer)
        }
        semaphore.wait()
        VoiceLog.info("event=voice_permission granted=\(granted)")
        return granted
    }

    func start(handsFree: Bool) -> Bool {
        lifecycle.lock()
        defer { lifecycle.unlock() }
        guard !state.sync(execute: { running }) else {
            VoiceLog.warn("event=voice_start_refused reason=already_running")
            return false
        }
        let startedAt = nowMs()
        let session = AVAudioSession.sharedInstance()
        var stage = "set_category"
        VoiceLog.info("event=audio_session_configure category=playAndRecord mode=voiceChat options=allowBluetooth,defaultToSpeaker preferred_rate=\(Int(Self.outputRate)) hands_free=\(handsFree) \(VoiceLog.route(session.currentRoute))")
        do {
            try session.setCategory(
                .playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .defaultToSpeaker])
            stage = "set_preferred_rate"
            try session.setPreferredSampleRate(Self.outputRate)
            stage = "activate"
            try session.setActive(true)
            // Voice processing gives the input platform echo cancellation against
            // this app's own playback.
            stage = "voice_processing"
            try engine.inputNode.setVoiceProcessingEnabled(true)
        } catch {
            let failure = error as NSError
            VoiceLog.warn("event=audio_session_error stage=\(stage) domain=\(failure.domain) code=\(failure.code)")
            // The session may already be active: hand the audio back to other apps.
            teardown()
            return false
        }
        VoiceLog.info("event=audio_session_active \(audioState(session)) \(voiceProcessingState())")

        engine.attach(player)
        engine.attach(cuePlayer)
        playerAttached = true
        engine.connect(player, to: engine.mainMixerNode, format: playbackFormat)
        engine.connect(cuePlayer, to: engine.mainMixerNode, format: playbackFormat)
        guard installCapture() else {
            VoiceLog.warn("event=capture_install_failed stage=start \(engineFormats())")
            teardown()
            return false
        }
        do {
            engine.prepare()
            try engine.start()
        } catch {
            let failure = error as NSError
            VoiceLog.warn("event=engine_start_failed stage=start domain=\(failure.domain) code=\(failure.code) \(engineFormats())")
            teardown()
            return false
        }
        player.play()
        VoiceLog.info("event=engine_started \(engineFormats()) playback_rate=\(Int(Self.outputRate)) ms=\(nowMs() - startedAt)")
        state.sync {
            running = true
            detector = OnsetDetector()
            ledger.reset()
            interruptGuard = InterruptGuard()
            generation += 1
            playedFrames = 0
            pendingCapture.removeAll()
            interruptedAt = nil
            diag = VoiceDiag()
            diag.lastStatsMs = nowMs()
        }
        VoiceLog.info("event=voice_started generation=\(state.sync { generation }) ms=\(nowMs() - startedAt)")
        observeSystem(session)
        DispatchQueue.main.async { self.showLockScreenControl() }
        return true
    }

    func stop() {
        lifecycle.lock()
        defer { lifecycle.unlock() }
        let summary = state.sync { () -> String in
            running = false
            generation += 1
            return "frames=\(diag.frames) capture_blocks=\(diag.captureBlocks) convert_errors=\(diag.convertErrors) queued_chunks=\(diag.queuedChunks) queued_bytes=\(diag.queuedBytes) flushes=\(diag.flushes) max_capture_rms=\(VoiceLog.f(diag.maxCaptureLevel))"
        }
        VoiceLog.info("event=voice_stop \(summary)")
        // Tears down whatever exists, whether or not the session got as far as running:
        // a start that failed part-way must not leave the audio session active.
        teardown()
        DispatchQueue.main.async { self.hideLockScreenControl() }
    }

    /// Releases the engine, the observers and the audio session. Safe to call at any
    /// point, any number of times.
    private func teardown() {
        VoiceLog.info("event=teardown engine_running=\(engine.isRunning)")
        engine.inputNode.removeTap(onBus: 0)
        player.stop()
        state.sync {
            cuePCM = nil
            cuePlayer.stop()
        }
        engine.stop()
        if playerAttached {
            engine.detach(player)
            engine.detach(cuePlayer)
            playerAttached = false
        }
        observers.forEach(NotificationCenter.default.removeObserver)
        observers.removeAll()
        state.sync {
            converter = nil
            pendingCapture.removeAll()
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// (Re)builds the capture path from the input's current hardware format: the tap
    /// and the converter are both tied to it, and connecting or removing a Bluetooth or
    /// wired headset changes it. Returns false when no converter exists for the format.
    private func installCapture() -> Bool {
        let input = engine.inputNode
        input.removeTap(onBus: 0)
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0,
              let converter = AVAudioConverter(from: inputFormat, to: captureFormat) else {
            VoiceLog.warn("event=capture_converter_unavailable input_rate=\(Int(inputFormat.sampleRate)) input_channels=\(inputFormat.channelCount)")
            return false
        }
        VoiceLog.info("event=capture_installed input_rate=\(Int(inputFormat.sampleRate)) input_channels=\(inputFormat.channelCount) capture_rate=\(Int(Self.inputRate)) resample=\(inputFormat.sampleRate != Self.inputRate)")
        state.sync {
            self.converter = converter
            pendingCapture.removeAll()
        }
        input.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] buffer, _ in
            self?.capture(buffer)
        }
        return true
    }

    /// Rebuilds capture for the current input format and restarts the engine and the
    /// player. Returns false if the session cannot go on.
    private func restartAudio() -> Bool {
        let began = nowMs()
        guard installCapture() else { return false }
        do {
            engine.prepare()
            try engine.start()
        } catch {
            let failure = error as NSError
            VoiceLog.warn("event=engine_start_failed stage=restart domain=\(failure.domain) code=\(failure.code)")
            return false
        }
        player.play()
        VoiceLog.info("event=engine_restarted \(engineFormats()) \(voiceProcessingState()) ms=\(nowMs() - began)")
        // The restart stopped the cue's node, and the session only asks again when the wanted cue changes,
        // so play the last one it asked for.
        playCue()
        return true
    }

    /// Ends the session from the native side: the Rust side closes the socket and
    /// reports the stop with the given reason.
    private func endSession(_ reason: String) {
        VoiceLog.warn("event=session_end_requested reason=\(reason)")
        reason.withCString { hf_voice_on_stop($0) }
    }

    // MARK: onset detection and capture

    func configureOnset(threshold: Float, minSpeechMs: Int) {
        state.sync { detector.configure(threshold: threshold, minSpeechMs: minSpeechMs) }
    }

    /// Converts the tap's buffer to 16 kHz PCM16 and hands out exact 20 ms frames.
    private func capture(_ buffer: AVAudioPCMBuffer) {
        guard let converter = state.sync(execute: { self.converter }) else { return }
        let ratio = Self.inputRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 16
        guard let out = AVAudioPCMBuffer(pcmFormat: captureFormat, frameCapacity: capacity) else { return }
        var consumed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, out.frameLength > 0, let channel = out.int16ChannelData else {
            // Counted here, reported with the periodic stats line (and at once for the first few).
            let failures = state.sync { () -> Int in
                diag.convertErrors += 1
                return diag.convertErrors
            }
            if let error, failures <= 3 || failures.nonzeroBitCount == 1 {
                VoiceLog.warn("event=capture_convert_error code=\(error.code) count=\(failures) input_frames=\(buffer.frameLength) input_rate=\(Int(buffer.format.sampleRate))")
            }
            return
        }
        let bytes = Data(bytes: channel[0], count: Int(out.frameLength) * MemoryLayout<Int16>.size)

        var frames: [Data] = []
        state.sync {
            guard running else { return }
            diag.captureBlocks += 1
            diag.captureBytes += bytes.count
            pendingCapture.append(bytes)
            while pendingCapture.count >= Self.frameBytes {
                frames.append(pendingCapture.prefix(Self.frameBytes))
                pendingCapture.removeFirst(Self.frameBytes)
            }
        }
        for frame in frames {
            processFrame(frame)
        }
    }

    private func processFrame(_ frame: Data) {
        let level = frame.withUnsafeBytes { raw in
            OnsetDetector.rms(raw.bindMemory(to: Int16.self))
        }
        var onset: (segment: Int64, playedMs: Int64)?
        var finished: [Int] = []
        // Log lines are built under the lock from plain counters and written after it.
        var onsetNote: String?
        var windowNote: String?
        var statsNote: String?
        var playedNotes: [String] = []
        state.sync {
            guard running, interruptedAt == nil else {
                if running { diag.pausedFrames += 1 }
                return
            }
            let head = playedFrames
            let now = nowMs()
            diag.frames += 1
            diag.maxCaptureLevel = max(diag.maxCaptureLevel, level)
            var heldBefore = 0
            if ledger.isPlaying(head: head) {
                if !diag.wasPlaying { diag.beginWindow(now: now) }
                diag.listenFrames += 1
                diag.sumLevel += level
                diag.maxLevel = max(diag.maxLevel, level)
                if level >= detector.threshold {
                    diag.overFrames += 1
                    diag.runMs += 20
                    diag.longestRunMs = max(diag.longestRunMs, diag.runMs)
                } else {
                    diag.runMs = 0
                }
                heldBefore = detector.heldMs
                if detector.feed(level) {
                    let segment = Int64(ledger.currentSegment(head: head) ?? -1)
                    let playedMs = ledger.playedMs(head: head)
                    onset = (segment, playedMs)
                    let discarded = flushLocked()
                    interruptGuard.interrupted(now: nowMs())
                    onsetNote = "event=barge_in_detected segment_id=\(segment) played_ms=\(playedMs) rms=\(VoiceLog.f(level)) threshold=\(VoiceLog.f(detector.threshold)) held_ms=\(heldBefore + 20) min_speech_ms=\(detector.minSpeechMs) window_max_rms=\(VoiceLog.f(diag.maxLevel)) window_ms=\(now - diag.windowStartMs) discarded_ms=\(discarded * 1000 / Int64(Self.outputRate)) generation=\(generation)"
                } else if heldBefore > 0 && detector.heldMs == 0 {
                    VoiceLog.debug("event=onset_run_ended rms=\(VoiceLog.f(level)) threshold=\(VoiceLog.f(detector.threshold)) held_ms=\(heldBefore) min_speech_ms=\(detector.minSpeechMs)")
                }
            } else {
                detector.reset()
            }
            if onset == nil { finished = ledger.completed(head: head) }
            for id in finished {
                let since = diag.firstQueuedMs.removeValue(forKey: id).map { now - $0 } ?? -1
                playedNotes.append("event=segment_played segment_id=\(id) since_first_audio_ms=\(since)")
            }
            // After a flush the ledger is empty, so this also ends the window of a barge-in.
            if diag.wasPlaying && !ledger.isPlaying(head: head) {
                let starved = onset == nil ? ledger.openSegmentId : nil
                let ended = onset != nil ? "barge_in" : (diag.windowFlushes != diag.flushes ? "flushed" : (starved != nil ? "starved" : "drained"))
                let mean = diag.listenFrames > 0 ? diag.sumLevel / Float(diag.listenFrames) : 0
                windowNote = "event=playback_idle ended=\(ended) window_ms=\(now - diag.windowStartMs) listen_frames=\(diag.listenFrames) over_threshold_frames=\(diag.overFrames) longest_over_ms=\(diag.longestRunMs) max_rms=\(VoiceLog.f(diag.maxLevel)) mean_rms=\(VoiceLog.f(mean)) threshold=\(VoiceLog.f(detector.threshold)) min_speech_ms=\(detector.minSpeechMs) open_segment_id=\(starved ?? -1)"
                diag.wasPlaying = false
                diag.runMs = 0
            }
            if now - diag.lastStatsMs >= 10_000 {
                statsNote = "event=capture_stats window_ms=\(now - diag.lastStatsMs) frames=\(diag.frames) blocks=\(diag.captureBlocks) bytes=\(diag.captureBytes) convert_errors=\(diag.convertErrors) paused_frames=\(diag.pausedFrames) max_rms=\(VoiceLog.f(diag.maxCaptureLevel)) queued_chunks=\(diag.queuedChunks) queued_bytes=\(diag.queuedBytes) engine_running=\(engine.isRunning)"
                diag.lastStatsMs = now
                diag.maxCaptureLevel = 0
            }
        }
        VoiceLog.debug("event=capture_frame rms=\(VoiceLog.f(level)) bytes=\(frame.count)")
        if let onsetNote { VoiceLog.info(onsetNote) }
        if let windowNote { VoiceLog.info(windowNote) }
        for note in playedNotes { VoiceLog.info(note) }
        if let statsNote { VoiceLog.info(statsNote) }
        if let onset { hf_voice_on_onset(onset.segment, onset.playedMs) }
        for id in finished { hf_voice_on_played(UInt32(id)) }
        frame.withUnsafeBytes { raw in
            if let base = raw.bindMemory(to: UInt8.self).baseAddress {
                hf_voice_on_capture(base, frame.count)
            }
        }
    }

    // MARK: playback

    /// Queues PCM16LE mono at 24 kHz for a segment.
    func play(segmentId: Int, pcm: Data) {
        var rejection: String?
        var firstOfSegment = false
        var queuedMs: Int64 = 0
        var firstQueuedAt: Int64 = 0
        let accepted = state.sync { () -> Int? in
            guard running else {
                rejection = "not_running"
                return nil
            }
            guard interruptGuard.accepts(segmentId: segmentId, now: nowMs()) else {
                rejection = diag.rejected.insert(segmentId).inserted ? "interrupt_guard" : "interrupt_guard_repeat"
                return nil
            }
            queuedMs = ledger.pendingFrames(head: playedFrames) * 1000 / Int64(Self.outputRate)
            // The ledger learns of the audio when it is queued: the gateway runs ahead
            // of playback, so a segment's end marker can arrive before its audio plays.
            ledger.write(segmentId: segmentId, frames: pcm.count / 2)
            firstOfSegment = diag.firstQueuedMs[segmentId] == nil
            if firstOfSegment { diag.firstQueuedMs[segmentId] = nowMs() }
            firstQueuedAt = diag.firstQueuedMs[segmentId] ?? nowMs()
            diag.queuedChunks += 1
            diag.queuedBytes += pcm.count
            return generation
        }
        guard let token = accepted else {
            let line = "event=play_rejected segment_id=\(segmentId) bytes=\(pcm.count) reason=\(rejection ?? "unknown")"
            if rejection == "interrupt_guard" || rejection == "not_running" { VoiceLog.info(line) } else { VoiceLog.debug(line) }
            return
        }
        if pcm.count % 2 != 0 {
            VoiceLog.warn("event=play_odd_length segment_id=\(segmentId) bytes=\(pcm.count)")
        }
        if firstOfSegment {
            VoiceLog.info("event=segment_first_audio_queued segment_id=\(segmentId) bytes=\(pcm.count) frames=\(pcm.count / 2) queued_ms=\(queuedMs) generation=\(token)")
        } else {
            VoiceLog.debug("event=down_audio segment_id=\(segmentId) bytes=\(pcm.count) frames=\(pcm.count / 2) queued_ms=\(queuedMs) generation=\(token)")
        }
        // Build the buffers first, then schedule each one only if no flush has happened
        // since the audio was accepted: an onset flush on the capture thread can land
        // between the two, and stale buffers must not play after a barge-in.
        var buffers: [AVAudioPCMBuffer] = []
        pcm.withUnsafeBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            var offset = 0
            while offset < samples.count {
                let count = min(Self.playbackChunkFrames, samples.count - offset)
                guard let buffer = AVAudioPCMBuffer(pcmFormat: playbackFormat, frameCapacity: AVAudioFrameCount(count)),
                      let channel = buffer.floatChannelData?[0] else {
                    VoiceLog.warn("event=play_buffer_alloc_failed segment_id=\(segmentId) built_chunks=\(buffers.count) frames=\(count)")
                    return
                }
                for i in 0..<count {
                    channel[i] = Float(Int16(littleEndian: samples[offset + i])) / 32768.0
                }
                buffer.frameLength = AVAudioFrameCount(count)
                buffers.append(buffer)
                offset += count
            }
        }
        let queuedAtMs = firstQueuedAt
        let isNewSegment = firstOfSegment
        for (index, buffer) in buffers.enumerated() {
            let count = Int64(buffer.frameLength)
            let reportsFirstChunk = isNewSegment && index == 0
            audioOps.async { [weak self] in
                guard let self, self.state.sync(execute: { self.generation == token }) else {
                    VoiceLog.debug("event=schedule_skipped_stale segment_id=\(segmentId) generation=\(token)")
                    return
                }
                self.player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
                    self?.state.async {
                        guard let self, self.generation == token else { return }
                        self.playedFrames += count
                        if reportsFirstChunk {
                            VoiceLog.info("event=segment_first_chunk_played segment_id=\(segmentId) since_queued_ms=\(self.nowMs() - queuedAtMs) chunk_ms=\(count * 1000 / Int64(Self.outputRate))")
                        }
                    }
                }
            }
        }
    }

    func segmentEnd(_ segmentId: Int) {
        let pendingMs = state.sync { () -> Int64 in
            ledger.end(segmentId: segmentId)
            return ledger.pendingFrames(head: playedFrames) * 1000 / Int64(Self.outputRate)
        }
        VoiceLog.info("event=segment_end_marker segment_id=\(segmentId) pending_ms=\(pendingMs)")
    }

    /// Stops playback at once and forgets everything queued.
    func flush() {
        let (discarded, tracked, current) = state.sync { () -> (Int64, Int, Int) in
            let discarded = flushLocked()
            return (discarded, diag.firstQueuedMs.count, self.generation)
        }
        VoiceLog.info("event=playback_flush cause=gateway_stop_playback discarded_ms=\(discarded * 1000 / Int64(Self.outputRate)) open_segments=\(tracked) generation=\(current)")
    }

    /// Returns the frames that were queued and not yet played, which the flush throws away.
    @discardableResult
    private func flushLocked() -> Int64 {
        let discarded = ledger.pendingFrames(head: playedFrames)
        diag.flushes += 1
        diag.firstQueuedMs.removeAll()
        diag.rejected.removeAll()
        generation += 1
        ledger.reset()
        playedFrames = 0
        // Queued behind any schedule that was accepted before this flush, ahead of any accepted after it.
        audioOps.async { [player] in
            player.stop()
            player.play()
        }
        return discarded
    }

    /// Loops `pcm` (PCM16LE mono at 24 kHz) as the sound cue, replacing any cue; empty data stops it.
    /// The remembered cue and every operation on its node happen under `state`, so a stop from the Rust
    /// thread cannot interleave with a route-change restart replaying the old cue.
    func setCue(_ pcm: Data) {
        VoiceLog.debug("event=cue_set bytes=\(pcm.count)")
        state.sync {
            cuePCM = pcm.count >= 2 ? pcm : nil
            cuePlayer.stop()
            playCueLocked()
        }
    }

    /// Plays the cue the session last asked for, if any. The restart after a route change stops the node,
    /// and the session only asks again when the wanted cue changes, so the controller replays it itself.
    private func playCue() {
        state.sync { playCueLocked() }
    }

    /// A node must not be played while the engine is stopped (that raises an exception), so in the gap of
    /// a route change or interruption this does nothing and the restart plays the cue instead.
    private func playCueLocked() {
        guard running, interruptedAt == nil, let pcm = cuePCM, engine.isRunning else { return }
        let frames = pcm.count / 2
        guard let buffer = AVAudioPCMBuffer(pcmFormat: playbackFormat, frameCapacity: AVAudioFrameCount(frames)),
              let channel = buffer.floatChannelData?[0] else { return }
        pcm.withUnsafeBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            for i in 0..<frames {
                channel[i] = Float(Int16(littleEndian: samples[i])) / 32768.0
            }
        }
        buffer.frameLength = AVAudioFrameCount(frames)
        cuePlayer.scheduleBuffer(buffer, at: nil, options: .loops, completionHandler: nil)
        cuePlayer.play()
    }

    func pause() {
        VoiceLog.info("event=player_pause engine_running=\(engine.isRunning)")
        state.sync {
            cuePCM = nil
            cuePlayer.stop()
        }
        player.pause()
    }
    func resume() {
        let active = state.sync(execute: { running })
        VoiceLog.info("event=player_resume running=\(active) engine_running=\(engine.isRunning)")
        if active { player.play() }
    }

    // MARK: system events: interruptions, route changes, lock-screen control

    private func observeSystem(_ session: AVAudioSession) {
        let center = NotificationCenter.default
        observers.append(center.addObserver(
            forName: AVAudioSession.interruptionNotification, object: session, queue: nil
        ) { [weak self] note in self?.interruption(note) })
        // A route change (headphones, AirPods, a car) that changes the input's hardware
        // format stops the engine and posts this. The session goes on: rebuild the
        // capture path for the new format and start again.
        observers.append(center.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
        ) { [weak self] _ in self?.configurationChanged() })
        // Logged only: the route (speaker, AirPods, a car) and the rates it runs at decide how the audio sounds.
        observers.append(center.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: session, queue: nil
        ) { [weak self] note in
            let reason = VoiceLog.reason(note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt)
            let previous = (note.userInfo?[AVAudioSessionRouteChangePreviousRouteKey] as? AVAudioSessionRouteDescription)
                .map { "previous_\(VoiceLog.route($0))" } ?? "previous=unknown"
            let audio = self?.audioState(session) ?? ""
            VoiceLog.info("event=route_change reason=\(reason) \(previous) \(audio)")
        })
        observers.append(center.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: nil
        ) { _ in VoiceLog.warn("event=media_services_reset") })
    }

    private func configurationChanged() {
        let active = state.sync { running && interruptedAt == nil }
        VoiceLog.info("event=engine_configuration_change active=\(active) engine_running=\(engine.isRunning) \(engineFormats())")
        // During an interruption the end of the interruption restarts the audio.
        guard active else { return }
        if !restartAudio() { endSession("error") }
    }

    private func interruption(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        switch type {
        case .began:
            var reason = "unknown"
            if #available(iOS 14.5, *),
               let raw = note.userInfo?[AVAudioSessionInterruptionReasonKey] as? UInt,
               let value = AVAudioSession.InterruptionReason(rawValue: raw) {
                reason = "\(value)"
            }
            VoiceLog.info("event=interruption_began reason=\(reason)")
            state.sync { interruptedAt = DispatchTime.now() }
            hf_voice_on_interruption(true, 0)
        case .ended:
            let began = state.sync { () -> DispatchTime? in
                let value = interruptedAt
                interruptedAt = nil
                return value
            }
            let options = (note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt)
                .map(AVAudioSession.InterruptionOptions.init(rawValue:)) ?? []
            // Without `.shouldResume`, or if the audio cannot be brought back, the
            // session ends the way a permanent loss of audio focus does on Android.
            let suspended = began.map { (DispatchTime.now().uptimeNanoseconds - $0.uptimeNanoseconds) / 1_000_000 } ?? 0
            VoiceLog.info("event=interruption_ended should_resume=\(options.contains(.shouldResume)) suspended_ms=\(suspended)")
            guard options.contains(.shouldResume),
                  (try? AVAudioSession.sharedInstance().setActive(true)) != nil,
                  restartAudio() else {
                endSession("interruption")
                return
            }
            hf_voice_on_interruption(false, suspended)
        @unknown default:
            break
        }
    }

    private func showLockScreenControl() {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle: "Voice mode on",
            MPMediaItemPropertyArtist: "Hundredfold",
            MPNowPlayingInfoPropertyPlaybackRate: 1.0,
            MPNowPlayingInfoPropertyIsLiveStream: true,
        ]
        let commands = MPRemoteCommandCenter.shared()
        for command in [commands.pauseCommand, commands.stopCommand, commands.togglePlayPauseCommand] {
            command.isEnabled = true
            command.addTarget { _ in
                VoiceLog.info("event=lock_screen_command")
                "lock_screen".withCString { hf_voice_on_stop($0) }
                return .success
            }
        }
        UIApplication.shared.beginReceivingRemoteControlEvents()
    }

    private func hideLockScreenControl() {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        let commands = MPRemoteCommandCenter.shared()
        for command in [commands.pauseCommand, commands.stopCommand, commands.togglePlayPauseCommand] {
            command.removeTarget(nil)
        }
        UIApplication.shared.endReceivingRemoteControlEvents()
    }
}

// MARK: C ABI called by Rust (declared in src/ios.rs)

@_cdecl("hf_voice_request_permissions")
public func hf_voice_request_permissions() -> Bool { VoiceController.shared.requestPermissions() }

@_cdecl("hf_voice_start")
public func hf_voice_start(_ handsFree: Bool) -> Bool { VoiceController.shared.start(handsFree: handsFree) }

@_cdecl("hf_voice_configure_onset")
public func hf_voice_configure_onset(_ threshold: Float, _ minSpeechMs: UInt32) {
    VoiceController.shared.configureOnset(threshold: threshold, minSpeechMs: Int(minSpeechMs))
}

@_cdecl("hf_voice_play")
public func hf_voice_play(_ segmentId: UInt32, _ pcm: UnsafePointer<UInt8>?, _ length: Int) {
    guard let pcm, length > 0 else { return }
    // Copied before returning: the Rust buffer is only valid for the call.
    VoiceController.shared.play(segmentId: Int(segmentId), pcm: Data(bytes: pcm, count: length))
}

@_cdecl("hf_voice_segment_end")
public func hf_voice_segment_end(_ segmentId: UInt32) { VoiceController.shared.segmentEnd(Int(segmentId)) }

@_cdecl("hf_voice_set_cue")
public func hf_voice_set_cue(_ pcm: UnsafePointer<UInt8>?, _ length: Int) {
    guard let pcm, length > 0 else {
        VoiceController.shared.setCue(Data())
        return
    }
    // Copied before returning: the Rust buffer is only valid for the call.
    VoiceController.shared.setCue(Data(bytes: pcm, count: length))
}

@_cdecl("hf_voice_flush")
public func hf_voice_flush() { VoiceController.shared.flush() }

@_cdecl("hf_voice_pause")
public func hf_voice_pause() { VoiceController.shared.pause() }

@_cdecl("hf_voice_resume")
public func hf_voice_resume() { VoiceController.shared.resume() }

@_cdecl("hf_voice_stop")
public func hf_voice_stop() { VoiceController.shared.stop() }

/// One diagnostic line from the Rust side (UTF-8, `length` bytes, no NUL); `level` is 0 debug, 1 info, 2 warning.
@_cdecl("hf_voice_log")
public func hf_voice_log(_ level: UInt8, _ line: UnsafePointer<UInt8>?, _ length: Int) {
    guard let line, length > 0 else { return }
    VoiceLog.core(level: level, String(decoding: UnsafeBufferPointer(start: line, count: length), as: UTF8.self))
}
