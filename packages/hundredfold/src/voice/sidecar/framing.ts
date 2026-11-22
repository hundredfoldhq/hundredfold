/**
 * The speech sidecar's stdio framing (specs/009-voice-mode/contracts/speech-sidecar.md):
 * `u32 BE headerLength | u32 BE bodyLength | header (UTF-8 JSON) | body`, a header of at
 * most 64 KB and a body of at most 4 MB, both ways.
 */

export const MAX_HEADER_BYTES = 64 * 1024;
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface SidecarFrame {
  header: Record<string, unknown> & { op?: string };
  body: Buffer;
}

export class FramingError extends Error {}

export function encodeFrame(header: Record<string, unknown>, body: Buffer = Buffer.alloc(0)): Buffer {
  const raw = Buffer.from(JSON.stringify(header), "utf8");
  if (raw.length > MAX_HEADER_BYTES) throw new FramingError(`frame header of ${raw.length} bytes exceeds ${MAX_HEADER_BYTES}`);
  if (body.length > MAX_BODY_BYTES) throw new FramingError(`frame body of ${body.length} bytes exceeds ${MAX_BODY_BYTES}`);
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32BE(raw.length, 0);
  prefix.writeUInt32BE(body.length, 4);
  return Buffer.concat([prefix, raw, body]);
}

/** Turns the sidecar's stdout chunks into frames. A broken stream throws `FramingError`: it cannot be resynchronised. */
export class FrameDecoder {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): SidecarFrame[] {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const frames: SidecarFrame[] = [];
    for (let frame = this.next(); frame; frame = this.next()) frames.push(frame);
    return frames;
  }

  private next(): SidecarFrame | null {
    if (this.pending.length < 8) return null;
    const headerLength = this.pending.readUInt32BE(0);
    const bodyLength = this.pending.readUInt32BE(4);
    if (headerLength > MAX_HEADER_BYTES) throw new FramingError(`frame header of ${headerLength} bytes exceeds ${MAX_HEADER_BYTES}`);
    if (bodyLength > MAX_BODY_BYTES) throw new FramingError(`frame body of ${bodyLength} bytes exceeds ${MAX_BODY_BYTES}`);
    const total = 8 + headerLength + bodyLength;
    if (this.pending.length < total) return null;
    const header = parseHeader(this.pending.subarray(8, 8 + headerLength));
    const body = Buffer.from(this.pending.subarray(8 + headerLength, total));
    this.pending = this.pending.subarray(total);
    return { header, body };
  }
}

function parseHeader(raw: Buffer): SidecarFrame["header"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new FramingError("frame header is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new FramingError("frame header is not an object");
  return parsed as SidecarFrame["header"];
}
