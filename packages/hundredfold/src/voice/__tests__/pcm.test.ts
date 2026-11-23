import { describe, expect, it } from "vitest";
import { VOICE_AUDIO_HEADER_BYTES, VOICE_AUDIO_KIND } from "../../shared/gateway-events.js";
import { audioFrameHeader, MAX_OUTPUT_PCM_BYTES, pcmDurationMs, Pcm16Resampler, Pcm16TimeStretcher, pcmPieces } from "../pcm.js";

function ramp(samples: number, scale = 100): Buffer {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) buf.writeInt16LE(i * scale, i * 2);
  return buf;
}

describe("Pcm16Resampler", () => {
  it("passes equal rates through untouched", () => {
    const chunk = ramp(10);
    expect(new Pcm16Resampler(24_000, 24_000).push(chunk)).toBe(chunk);
  });

  it("equal rates still keep samples whole: a chunk that ends mid-sample waits for its other byte", () => {
    const r = new Pcm16Resampler(24_000, 24_000);
    const whole = ramp(5);
    const first = r.push(whole.subarray(0, 5));
    const second = r.push(whole.subarray(5));
    expect(first.length % 2).toBe(0);
    expect(Buffer.concat([first, second]).equals(whole)).toBe(true);
    const even = ramp(3);
    expect(r.push(even)).toBe(even);
  });

  it("makes 3 output samples for every 2 input samples going 16 kHz to 24 kHz", () => {
    const out = new Pcm16Resampler(16_000, 24_000).push(ramp(160));
    expect(Math.abs(out.length / 2 - 240)).toBeLessThanOrEqual(2);
  });

  it("interpolates a ramp, so a constant slope stays a constant slope", () => {
    const out = new Pcm16Resampler(16_000, 24_000).push(ramp(100, 90));
    const samples = Array.from({ length: out.length / 2 }, (_, i) => out.readInt16LE(i * 2));
    const steps = samples.slice(1).map((v, i) => v - samples[i]);
    for (const step of steps.slice(1)) expect(Math.abs(step - steps[1])).toBeLessThanOrEqual(1);
  });

  it("gives the same samples whether the audio arrives whole or in awkward pieces, including odd byte splits", () => {
    const whole = ramp(400, 37);
    const expected = new Pcm16Resampler(22_050, 24_000).push(whole);
    const resampler = new Pcm16Resampler(22_050, 24_000);
    const pieces: Buffer[] = [];
    for (let at = 0; at < whole.length; at += 77) pieces.push(resampler.push(whole.subarray(at, at + 77)));
    const joined = Buffer.concat(pieces);
    expect(Math.abs(joined.length - expected.length)).toBeLessThanOrEqual(4);
    const n = (Math.min(joined.length, expected.length) - 4) / 2;
    for (let i = 0; i < n; i += 1) expect(Math.abs(joined.readInt16LE(i * 2) - expected.readInt16LE(i * 2))).toBeLessThanOrEqual(1);
  });

  it("clips rather than wrapping", () => {
    const loud = Buffer.alloc(8);
    [32767, 32767, -32768, -32768].forEach((v, i) => loud.writeInt16LE(v, i * 2));
    const out = new Pcm16Resampler(8_000, 24_000).push(loud);
    for (let i = 0; i < out.length / 2; i += 1) expect(Math.abs(out.readInt16LE(i * 2))).toBeLessThanOrEqual(32768);
  });
});

describe("downstream framing", () => {
  it("writes the 8-byte header the contract names", () => {
    const header = audioFrameHeader(65_537, 4_000_000_000);
    expect(header.length).toBe(VOICE_AUDIO_HEADER_BYTES);
    expect(header.readUInt8(0)).toBe(VOICE_AUDIO_KIND);
    expect(header.readUInt8(1)).toBe(0);
    expect(header.readUInt16LE(2)).toBe(1);
    expect(header.readUInt32LE(4)).toBe(4_000_000_000);
  });

  it("cuts PCM into frames of at most 16 KB that never split a sample", () => {
    const pcm = Buffer.alloc(MAX_OUTPUT_PCM_BYTES * 2 + 100);
    const pieces = [...pcmPieces(pcm)];
    expect(pieces.map((p) => p.length)).toEqual([MAX_OUTPUT_PCM_BYTES, MAX_OUTPUT_PCM_BYTES, 100]);
    expect(pieces.every((p) => p.length % 2 === 0)).toBe(true);
  });

  it("counts milliseconds of audio", () => {
    expect(pcmDurationMs(48_000, 24_000)).toBe(1000);
  });
});

/** A 24 kHz tone with a voice-like second harmonic, `ms` long. */
function tone(hz: number, ms: number): Buffer {
  const samples = Math.round((24_000 * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const t = i / 24_000;
    buf.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * hz * t) + 3000 * Math.sin(4 * Math.PI * hz * t)), i * 2);
  }
  return buf;
}

/** Rising zero crossings per second: the pitch of a clean tone. */
function pitchOf(pcm: Buffer): number {
  let crossings = 0;
  for (let i = 1; i < pcm.length / 2; i += 1) if (pcm.readInt16LE((i - 1) * 2) < 0 && pcm.readInt16LE(i * 2) >= 0) crossings += 1;
  return crossings / (pcm.length / 2 / 24_000);
}

function stretch(input: Buffer, speed: number, chunkBytes = input.length): Buffer {
  const stretcher = new Pcm16TimeStretcher(speed);
  const out: Buffer[] = [];
  for (let at = 0; at < input.length; at += chunkBytes) out.push(stretcher.push(input.subarray(at, at + chunkBytes)));
  out.push(stretcher.flush());
  return Buffer.concat(out);
}

describe("Pcm16TimeStretcher", () => {
  it.each([0.8, 1.25, 1.5, 2])("makes audio %sx as long and keeps the pitch", (speed) => {
    const input = tone(180, 2000);
    const out = stretch(input, speed);
    const ratio = out.length / input.length;
    expect(ratio).toBeGreaterThan((1 / speed) * 0.96);
    expect(ratio).toBeLessThan((1 / speed) * 1.06);
    expect(Math.abs(pitchOf(out) - 180)).toBeLessThan(12);
  });

  it("gives the same audio however the input is split into chunks, even mid-sample", () => {
    const input = tone(150, 800);
    const whole = stretch(input, 1.5);
    expect(stretch(input, 1.5, 4001).equals(whole)).toBe(true);
    expect(stretch(input, 1.5, 7).equals(whole)).toBe(true);
  });

  it("does not clip or add a click at the seams of a loud tone", () => {
    const out = stretch(tone(200, 1000), 1.5);
    let peak = 0;
    let biggestStep = 0;
    for (let i = 0; i < out.length / 2; i += 1) {
      peak = Math.max(peak, Math.abs(out.readInt16LE(i * 2)));
      if (i > 0) biggestStep = Math.max(biggestStep, Math.abs(out.readInt16LE(i * 2) - out.readInt16LE((i - 1) * 2)));
    }
    expect(peak).toBeLessThan(14_000);
    expect(biggestStep).toBeLessThan(4000);
  });

  it("returns nothing for no input, and a short input still comes out", () => {
    expect(stretch(Buffer.alloc(0), 1.5)).toHaveLength(0);
    const short = stretch(tone(200, 20), 1.5);
    expect(short.length).toBeGreaterThan(0);
    expect(short.length).toBeLessThan(tone(200, 20).length * 1.5);
  });
});
