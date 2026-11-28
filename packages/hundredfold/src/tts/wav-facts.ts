/**
 * What a WAV buffer says about itself, for diagnostics: the numbers that show a truncated or mis-rated clip.
 */
/** Never throws; a buffer that is not a WAV reports `wav_ok: false` and its size. */
export function wavFacts(wav: Buffer): { wav_bytes: number; wav_rate?: number; wav_channels?: number; wav_bits?: number; wav_data_bytes?: number; wav_ms?: number; wav_ok: boolean } {
  const facts: ReturnType<typeof wavFacts> = { wav_bytes: wav.length, wav_ok: false };
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") return facts;
  const format = { rate: 0, channels: 0, bits: 0 };
  const data = findData(wav, format);
  if (!data) return facts;
  const { rate, channels, bits } = format;
  facts.wav_rate = rate;
  facts.wav_channels = channels;
  facts.wav_bits = bits;
  facts.wav_data_bytes = data.present;
  facts.wav_ms = rate && channels && bits ? Math.round((data.present / (channels * (bits / 8)) / rate) * 1000) : undefined;
  // A data chunk that declares more than the buffer holds means the clip was cut short.
  facts.wav_ok = data.present === data.declared || data.declared === 0xffffffff;
  return facts;
}

/** Walk the RIFF chunks: fill `format` from `fmt ` and return how much of the `data` chunk is there, or null when there is none. */
function findData(wav: Buffer, format: { rate: number; channels: number; bits: number }): { declared: number; present: number } | null {
  let at = 12;
  while (at + 8 <= wav.length) {
    const id = wav.toString("ascii", at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    if (id === "fmt " && at + 24 <= wav.length) {
      format.channels = wav.readUInt16LE(at + 10);
      format.rate = wav.readUInt32LE(at + 12);
      format.bits = wav.readUInt16LE(at + 22);
    } else if (id === "data") {
      return { declared: size, present: Math.min(size, wav.length - (at + 8)) };
    }
    at += 8 + size + (size % 2);
  }
  return null;
}
