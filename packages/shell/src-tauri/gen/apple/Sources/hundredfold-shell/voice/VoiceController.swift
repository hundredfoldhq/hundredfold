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
//   interruptions    a call or Siri pauses capture and playback; they resume afterwards
final class VoiceController {
    static let shared = VoiceController()

    private static let inputRate = 16_000.0
    private static let outputRate = 24_000.0
    private static let frameBytes = 640 // 20 ms of PCM16 mono at 16 kHz
    private static let playbackChunkFrames = 960 // 40 ms: the granularity of "played"

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    /// Serial queue guarding all mutable state below.
    private let state = DispatchQueue(label: "run.hundredfold.voice.state")
    private let clock = DispatchTime.now()

    private let captureFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: inputRate, channels: 1, interleaved: true)!
    private let playbackFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: outputRate, channels: 1, interleaved: false)!

    private var running = false
    private var converter: AVAudioConverter?
    private var detector = OnsetDetector()
    private var ledger = PlaybackLedger(sampleRate: Int(outputRate))
    private var interruptGuard = InterruptGuard()
    private var generation = 0
    private var playedFrames: Int64 = 0
    private var pendingCapture = Data()
    private var interruptedAt: DispatchTime?
    private var observers: [NSObjectProtocol] = []

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
        guard !running else { return false }
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
            return false
        }

        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard let converter = AVAudioConverter(from: inputFormat, to: captureFormat) else { return false }
        self.converter = converter

        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: playbackFormat)
        input.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] buffer, _ in
            self?.capture(buffer)
        }
        do {
            engine.prepare()
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            engine.detach(player)
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
        let wasRunning = state.sync { () -> Bool in
            let was = running
            running = false
            generation += 1
            return was
        }
        guard wasRunning else { return }
        engine.inputNode.removeTap(onBus: 0)
        player.stop()
        engine.stop()
        engine.detach(player)
        observers.forEach(NotificationCenter.default.removeObserver)
        observers.removeAll()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        DispatchQueue.main.async { self.hideLockScreenControl() }
    }

    // MARK: onset detection and capture

    func configureOnset(threshold: Float, minSpeechMs: Int) {
        state.sync { detector.configure(threshold: threshold, minSpeechMs: minSpeechMs) }
    }

    /// Converts the tap's buffer to 16 kHz PCM16 and hands out exact 20 ms frames.
    private func capture(_ buffer: AVAudioPCMBuffer) {
        guard let converter else { return }
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
                player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
                    self?.state.async {
                        guard let self, self.generation == token else { return }
                        self.playedFrames += Int64(count)
                    }
                }
                offset += count
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
        player.stop()
        player.play()
        ledger.reset()
        playedFrames = 0
    }

    func pause() { player.pause() }
    func resume() { if running { player.play() } }

    // MARK: system events: interruptions, route changes, lock-screen control

    private func observeSystem(_ session: AVAudioSession) {
        let center = NotificationCenter.default
        observers.append(center.addObserver(
            forName: AVAudioSession.interruptionNotification, object: session, queue: nil
        ) { [weak self] note in self?.interruption(note) })
        observers.append(center.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: session, queue: nil
        ) { [weak self] _ in
            // Headphones coming or going keep the session going.
            guard let self, self.running, !self.engine.isRunning else { return }
            try? self.engine.start()
            self.player.play()
        })
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
            try? AVAudioSession.sharedInstance().setActive(true)
            if !engine.isRunning { try? engine.start() }
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

@_cdecl("hf_voice_flush")
public func hf_voice_flush() { VoiceController.shared.flush() }

@_cdecl("hf_voice_pause")
public func hf_voice_pause() { VoiceController.shared.pause() }

@_cdecl("hf_voice_resume")
public func hf_voice_resume() { VoiceController.shared.resume() }

@_cdecl("hf_voice_stop")
public func hf_voice_stop() { VoiceController.shared.stop() }
