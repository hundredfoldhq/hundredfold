import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HundredfoldConfig } from "../../shared/types.js";

/**
 * Pins the behaviour of GET/POST /api/tts through the gateway dispatcher. Kokoro itself is stubbed because its readiness depends on
 * weights and a venv being present on the machine, which is not something a
 * behaviour test should depend on. `validateTtsText` stays real: it is the
 * actual validator these routes are contracted to run.
 */
const kokoro = vi.hoisted(() => ({ available: false }));

vi.mock("../../tts/tts-stream.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../tts/tts-stream.js")>();
  return {
    ...actual,
    ttsStatus: () => ({ available: kokoro.available, voice: "af_heart" }),
    streamTtsSentences: async (
      _text: string,
      _opts: unknown,
      onWav: (wav: Buffer) => void,
    ) => {
      onWav(Buffer.from("WAVDATA"));
      onWav(Buffer.from("XYZ"));
    },
  };
});

// The pool is `forks`, so this suite has its own process and HUNDREDFOLD_HOME. It must be set before db.js loads.
process.env.HUNDREDFOLD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-tts-route-"));
const api = await import("../api.js");

const baseConfig = (): HundredfoldConfig => ({ gateway: {}, engines: { default: "claude" } }) as unknown as HundredfoldConfig;

/** What `res.write` reports: false is a full socket buffer, which must never cost the client a frame. */
let writeResult = true;

function makeRes() {
  let status = 200;
  let ended = false;
  const headers: Record<string, unknown> = {};
  const chunks: Buffer[] = [];
  const asBuffer = (buf: Buffer | string) => (Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  const res = {
    writeHead(code: number, given?: Record<string, unknown>) {
      status = code;
      Object.assign(headers, given ?? {});
      return this;
    },
    setHeader(name: string, value: unknown) {
      headers[name] = value;
      return this;
    },
    write(buf: Buffer | string) {
      chunks.push(asBuffer(buf));
      return writeResult;
    },
    end(buf?: Buffer | string) {
      if (buf) chunks.push(asBuffer(buf));
      ended = true;
    },
    on() {
      return this;
    },
    get writableEnded() {
      return ended;
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get headers() {
      return headers;
    },
    get raw() {
      return Buffer.concat(chunks);
    },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf-8");
      try {
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return raw as unknown as Record<string, unknown>;
      }
    },
  };
}

/** Drive one request through the whole gateway dispatcher. */
async function call(config: HundredfoldConfig, method: string, urlPath: string, body?: unknown) {
  const res = makeRes();
  const req = Object.assign(Readable.from(body !== undefined ? [Buffer.from(JSON.stringify(body))] : []), {
    method,
    url: urlPath,
    headers: { host: "localhost", "content-type": "application/json", authorization: "Bearer test-token" },
  }) as unknown as Parameters<typeof api.handleApiRequest>[0];
  const context = {
    getConfig: () => config,
    connectors: new Map(),
    startTime: Date.now(),
    gatewayAuthToken: "test-token",
    emit: () => {},
    sessionManager: {},
  } as unknown as import("../api.js").ApiContext;
  await api.handleApiRequest(req, res.res, context);
  return res;
}

let config: HundredfoldConfig;

beforeEach(() => {
  config = baseConfig();
  kokoro.available = false;
  writeResult = true;
});

describe("GET /api/tts", () => {
  it("reports engine readiness so the client can pick without a failed POST", async () => {
    const res = await call(config, "GET", "/api/tts");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false, voice: "af_heart" });

    kokoro.available = true;
    expect((await call(config, "GET", "/api/tts")).body).toEqual({ available: true, voice: "af_heart" });
  });
});

describe("POST /api/tts", () => {
  it("503s with available:false when Kokoro cannot run", async () => {
    const res = await call(config, "POST", "/api/tts", { text: "hello" });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ available: false });
  });

  it("400s on text that is not a usable string", async () => {
    kokoro.available = true;
    expect((await call(config, "POST", "/api/tts", { text: 42 })).status).toBe(400);
    const empty = await call(config, "POST", "/api/tts", { text: "   " });
    expect(empty.status).toBe(400);
    expect(String(empty.body.error)).toMatch(/non-empty/);
  });

  it("streams one 4-byte big-endian length-prefixed WAV frame per sentence", async () => {
    kokoro.available = true;
    const res = await call(config, "POST", "/api/tts", { text: "One. Two." });

    expect(res.status).toBe(200);
    expect(res.headers["Content-Type"]).toBe("application/octet-stream");

    const raw = res.raw;
    expect(raw.readUInt32BE(0)).toBe(7);
    expect(raw.subarray(4, 11).toString()).toBe("WAVDATA");
    expect(raw.readUInt32BE(11)).toBe(3);
    expect(raw.subarray(15, 18).toString()).toBe("XYZ");
    expect(raw).toHaveLength(18);
  });
});

describe("POST /api/tts under backpressure", () => {
  it("writes every frame's length prefix and its audio even when the socket buffer reports full", async () => {
    kokoro.available = true;
    writeResult = false;
    const res = await call(config, "POST", "/api/tts", { text: "hello there" });
    const frame = (wav: string) => Buffer.concat([Buffer.from([0, 0, 0, wav.length]), Buffer.from(wav)]);
    expect(res.raw.equals(Buffer.concat([frame("WAVDATA"), frame("XYZ")]))).toBe(true);
  });
});
