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

/** Whether `head` starts like an MP3 (an ID3 tag or an MPEG audio frame sync). */
export function looksLikeMp3(head: Buffer): boolean {
  return head.length >= 3 && (head.toString("ascii", 0, 3) === "ID3" || (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0));
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
