import Foundation

// Pure logic of native voice, mirroring the Kotlin classes of the same names in
// gen/android/.../voice/ (which have JVM unit tests). Nothing here touches audio
// or the system, so it can be unit tested on a Mac without a device.

/// The client's playback-stopping onset detector: RMS over 20 ms frames, fired
/// once the level has held at or above the threshold for `minSpeechMs`.
struct OnsetDetector {
    var threshold: Float = 0.05
    var minSpeechMs: Int = 200
    private let frameMs = 20
    private var heldMs = 0

    mutating func configure(threshold: Float, minSpeechMs: Int) {
        self.threshold = threshold
        self.minSpeechMs = minSpeechMs
        heldMs = 0
    }

    /// Feed one frame's level; true when speech has held long enough.
    mutating func feed(_ level: Float) -> Bool {
        heldMs = level >= threshold ? heldMs + frameMs : 0
        if heldMs >= minSpeechMs {
            heldMs = 0
            return true
        }
        return false
    }

    mutating func reset() { heldMs = 0 }

    /// RMS of PCM16 little-endian mono samples, normalised to 0...1.
    static func rms(_ samples: UnsafeBufferPointer<Int16>) -> Float {
        guard !samples.isEmpty else { return 0 }
        var sum = 0.0
        for sample in samples {
            let value = Double(Int16(littleEndian: sample))
            sum += value * value
        }
        return Float((sum / Double(samples.count)).squareRoot() / 32768.0)
    }
}

/// Accounts for which segment is under the playback head, so the client can say
/// how much of a segment played before a barge-in and report each segment that
/// played in full. Positions are frames queued since the last flush; the caller
/// passes the number of frames that have finished playing since then.
struct PlaybackLedger {
    private struct Segment {
        let id: Int
        let startFrame: Int64
        var endFrame: Int64
        var ended = false
    }

    let sampleRate: Int
    private var segments: [Segment] = []
    private var written: Int64 = 0

    init(sampleRate: Int) { self.sampleRate = sampleRate }

    mutating func write(segmentId: Int, frames: Int) {
        if var last = segments.last, last.id == segmentId, !last.ended {
            written += Int64(frames)
            last.endFrame = written
            segments[segments.count - 1] = last
        } else {
            let start = written
            written += Int64(frames)
            segments.append(Segment(id: segmentId, startFrame: start, endFrame: written))
        }
    }

    /// The gateway sent the segment's last frame. A segment with no audio is
    /// recorded as already complete so it is still reported played.
    mutating func end(segmentId: Int) {
        if let index = segments.lastIndex(where: { $0.id == segmentId }) {
            segments[index].ended = true
        } else {
            var empty = Segment(id: segmentId, startFrame: written, endFrame: written)
            empty.ended = true
            segments.append(empty)
        }
    }

    func isPlaying(head: Int64) -> Bool { head < written }

    func currentSegment(head: Int64) -> Int? {
        guard head < written else { return nil }
        return segments.first(where: { head < $0.endFrame })?.id
    }

    func playedMs(head: Int64) -> Int64 {
        guard let segment = segments.first(where: { head < $0.endFrame }) else { return 0 }
        return max(0, head - segment.startFrame) * 1000 / Int64(sampleRate)
    }

    /// Removes and returns the ids of segments that ended and have fully played.
    mutating func completed(head: Int64) -> [Int] {
        var done: [Int] = []
        while let first = segments.first, first.ended, head >= first.endFrame {
            done.append(first.id)
            segments.removeFirst()
        }
        return done
    }

    mutating func reset() {
        segments.removeAll()
        written = 0
    }
}

/// Drops audio still in flight when the client's own onset detector stops
/// playback: the segments seen so far, and anything newer that arrives within
/// `guardMs` (the same reply still on the wire). Mirrors the Rust session's rule.
struct InterruptGuard {
    var guardMs: Int64 = 400
    private var highestSeen = -1
    private var dropThrough = -1
    private var guardUntil: Int64 = 0

    mutating func interrupted(now: Int64) {
        dropThrough = highestSeen
        guardUntil = now + guardMs
    }

    mutating func accepts(segmentId: Int, now: Int64) -> Bool {
        if segmentId > highestSeen { highestSeen = segmentId }
        if segmentId <= dropThrough { return false }
        if now < guardUntil && dropThrough >= 0 {
            dropThrough = segmentId
            return false
        }
        return true
    }
}
