/**
 * An in-process voice activity detector for when the local speech sidecar's Silero model is
 * not there (a hosted provider with no local install). It listens for loudness, not speech, so
 * a fan or a keyboard can start an utterance: less accurate than Silero, and documented as such.
 * It follows the same rules as the sidecar's endpointer: speech starts after `minSpeechMs` above
 * the level and ends after `silenceMs` below it; `start.atMs` is already moved back by `prerollMs`.
 */
import type { VadEventHandler, VadStream } from "../provider.js";

export interface EnergyVadParams { threshold: number; minSpeechMs: number; silenceMs: number; prerollMs: number }

const FRAME_MS = 20;
const FRAME_SAMPLES = 320; // 20 ms at 16 kHz
const FRAME_BYTES = FRAME_SAMPLES * 2;
/** `vad.threshold` is a probability for Silero; for loudness it scales an RMS level of up to 0.05. */
const RMS_AT_FULL_THRESHOLD = 0.05;

export function rms(frame: Buffer): number {
  let sum = 0;
  const samples = Math.floor(frame.length / 2);
  for (let index = 0; index < samples; index += 1) {
    const value = frame.readInt16LE(index * 2) / 32768;
    sum += value * value;
  }
  return samples === 0 ? 0 : Math.sqrt(sum / samples);
}

export class EnergyVad implements VadStream {
  private readonly handlers: VadEventHandler[] = [];
  private pending: Buffer = Buffer.alloc(0);
  private frame = 0;
  private speaking = false;
  private run = 0;
  private silent = 0;
  private lastVoiced = 0;
  private onsetFrame = 0;
  private closed = false;
  private readonly level: number;
  private readonly minFrames: number;
  private readonly silenceFrames: number;

  constructor(private readonly params: EnergyVadParams) {
    this.level = params.threshold * RMS_AT_FULL_THRESHOLD;
    this.minFrames = Math.max(1, Math.ceil(params.minSpeechMs / FRAME_MS));
    this.silenceFrames = Math.max(1, Math.ceil(params.silenceMs / FRAME_MS));
  }

  on(handler: VadEventHandler): void {
    this.handlers.push(handler);
  }

  close(): void {
    this.closed = true;
  }

  write(pcm: Buffer): void {
    if (this.closed) return;
    this.pending = Buffer.concat([this.pending, pcm]);
    while (this.pending.length >= FRAME_BYTES) {
      const loud = rms(this.pending.subarray(0, FRAME_BYTES)) >= this.level;
      this.pending = this.pending.subarray(FRAME_BYTES);
      this.push(loud);
    }
  }

  private push(loud: boolean): void {
    const index = this.frame;
    this.frame += 1;
    if (this.speaking) this.whileSpeaking(index, loud);
    else this.whileQuiet(index, loud);
  }

  private whileQuiet(index: number, loud: boolean): void {
    this.run = loud ? this.run + 1 : 0;
    if (this.run < this.minFrames) return;
    this.speaking = true;
    this.silent = 0;
    this.lastVoiced = index + 1;
    this.onsetFrame = index + 1 - this.run;
    this.emit("start", Math.max(0, this.onsetFrame * FRAME_MS - this.params.prerollMs));
  }

  private whileSpeaking(index: number, loud: boolean): void {
    if (loud) {
      this.silent = 0;
      this.lastVoiced = index + 1;
      return;
    }
    this.silent += 1;
    if (this.silent < this.silenceFrames) return;
    this.speaking = false;
    this.run = 0;
    this.emit("end", this.lastVoiced * FRAME_MS, (this.lastVoiced - this.onsetFrame) * FRAME_MS);
  }

  private emit(kind: "start" | "end", atMs: number, speechMs?: number): void {
    for (const handler of this.handlers) handler(speechMs === undefined ? { kind, atMs } : { kind, atMs, speechMs });
  }
}
