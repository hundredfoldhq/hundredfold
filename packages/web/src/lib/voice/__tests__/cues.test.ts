import { describe, expect, it } from "vitest"
import { CUE_PATTERNS, CUE_PEAK, DEFAULT_CUE_SETTINGS, parseCueSettings, renderCueLoop, VoiceCuePlayer, wantedCue, type CueInputs, type VoiceCue } from "../cues"
import { FakeAudioContext } from "./fakes"

const base: CueInputs = { settings: DEFAULT_CUE_SETTINGS, running: true, turn: "idle", hearing: false, speechAudible: false, toolBackgrounded: false }
const wanted = (over: Partial<CueInputs>) => wantedCue({ ...base, ...over })

describe("which cue is wanted", () => {
  it.each([
    ["idle", null], ["speaking", null], ["thinking", "thinking"], ["working", "tool"],
  ] as const)("a %s turn wants %s", (turn, cue) => {
    expect(wanted({ turn })).toBe(cue)
  })

  it("wants nothing when cues are off, silent, or voice mode is not running", () => {
    expect(wanted({ turn: "thinking", settings: { enabled: false, volume: 0.3 } })).toBeNull()
    expect(wanted({ turn: "thinking", settings: { enabled: true, volume: 0 } })).toBeNull()
    expect(wanted({ turn: "thinking", running: false })).toBeNull()
  })

  it("wants nothing while the user is heard or speech is audible", () => {
    expect(wanted({ turn: "working", hearing: true })).toBeNull()
    expect(wanted({ turn: "thinking", speechAudible: true })).toBeNull()
  })

  it("a backgrounded tool is no longer a tool cue", () => {
    expect(wanted({ turn: "working", toolBackgrounded: true })).toBe("thinking")
  })
})

describe("cue settings", () => {
  it("defaults on at a low volume", () => {
    expect(DEFAULT_CUE_SETTINGS).toEqual({ enabled: true, volume: 0.3 })
  })

  it.each([
    [undefined, { enabled: true, volume: 0.3 }],
    [null, { enabled: true, volume: 0.3 }],
    ["loud", { enabled: true, volume: 0.3 }],
    [[], { enabled: true, volume: 0.3 }],
    [{}, { enabled: true, volume: 0.3 }],
    [{ enabled: "no", volume: "high" }, { enabled: true, volume: 0.3 }],
    [{ enabled: false }, { enabled: false, volume: 0.3 }],
    [{ volume: 5 }, { enabled: true, volume: 1 }],
    [{ volume: -1 }, { enabled: true, volume: 0 }],
    [{ volume: Number.NaN }, { enabled: true, volume: 0.3 }],
    [{ enabled: true, volume: 0.55, extra: 1 }, { enabled: true, volume: 0.55 }],
  ])("reads %j as %j", (raw, expected) => {
    expect(parseCueSettings(raw)).toEqual(expected)
  })
})

describe("the two sounds", () => {
  const rms = (a: Float32Array) => Math.sqrt(a.reduce((sum, v) => sum + v * v, 0) / a.length)

  it.each<VoiceCue>(["thinking", "tool"])("%s is a loop of the declared length with a peak of at most 1", (cue) => {
    const loop = renderCueLoop(cue, 24_000)
    expect(loop.length).toBe(Math.round((CUE_PATTERNS[cue].loopMs * 24_000) / 1000))
    const peak = loop.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
    expect(peak).toBeGreaterThan(0.5)
    expect(peak).toBeLessThanOrEqual(1)
  })

  it.each<VoiceCue>(["thinking", "tool"])("%s is silent until its first note and mostly silent after", (cue) => {
    const loop = renderCueLoop(cue, 24_000)
    const first = Math.round((CUE_PATTERNS[cue].blips[0].atMs * 24_000) / 1000)
    expect(loop.subarray(0, first).every((v) => v === 0)).toBe(true)
    const active = loop.reduce((n, v) => n + (v !== 0 ? 1 : 0), 0)
    expect(active / loop.length).toBeLessThan(0.15)
  })

  it.each<VoiceCue>(["thinking", "tool"])("%s notes fade in and out from zero, so nothing clicks", (cue) => {
    const loop = renderCueLoop(cue, 24_000)
    expect(loop[0]).toBe(0)
    expect(loop[loop.length - 1]).toBe(0)
    let first = 0
    while (loop[first] === 0) first++
    let last = loop.length - 1
    while (loop[last] === 0) last--
    // The envelope is zero at both ends of a tick, so the first and last audible samples are tiny.
    expect(Math.abs(loop[first])).toBeLessThan(0.01)
    expect(Math.abs(loop[last])).toBeLessThan(0.01)
  })

  it("no note is long enough to be speech, and the notes of a pair are clearly apart", () => {
    for (const cue of ["thinking", "tool"] as const) {
      const { blips } = CUE_PATTERNS[cue]
      for (const blip of blips) expect(blip.durMs).toBeLessThanOrEqual(150)
      for (let i = 1; i < blips.length; i++) expect(blips[i].atMs - (blips[i - 1].atMs + blips[i - 1].durMs)).toBeGreaterThanOrEqual(60)
    }
  })

  it.each<VoiceCue>(["thinking", "tool"])("%s is made of plain sines: each note crosses zero as often as its pitch says, with no overtones", (cue) => {
    const loop = renderCueLoop(cue, 24_000)
    for (const blip of CUE_PATTERNS[cue].blips) {
      const start = Math.round((blip.atMs * 24_000) / 1000)
      const length = Math.round((blip.durMs * 24_000) / 1000)
      let crossings = 0
      for (let i = start + 1; i < start + length; i++) if ((loop[i - 1] < 0) !== (loop[i] < 0)) crossings++
      expect(Math.abs(crossings - 2 * blip.hz * (blip.durMs / 1000))).toBeLessThanOrEqual(2)
    }
  })

  it("every note is warm: a pitch between 300 and 500 Hz, never the thin top of a speaker", () => {
    for (const cue of ["thinking", "tool"] as const) {
      for (const blip of CUE_PATTERNS[cue].blips) {
        expect(blip.hz).toBeGreaterThanOrEqual(300)
        expect(blip.hz).toBeLessThanOrEqual(500)
      }
    }
  })

  it("the loudest allowed cue, played straight into the microphone, stays under the default onset threshold's hold", () => {
    // Worst case with no echo cancelling at all: the speaker level arrives at the microphone unchanged, at volume 1.
    const loop = renderCueLoop("thinking", 16_000)
    const frame = 320
    let held = 0, longest = 0
    for (let i = 0; i + frame <= loop.length; i += frame) {
      const level = CUE_PEAK * rms(loop.subarray(i, i + frame))
      held = level >= 0.02 ? held + 20 : 0
      longest = Math.max(longest, held)
    }
    expect(longest).toBeLessThan(250)
  })

  it("renders the same samples as the native synthesiser (voice-core/src/cues.rs holds the same table)", () => {
    const table: Record<VoiceCue, Array<[number, number]>> = {
      thinking: [[7313, -0.02531], [7900, 0.320016], [8500, 0.957177], [9400, -0.199022], [10300, -0.022183]],
      tool: [[7313, -0.038685], [8100, 0.518108], [9000, 0.382102], [9700, 0.011182], [12150, -0.085925], [12800, -0.865985], [13700, 0.444789], [14500, -0.012206]],
    }
    for (const cue of ["thinking", "tool"] as const) {
      const loop = renderCueLoop(cue, 24_000)
      for (const [index, expected] of table[cue]) expect(Math.abs(loop[index] - expected)).toBeLessThan(1e-5)
    }
  })

  it("the two cues differ in pitch and rhythm: a rising pair against a single note", () => {
    const [low, high] = CUE_PATTERNS.tool.blips
    expect(CUE_PATTERNS.thinking.blips).toHaveLength(1)
    expect(high.hz).toBeGreaterThan(low.hz)
    expect([low.hz, high.hz]).not.toContain(CUE_PATTERNS.thinking.blips[0].hz)
    expect(CUE_PATTERNS.tool.loopMs).not.toBe(CUE_PATTERNS.thinking.loopMs)
  })
})

describe("the cue player", () => {
  it("loops a cue at the scaled volume, and the same cue again changes nothing but the volume", () => {
    const ctx = new FakeAudioContext()
    const player = new VoiceCuePlayer(ctx)
    player.set("thinking", 0.5)
    expect(ctx.sources).toHaveLength(1)
    expect(ctx.sources[0]).toMatchObject({ loop: true, startedAt: 0 })
    expect(ctx.gains[0].gain.value).toBeCloseTo(CUE_PEAK * 0.5)
    player.set("thinking", 0.25)
    expect(ctx.sources).toHaveLength(1)
    expect(ctx.gains[0].gain.value).toBeCloseTo(CUE_PEAK * 0.25)
  })

  it("switching fades the old cue out and starts the new one", () => {
    const ctx = new FakeAudioContext()
    const player = new VoiceCuePlayer(ctx)
    player.set("thinking", 0.3)
    ctx.currentTime = 2
    player.set("tool", 0.3)
    expect(ctx.sources).toHaveLength(2)
    expect(ctx.sources[0].stoppedAt).toBeGreaterThan(2)
    expect(ctx.sources[0].stoppedAt).toBeLessThan(2.1)
    expect(ctx.gains[0].calls.at(-1)).toMatch(/^ramp 0 @2\.0/)
    expect(ctx.sources[1]).toMatchObject({ loop: true, startedAt: 2 })
  })

  it("null stops it, and stopping when nothing plays does nothing", () => {
    const ctx = new FakeAudioContext()
    const player = new VoiceCuePlayer(ctx)
    player.set(null, 0.3)
    expect(ctx.sources).toHaveLength(0)
    player.set("tool", 0.3)
    player.set(null, 0.3)
    expect(ctx.sources[0].stoppedAt).toBeGreaterThan(0)
    ctx.sources[0].finish()
    expect(ctx.sources[0].disconnected).toBe(true)
    expect(ctx.gains[0].disconnected).toBe(true)
    player.dispose()
  })

  it("renders each cue once", () => {
    const ctx = new FakeAudioContext()
    const player = new VoiceCuePlayer(ctx)
    player.set("thinking", 0.3)
    player.set(null, 0.3)
    player.set("thinking", 0.3)
    expect(ctx.sources[0].buffer).toBe(ctx.sources[1].buffer)
  })
})
