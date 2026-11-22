import { describe, expect, it } from "vitest";
import { FrameDecoder, FramingError, MAX_BODY_BYTES, MAX_HEADER_BYTES, encodeFrame } from "../sidecar/framing.js";

describe("sidecar framing", () => {
  it("round-trips a header and a binary body", () => {
    const body = Buffer.from(Array.from({ length: 300 }, (_, index) => index % 256));
    const [frame] = new FrameDecoder().push(encodeFrame({ op: "tts.audio", id: "a", text: "héllo" }, body));
    expect(frame!.header).toEqual({ op: "tts.audio", id: "a", text: "héllo" });
    expect(frame!.body.equals(body)).toBe(true);
  });

  it("reassembles frames split at any byte and splits frames that arrive together", () => {
    const wire = Buffer.concat([encodeFrame({ n: 1 }, Buffer.from("abc")), encodeFrame({ n: 2 }), encodeFrame({ n: 3 }, Buffer.from("z"))]);
    const decoder = new FrameDecoder();
    const seen: Array<[number, string]> = [];
    for (let at = 0; at < wire.length; at += 1) {
      for (const frame of decoder.push(wire.subarray(at, at + 1))) seen.push([frame.header.n as number, frame.body.toString()]);
    }
    expect(seen).toEqual([[1, "abc"], [2, ""], [3, "z"]]);
    expect(new FrameDecoder().push(wire).map((frame) => frame.header.n)).toEqual([1, 2, 3]);
  });

  it("accepts the maximum sizes and refuses one byte over, on both sides of the wire", () => {
    expect(new FrameDecoder().push(encodeFrame({ k: "v" }, Buffer.alloc(MAX_BODY_BYTES)))[0]!.body.length).toBe(MAX_BODY_BYTES);
    expect(() => encodeFrame({ k: "v" }, Buffer.alloc(MAX_BODY_BYTES + 1))).toThrow(FramingError);
    expect(() => encodeFrame({ k: "x".repeat(MAX_HEADER_BYTES) })).toThrow(FramingError);
    const prefix = Buffer.alloc(8);
    prefix.writeUInt32BE(MAX_HEADER_BYTES + 1, 0);
    expect(() => new FrameDecoder().push(prefix)).toThrow(/exceeds/);
    prefix.writeUInt32BE(2, 0);
    prefix.writeUInt32BE(MAX_BODY_BYTES + 1, 4);
    expect(() => new FrameDecoder().push(prefix)).toThrow(/exceeds/);
  });

  it("refuses a header that is not a JSON object", () => {
    const frame = (text: string) => {
      const raw = Buffer.from(text);
      const prefix = Buffer.alloc(8);
      prefix.writeUInt32BE(raw.length, 0);
      return Buffer.concat([prefix, raw]);
    };
    expect(() => new FrameDecoder().push(frame("nope"))).toThrow(FramingError);
    expect(() => new FrameDecoder().push(frame("[1]"))).toThrow(FramingError);
  });
});
