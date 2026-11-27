import AVFoundation
import MediaPlayer
import UIKit

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

    private func nowMs() -> Int64 {
        Int64((DispatchTime.now().uptimeNanoseconds - clock.uptimeNanoseconds) / 1_000_000)
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
        return granted
    }

    func start(handsFree: Bool) -> Bool {
        lifecycle.lock()
        defer { lifecycle.unlock() }
        guard !state.sync(execute: { running }) else { return false }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(
                .playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .defaultToSpeaker])
            try session.setPreferredSampleRate(Self.outputRate)
            try session.setActive(true)
            // Voice processing gives the input platform echo cancellation against
            // this app's own playback.
            try engine.inputNode.setVoiceProcessingEnabled(true)
        } catch {
            // The session may already be active: hand the audio back to other apps.
            teardown()
            return false
        }

        engine.attach(player)
        engine.attach(cuePlayer)
        playerAttached = true
        engine.connect(player, to: engine.mainMixerNode, format: playbackFormat)
        engine.connect(cuePlayer, to: engine.mainMixerNode, format: playbackFormat)
        guard installCapture() else {
            teardown()
            return false
        }
        do {
            engine.prepare()
            try engine.start()
        } catch {
            teardown()
            return false
        }
        player.play()
        state.sync {
            running = true
            detector = OnsetDetector()
            ledger.reset()
            interruptGuard = InterruptGuard()
            generation += 1
            playedFrames = 0
            pendingCapture.removeAll()
            interruptedAt = nil
        }
        observeSystem(session)
        DispatchQueue.main.async { self.showLockScreenControl() }
        return true
    }

    func stop() {
        lifecycle.lock()
        defer { lifecycle.unlock() }
        state.sync {
            running = false
            generation += 1
        }
        // Tears down whatever exists, whether or not the session got as far as running:
        // a start that failed part-way must not leave the audio session active.
        teardown()
        DispatchQueue.main.async { self.hideLockScreenControl() }
    }

    /// Releases the engine, the observers and the audio session. Safe to call at any
    /// point, any number of times.
    private func teardown() {
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
              let converter = AVAudioConverter(from: inputFormat, to: captureFormat) else { return false }
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
        guard installCapture() else { return false }
        do {
            engine.prepare()
            try engine.start()
        } catch {
            return false
        }
        player.play()
        // The restart stopped the cue's node, and the session only asks again when the wanted cue changes,
        // so play the last one it asked for.
        playCue()
        return true
    }

    /// Ends the session from the native side: the Rust side closes the socket and
    /// reports the stop with the given reason.
    private func endSession(_ reason: String) {
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
        guard error == nil, out.frameLength > 0, let channel = out.int16ChannelData else { return }
        let bytes = Data(bytes: channel[0], count: Int(out.frameLength) * MemoryLayout<Int16>.size)

        var frames: [Data] = []
        state.sync {
            guard running else { return }
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
        state.sync {
            guard running, interruptedAt == nil else { return }
            let head = playedFrames
            if ledger.isPlaying(head: head) {
                if detector.feed(level) {
                    onset = (Int64(ledger.currentSegment(head: head) ?? -1), ledger.playedMs(head: head))
                    flushLocked()
                    interruptGuard.interrupted(now: nowMs())
                }
            } else {
                detector.reset()
            }
            if onset == nil { finished = ledger.completed(head: head) }
        }
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
        let accepted = state.sync { () -> Int? in
            guard running, interruptGuard.accepts(segmentId: segmentId, now: nowMs()) else { return nil }
            // The ledger learns of the audio when it is queued: the gateway runs ahead
            // of playback, so a segment's end marker can arrive before its audio plays.
            ledger.write(segmentId: segmentId, frames: pcm.count / 2)
            return generation
        }
        guard let token = accepted else { return }
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
                      let channel = buffer.floatChannelData?[0] else { return }
                for i in 0..<count {
                    channel[i] = Float(Int16(littleEndian: samples[offset + i])) / 32768.0
                }
                buffer.frameLength = AVAudioFrameCount(count)
                buffers.append(buffer)
                offset += count
            }
        }
        for buffer in buffers {
            let count = Int64(buffer.frameLength)
            audioOps.async { [weak self] in
                guard let self, self.state.sync(execute: { self.generation == token }) else { return }
                self.player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
                    self?.state.async {
                        guard let self, self.generation == token else { return }
                        self.playedFrames += count
                    }
                }
            }
        }
    }

    func segmentEnd(_ segmentId: Int) {
        state.sync { ledger.end(segmentId: segmentId) }
    }

    /// Stops playback at once and forgets everything queued.
    func flush() {
        state.sync { flushLocked() }
    }

    private func flushLocked() {
        generation += 1
        ledger.reset()
        playedFrames = 0
        // Queued behind any schedule that was accepted before this flush, ahead of any accepted after it.
        audioOps.async { [player] in
            player.stop()
            player.play()
        }
    }

    /// Loops `pcm` (PCM16LE mono at 24 kHz) as the sound cue, replacing any cue; empty data stops it.
    /// The remembered cue and every operation on its node happen under `state`, so a stop from the Rust
    /// thread cannot interleave with a route-change restart replaying the old cue.
    func setCue(_ pcm: Data) {
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
        state.sync {
            cuePCM = nil
            cuePlayer.stop()
        }
        player.pause()
    }
    func resume() { if state.sync(execute: { running }) { player.play() } }

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
    }

    private func configurationChanged() {
        let active = state.sync { running && interruptedAt == nil }
        // During an interruption the end of the interruption restarts the audio.
        guard active else { return }
        if !restartAudio() { endSession("error") }
    }

    private func interruption(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        switch type {
        case .began:
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
            guard options.contains(.shouldResume),
                  (try? AVAudioSession.sharedInstance().setActive(true)) != nil,
                  restartAudio() else {
                endSession("interruption")
                return
            }
            let suspended = began.map { (DispatchTime.now().uptimeNanoseconds - $0.uptimeNanoseconds) / 1_000_000 } ?? 0
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
