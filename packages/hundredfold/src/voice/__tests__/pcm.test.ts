import { describe, expect, it } from "vitest";
import { VOICE_AUDIO_HEADER_BYTES, VOICE_AUDIO_KIND } from "../../shared/gateway-events.js";
import { audioFrameHeader, MAX_OUTPUT_PCM_BYTES, pcmDurationMs, Pcm16Resampler, pcmPieces } from "../pcm.js";

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
