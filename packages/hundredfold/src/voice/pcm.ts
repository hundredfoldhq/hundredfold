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

  /** Equal rates change nothing but sample alignment: a chunk may end mid-sample, and the byte waits for its pair. */
  private alignedPassThrough(chunk: Buffer): Buffer {
    if (this.carry === null && chunk.length % 2 === 0) return chunk;
    const bytes = this.carry === null ? chunk : Buffer.concat([Buffer.from([this.carry]), chunk]);
    this.carry = bytes.length & 1 ? bytes[bytes.length - 1] : null;
    return bytes.subarray(0, bytes.length - (bytes.length & 1));
  }

  push(chunk: Buffer): Buffer {
    if (this.step === 1) return this.alignedPassThrough(chunk);
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

/**
 * Streaming, pitch-preserving time stretch for PCM16LE mono (waveform-similarity overlap-add): speech comes out
 * `speed` times faster with the voice at the same pitch. It is the pace change for a provider that cannot make
 * one itself; a provider that can is asked instead, which sounds better. Chunks may split a sample.
 */
export class Pcm16TimeStretcher {
  /** A frame is 30 ms at the 24 kHz wire rate, overlapped by half; the search reaches 10 ms either way (a 100 Hz voice). */
  private static readonly FRAME = 720;
  private static readonly HOP = 360;
  private static readonly SEARCH = 240;
  private static readonly WINDOW = Float32Array.from({ length: Pcm16TimeStretcher.FRAME }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Pcm16TimeStretcher.FRAME));

  private readonly analysisHop: number;
  private input = new Float32Array(0);
  /** Absolute index of `input[0]` in the whole input stream. */
  private base = 0;
  private total = 0;
  private carry: number | null = null;
  private frame = 0;
  private prevPos = 0;
  private tail = new Float32Array(Pcm16TimeStretcher.HOP);
  private emitted = 0;

  constructor(private readonly speed: number) {
    this.analysisHop = Pcm16TimeStretcher.HOP * speed;
  }

  push(chunk: Buffer): Buffer {
    const bytes = this.carry === null ? chunk : Buffer.concat([Buffer.from([this.carry]), chunk]);
    this.carry = bytes.length & 1 ? bytes[bytes.length - 1] : null;
    const count = bytes.length >> 1;
    const grown = new Float32Array(this.input.length + count);
    grown.set(this.input);
    for (let i = 0; i < count; i++) grown[this.input.length + i] = bytes.readInt16LE(i * 2);
    this.input = grown;
    this.total += count;
    return this.run(false);
  }

  /** The input is over: what is left of it, with the last frame faded out. */
  flush(): Buffer {
    return this.run(true);
  }

  private run(final: boolean): Buffer {
    const out: number[] = [];
    while (this.canMakeFrame(final)) this.makeFrame(out);
    if (final) this.finish(out);
    this.emitted += out.length;
    const result = Buffer.alloc(out.length * 2);
    out.forEach((value, i) => result.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), i * 2));
    return result;
  }

  /** The next frame can be cut: all the input it looks at has arrived, or the input is over and some is left. */
  private canMakeFrame(final: boolean): boolean {
    const { FRAME, HOP, SEARCH } = Pcm16TimeStretcher;
    const nominal = Math.round(this.frame * this.analysisHop);
    if (final) return nominal < this.total;
    return this.base + this.input.length >= Math.max(nominal + SEARCH, this.prevPos + HOP) + FRAME;
  }

  /** Cut the next frame, blend its first half into the last frame's second half, and keep its second half to blend into the next. */
  private makeFrame(out: number[]): void {
    const { HOP, SEARCH, WINDOW } = Pcm16TimeStretcher;
    const pos = this.frame === 0 ? 0 : this.bestPosition(Math.round(this.frame * this.analysisHop));
    for (let i = 0; i < HOP; i++) {
      const sample = this.at(pos + i);
      out.push(this.frame === 0 ? sample : this.tail[i] + sample * WINDOW[i]);
    }
    for (let i = 0; i < HOP; i++) this.tail[i] = this.at(pos + HOP + i) * WINDOW[HOP + i];
    this.prevPos = pos;
    this.frame += 1;
    this.discardBefore(Math.min(Math.round(this.frame * this.analysisHop) - SEARCH, pos + HOP));
  }

  /** The last frame's second half, then a cut where the input says the audio ends: the padding that finished the frame is not speech. */
  private finish(out: number[]): void {
    const { HOP } = Pcm16TimeStretcher;
    if (this.frame > 0) for (let i = 0; i < HOP; i++) out.push(this.tail[i]);
    out.length = Math.max(0, Math.min(out.length, Math.ceil(this.total / this.speed) - this.emitted));
  }

  /** The start, near `nominal`, of the frame that continues the last one most smoothly. */
  private bestPosition(nominal: number): number {
    const { FRAME, HOP, SEARCH } = Pcm16TimeStretcher;
    const natural = this.prevPos + HOP;
    let best = nominal;
    let bestScore = -Infinity;
    for (let pos = Math.max(0, nominal - SEARCH); pos <= nominal + SEARCH; pos += 2) {
      let dot = 0;
      let energy = 1e-6;
      for (let i = 0; i < FRAME; i += 2) {
        const a = this.at(pos + i);
        dot += a * this.at(natural + i);
        energy += a * a;
      }
      const score = dot / Math.sqrt(energy);
      if (score > bestScore) { bestScore = score; best = pos; }
    }
    return best;
  }

  /** A sample of the whole input stream by absolute index; silence past its end. */
  private at(index: number): number {
    const i = index - this.base;
    return i >= 0 && i < this.input.length ? this.input[i] : 0;
  }

  private discardBefore(index: number): void {
    const drop = Math.min(index - this.base, this.input.length);
    if (drop <= 0) return;
    this.input = this.input.slice(drop);
    this.base += drop;
  }
}
