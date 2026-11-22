/**
 * The voice names in Kokoro's `voices-v1.0.bin`, an `.npz` (a zip of `<name>.npy`), read from the
 * zip's central directory so the list is known before the sidecar ever starts.
 */
import fs from "node:fs";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const cache = new Map<string, { mtimeMs: number; voices: string[] }>();

/** Voice names, sorted; empty when the file is missing or is not a zip. */
export function readKokoroVoices(file: string): string[] {
  try {
    const { mtimeMs } = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === mtimeMs) return hit.voices;
    const voices = parseNpzNames(fs.readFileSync(file));
    cache.set(file, { mtimeMs, voices });
    return voices;
  } catch {
    return [];
  }
}

export function parseNpzNames(zip: Buffer): string[] {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0 || zip.readUInt32LE(eocd) !== EOCD_SIGNATURE) return [];
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let index = 0; index < count && at + 46 <= zip.length; index += 1) {
    if (zip.readUInt32LE(at) !== CENTRAL_SIGNATURE) break;
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    if (name.endsWith(".npy")) names.push(name.slice(0, -4));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return names.sort();
}
