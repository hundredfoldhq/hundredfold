import { beforeEach, describe, expect, it, vi } from "vitest"
import { VoicePlayer } from "../player"
import { FakeAudioContext, pcm } from "./fakes"

let ctx: FakeAudioContext
let played: number[]
let player: VoicePlayer

beforeEach(() => {
  ctx = new FakeAudioContext()
  played = []
  player = new VoicePlayer(ctx, { onPlayed: (id) => played.push(id) })
})

/** 0.5 s of audio at 24 kHz. */
const HALF_SECOND = 12_000

describe("VoicePlayer scheduling", () => {
  it("schedules chunks back to back on the context clock", () => {
    player.beginSegment(1)
    player.enqueue(1, pcm(HALF_SECOND))
    player.enqueue(1, pcm(HALF_SECOND))
    const [a, b] = ctx.sources
    expect(a.startedAt).toBeGreaterThan(0)
    expect(b.startedAt).toBeCloseTo(a.startedAt! + 0.5, 6)
  })

  it("starts late chunks at the current time, not in the past", () => {
    player.beginSegment(1)
    player.enqueue(1, pcm(HALF_SECOND))
    ctx.currentTime = 10
    player.enqueue(1, pcm(HALF_SECOND))
    expect(ctx.sources[1].startedAt!).toBeGreaterThan(10)
  })

  it("ignores audio for a segment the gateway never opened", () => {
    player.enqueue(7, pcm(HALF_SECOND))
    expect(ctx.sources).toHaveLength(0)
  })
})

describe("VoicePlayer played reports", () => {
  it("reports a segment once it is closed and its audio has run out", () => {
    player.beginSegment(1)
    player.enqueue(1, pcm(HALF_SECOND))
    player.endSegment(1)
    expect(played).toEqual([])
    ctx.sources[0].finish()
    expect(played).toEqual([1])
    expect(player.isActive()).toBe(false)
  })

  it("does not report while audio is still to come for the segment", () => {
    player.beginSegment(1)
    player.enqueue(1, pcm(HALF_SECOND))
    ctx.sources[0].finish()
    expect(played).toEqual([])
    player.enqueue(1, pcm(HALF_SECOND))
    player.endSegment(1)
    ctx.sources[1].finish()
    expect(played).toEqual([1])
  })

  it("reports at once when the end arrives after the audio already finished", () => {
    player.beginSegment(1)
    player.enqueue(1, pcm(HALF_SECOND))
    ctx.sources[0].finish()
    player.endSegment(1)
    expect(played).toEqual([1])
  })

  it("reports each segment once, in order", () => {
    for (const id of [1, 2]) {
      player.beginSegment(id)
      player.enqueue(id, pcm(HALF_SECOND))
      player.endSegment(id)
    }
    ctx.sources.forEach((s) => s.finish())
    expect(played).toEqual([1, 2])
  })
})

describe("VoicePlayer flush", () => {
  function playTwoSegments() {
    player.beginSegment(1)
    player.enqueue(1, pcm(HALF_SECOND))
    player.endSegment(1)
    player.beginSegment(2)
    player.enqueue(2, pcm(HALF_SECOND))
  }

  it("stops every source synchronously, within the call, with no timers involved", () => {
    vi.useFakeTimers()
    try {
      playTwoSegments()
      player.flush()
      expect(ctx.sources.every((s) => s.stoppedAt === 0 && s.disconnected)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("reports where playback was: the segment under the playhead and how much of it played", () => {
    playTwoSegments()
    const start = ctx.sources[0].startedAt!
    ctx.currentTime = start + 0.2
    expect(player.flush()).toEqual({ segmentId: 1, playedMs: 200 })
  })

  it("reports the second segment once the first is behind the playhead", () => {
    playTwoSegments()
    ctx.currentTime = ctx.sources[1].startedAt! + 0.1
    const cut = player.flush()
    expect(cut?.segmentId).toBe(2)
    expect(cut?.playedMs).toBe(100)
  })

  it("names no segment when nothing has started yet", () => {
    playTwoSegments()
    ctx.currentTime = 0
    expect(player.flush()).toEqual({ segmentId: null, playedMs: 0 })
  })

  it("never reports more than a segment's own length as played", () => {
    player.beginSegment(1)
    player.enqueue(1, pcm(HALF_SECOND))
    ctx.currentTime = 99
    expect(player.flush()).toEqual({ segmentId: 1, playedMs: 500 })
  })

  it("returns null when nothing was active", () => {
    expect(player.flush()).toBeNull()
  })

  it("does not report a flushed segment as played, even if its source ends later", () => {
    playTwoSegments()
    const [first] = ctx.sources
    player.flush()
    first.finish()
    expect(played).toEqual([])
  })

  it("drops audio still in flight for the interrupted reply, until the gateway opens a segment again", () => {
    playTwoSegments()
    player.flush()
    const before = ctx.sources.length
    player.enqueue(2, pcm(HALF_SECOND))
    expect(ctx.sources).toHaveLength(before)
    player.beginSegment(3)
    player.enqueue(3, pcm(HALF_SECOND))
    expect(ctx.sources).toHaveLength(before + 1)
  })

  it("restarts the schedule from the clock after a flush", () => {
    playTwoSegments()
    ctx.currentTime = 1
    player.flush()
    player.beginSegment(3)
    player.enqueue(3, pcm(HALF_SECOND))
    expect(ctx.sources.at(-1)!.startedAt!).toBeLessThan(1.1)
  })
})

describe("VoicePlayer at a non-default speaking speed", () => {
  // The gateway makes the audio faster, so a sentence arrives shorter and plays at the clock's own rate. The played
  // share the gateway uses to decide what was heard is then a share of the shorter audio, with no rate to correct for.
  const NORMAL = 24_000 // 1.0 s of the sentence at speed 1
  const FAST = 16_000 // the same sentence at 1.5x: 0.667 s

  it("reports the played time of the audio it was given, not of the length it would have had at speed 1", () => {
    player.beginSegment(1)
    player.enqueue(1, pcm(FAST))
    const start = ctx.sources[0].startedAt!
    ctx.currentTime = start + 0.2
    expect(player.position()).toEqual({ segmentId: 1, playedMs: 200 })
    ctx.currentTime = start + 5
    // Past the end it is capped at the audio's own length.
    expect(player.position().playedMs).toBe(667)
  })

  it("a barge-in cut half way through a fast sentence reports half of the fast sentence", () => {
    player.beginSegment(1)
    player.enqueue(1, pcm(FAST))
    ctx.currentTime = ctx.sources[0].startedAt! + FAST / 24_000 / 2
    expect(player.flush()).toEqual({ segmentId: 1, playedMs: 333 })
    player.beginSegment(2)
    player.enqueue(2, pcm(NORMAL))
    ctx.currentTime = ctx.sources[1].startedAt! + 0.5
    expect(player.flush()).toEqual({ segmentId: 2, playedMs: 500 })
  })

  it("reports a fast segment played when its shorter audio has run out", () => {
    player.beginSegment(1)
    player.enqueue(1, pcm(FAST))
    player.endSegment(1)
    ctx.sources[0].finish()
    expect(played).toEqual([1])
  })
})
