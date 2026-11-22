/** PCM and WAV helpers shared by the hosted providers. */

/** Linear-interpolation resample of PCM16LE mono; plenty for speech going to a recogniser or a speaker. */
export function resamplePcm16(pcm: Buffer, from: number, to: number): Buffer {
  if (from === to || pcm.length < 2) return pcm;
  const input = Math.floor(pcm.length / 2);
  const output = Math.max(1, Math.floor((input * to) / from));
  const out = Buffer.alloc(output * 2);
  const step = from / to;
  for (let index = 0; index < output; index += 1) {
    const position = index * step;
    const base = Math.min(input - 1, Math.floor(position));
    const next = Math.min(input - 1, base + 1);
    const fraction = position - base;
    const value = pcm.readInt16LE(base * 2) * (1 - fraction) + pcm.readInt16LE(next * 2) * fraction;
    out.writeInt16LE(Math.round(value), index * 2);
  }
  return out;
}

/** A 44-byte RIFF header for PCM16 mono audio of `dataBytes` bytes. */
export function wavHeader(dataBytes: number, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

export function toWav(pcm: Buffer, sampleRate: number): Buffer {
  return Buffer.concat([wavHeader(pcm.length, sampleRate), pcm]);
}

export interface ParsedWav { sampleRate: number; pcm: Buffer }

interface WavFormat { channels: number; rate: number; bits: number; code: number }

function readFormat(file: Buffer, body: number): WavFormat | null {
  if (body + 16 > file.length) return null;
  return { code: file.readUInt16LE(body), channels: file.readUInt16LE(body + 2), rate: file.readUInt32LE(body + 4), bits: file.readUInt16LE(body + 14) };
}

/** One RIFF chunk at `at`: its id, where its data starts and ends (a streamed WAV may give 0 or 0xFFFFFFFF as the size: take what is there), and where the next begins. */
function readChunk(file: Buffer, at: number): { id: string; body: number; end: number; next: number } {
  const size = file.readUInt32LE(at + 4);
  const body = at + 8;
  const unsized = size === 0 || size === 0xffffffff || body + size > file.length;
  return { id: file.toString("ascii", at, at + 4), body, end: unsized ? file.length : body + size, next: body + size + (size % 2) };
}

/** The PCM16 mono samples of a WAV file, or a reason it is not one the voice pipeline can play. */
export function parseWav(file: Buffer): ParsedWav | { error: string } {
  if (file.length < 12 || file.toString("ascii", 0, 4) !== "RIFF" || file.toString("ascii", 8, 12) !== "WAVE") return { error: "not a WAV file" };
  let format: WavFormat | null = null;
  for (let at = 12; at + 8 <= file.length; ) {
    const chunk = readChunk(file, at);
    if (chunk.id === "fmt ") format = readFormat(file, chunk.body);
    else if (chunk.id === "data") return wavSamples(format, file.subarray(chunk.body, chunk.end));
    at = chunk.next;
  }
  return { error: "the WAV file has no audio data" };
}

function wavSamples(format: WavFormat | null, data: Buffer): ParsedWav | { error: string } {
  if (!format) return { error: "the WAV file has no format chunk" };
  if (format.code !== 1 || format.bits !== 16 || format.channels !== 1) {
    return { error: `the WAV audio is ${format.channels} channel(s) of ${format.bits}-bit format ${format.code}; voice mode needs 16-bit PCM mono` };
  }
  return { sampleRate: format.rate, pcm: Buffer.from(data.subarray(0, data.length - (data.length % 2))) };
}

// kbit/s by bitrate index (1..14), for MPEG-1 and for MPEG-2/2.5, per layer (I, II, III).
const MPEG1_KBPS = [
  [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
];
const MPEG2_KBPS = [
  [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
];
const MPEG_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

interface MpegHeader { version: number; layer: number; bitrateIndex: number; rateIndex: number; padding: number }

/** The fields of the four-byte MPEG audio frame header at `at`, or null when it is not a valid one (any reserved or "bad" value). */
function mpegHeader(data: Buffer, at: number): MpegHeader | null {
  if (at + 4 > data.length || data[at] !== 0xff || (data[at + 1]! & 0xe0) !== 0xe0) return null;
  const header = {
    version: (data[at + 1]! >> 3) & 3, // 0 = 2.5, 1 reserved, 2 = 2, 3 = 1
    layer: 4 - ((data[at + 1]! >> 1) & 3), // 4 is the reserved layer bits 00
    bitrateIndex: data[at + 2]! >> 4, // 0 is free format, 15 is bad
    rateIndex: (data[at + 2]! >> 2) & 3, // 3 is reserved
    padding: (data[at + 2]! >> 1) & 1,
  };
  const reserved = header.version === 1 || header.layer === 4 || header.rateIndex === 3 || (data[at + 3]! & 3) === 2;
  return reserved || header.bitrateIndex === 0 || header.bitrateIndex === 15 ? null : header;
}

/** The byte length of the MPEG audio frame whose header is at `at`, or null when those four bytes are not a valid frame header. */
export function mpegFrameLength(data: Buffer, at = 0): number | null {
  const header = mpegHeader(data, at);
  if (!header) return null;
  const { version, layer, bitrateIndex, rateIndex, padding } = header;
  const bitrate = (version === 3 ? MPEG1_KBPS : MPEG2_KBPS)[layer - 1]![bitrateIndex - 1]! * 1000;
  const rate = MPEG_RATES[version]![rateIndex]!;
  if (layer === 1) return (Math.floor((12 * bitrate) / rate) + padding) * 4;
  return Math.floor(((layer === 3 && version !== 3 ? 72 : 144) * bitrate) / rate) + padding;
}

/**
 * How many bytes `looksLikeMp3` wants to see: enough for an ID3 tag's name, or, when the body opens with a valid
 * frame header, for that frame and the next one's header.
 */
export function mp3SniffBytes(head: Buffer): number {
  const first = mpegFrameLength(head);
  return first === null ? 4 : first + 4;
}

/**
 * Whether `head` starts like an MP3: an ID3 tag, or a valid MPEG audio frame header followed by another at the
 * frame's end. A frame sync alone is not enough: raw PCM16LE whose first sample is negative (0xFFxx) opens with one.
 * A body that ends before a second frame could begin is judged on its first header.
 */
export function looksLikeMp3(head: Buffer): boolean {
  if (head.length >= 3 && head.toString("ascii", 0, 3) === "ID3") return true;
  const first = mpegFrameLength(head);
  if (first === null) return false;
  return head.length < first + 4 || mpegFrameLength(head, first) !== null;
}

/** Whether `head` starts like Ogg or FLAC, which the pipeline cannot play either. */
export function looksLikeOggOrFlac(head: Buffer): boolean {
  return head.length >= 4 && ["OggS", "fLaC"].includes(head.toString("ascii", 0, 4));
}

/** The first subtag of a language code when it is a two-letter ISO 639-1 code, else undefined (a three-letter code is not guessed at). */
export function iso6391(language: string): string | undefined {
  const first = language.split("-")[0]!.toLowerCase();
  return /^[a-z]{2}$/.test(first) ? first : undefined;
}

/** `text` with every secret removed, for an error message that may echo upstream text. */
export function redact(text: string, secrets: ReadonlyArray<string | undefined>): string {
  let out = text;
  for (const secret of secrets) if (secret && secret.length >= 6) out = out.split(secret).join("***");
  return out;
}

/** The variable named by a `${VAR}` reference, for a message that says which one is unset. */
export function envNameOf(reference: string | null): string | null {
  const match = reference?.match(/^\$\{(.+)\}$/);
  return match ? match[1]! : null;
}
