/** PCM16LE helpers for the voice wire: resampling provider output to the wire rate, and framing it. */
import { VOICE_AUDIO_HEADER_BYTES, VOICE_AUDIO_KIND } from "../shared/gateway-events.js";

/** Largest PCM payload in one downstream frame (contracts/voice-socket.md). */
export const MAX_OUTPUT_PCM_BYTES = 16 * 1024;

/**
 * Streaming linear resampler for PCM16LE mono. Chunks may split a sample; the
 * odd byte and the interpolation phase carry to the next call. Equal rates pass
 * through untouched.
 */
export class Pcm16Resampler {
  private readonly step: number;
  private carry: number | null = null;
  private last: number | null = null;
  /** Where the next output sample falls, counting the carried sample as 0 and the chunk's first as 1. */
  private phase = 1;

  constructor(from: number, to: number) {
    this.step = from / to;
  }

  push(chunk: Buffer): Buffer {
    if (this.step === 1) return chunk;
    const bytes = this.carry === null ? chunk : Buffer.concat([Buffer.from([this.carry]), chunk]);
    const count = bytes.length >> 1;
    this.carry = bytes.length & 1 ? bytes[bytes.length - 1] : null;
    if (count === 0) return Buffer.alloc(0);
    const sample = (i: number): number => (i === 0 ? (this.last ?? bytes.readInt16LE(0)) : bytes.readInt16LE((i - 1) * 2));
    const out: number[] = [];
    let q = this.phase;
    while (q < count) {
      const i = Math.floor(q);
      const frac = q - i;
      out.push(Math.round(sample(i) * (1 - frac) + sample(i + 1) * frac));
      q += this.step;
    }
    this.phase = q - count;
    this.last = sample(count);
    const result = Buffer.alloc(out.length * 2);
    out.forEach((value, index) => result.writeInt16LE(Math.max(-32768, Math.min(32767, value)), index * 2));
    return result;
  }
}

/** The header of a downstream audio frame. */
export function audioFrameHeader(seq: number, segmentId: number): Buffer {
  const header = Buffer.alloc(VOICE_AUDIO_HEADER_BYTES);
  header.writeUInt8(VOICE_AUDIO_KIND, 0);
  header.writeUInt8(0, 1);
  header.writeUInt16LE(seq & 0xffff, 2);
  header.writeUInt32LE(segmentId >>> 0, 4);
  return header;
}

/** Cut PCM into frame-sized pieces that never split a sample. */
export function* pcmPieces(pcm: Buffer): Generator<Buffer> {
  for (let at = 0; at < pcm.length; at += MAX_OUTPUT_PCM_BYTES) {
    yield pcm.subarray(at, Math.min(pcm.length, at + MAX_OUTPUT_PCM_BYTES));
  }
}

/** Milliseconds of audio in `bytes` of PCM16LE mono at `sampleRate`. */
export function pcmDurationMs(bytes: number, sampleRate: number): number {
  return (bytes / 2 / sampleRate) * 1000;
}
