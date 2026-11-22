/**
 * A real HTTP server with the voice upgrade branch, driven by real `ws`
 * clients. HUNDREDFOLD_HOME is set when this module is evaluated: import it
 * before anything that reads the home.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import type { HundredfoldConfig } from "../../shared/types.js";
import { FakeEngine, FakeStt, FakeTts, FakeVad } from "./fakes.js";

export const home = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-voice-route-"));
process.env.HUNDREDFOLD_HOME = home;
fs.mkdirSync(path.join(home, "org"), { recursive: true });

export const OPERATOR_TOKEN = "operator-token";

export interface Route {
  url: (sessionId: string) => string;
  port: number;
  runtime: NonNullable<ReturnType<typeof import("../runtime.js").createVoiceRuntime>>;
  stt: FakeStt;
  tts: FakeTts;
  vads: FakeVad[];
  engine: FakeEngine;
  config: { current: HundredfoldConfig };
  close(): Promise<void>;
}

function baseConfig(voice: HundredfoldConfig["voice"]): HundredfoldConfig {
  return { gateway: {}, engines: { default: "codex" }, voice } as unknown as HundredfoldConfig;
}

export async function startRoute(voice: HundredfoldConfig["voice"] = { enabled: true, limits: { maxConcurrentAttachments: 4 } }): Promise<Route> {
  const { createVoiceRuntime } = await import("../runtime.js");
  const config = { current: baseConfig(voice) };
  const stt = new FakeStt();
  const tts = new FakeTts();
  const vads: FakeVad[] = [];
  const engine = new FakeEngine();
  const runtime = createVoiceRuntime({
    getConfig: () => config.current,
    getContext: () => ({ sessionManager: { getEngine: () => engine } }) as never,
    operatorAuthenticated: (req) => req.headers.authorization === `Bearer ${OPERATOR_TOKEN}`,
    providers: () => ({ stt, tts, createVad: () => { const vad = new FakeVad(); vads.push(vad); return vad; } }),
  });
  if (!runtime) throw new Error("voice runtime was not created for an enabled config");
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  server.on("upgrade", (req, socket, head) => {
    if (runtime.handleUpgrade(req, socket, head)) return;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port, runtime, stt, tts, vads, engine, config,
    url: (sessionId) => `ws://127.0.0.1:${port}/ws/voice/${encodeURIComponent(sessionId)}`,
    async close() {
      runtime.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export type Outcome =
  | { kind: "open"; ws: WebSocket }
  | { kind: "refused"; status: number; body: string }
  | { kind: "destroyed" };

/** Open a socket and say how the upgrade went. */
export function open(url: string, headers: Record<string, string> = { authorization: `Bearer ${OPERATOR_TOKEN}` }): Promise<Outcome> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.once("open", () => resolve({ kind: "open", ws }));
    ws.once("unexpected-response", (_req, res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ kind: "refused", status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    ws.once("error", () => resolve({ kind: "destroyed" }));
  });
}

/** Everything a socket receives until it closes, with the close code and reason. */
export interface Received {
  text: Array<Record<string, unknown>>;
  binary: Buffer[];
  raw: string[];
  closed: Promise<{ code: number; reason: string }>;
}

export function collect(ws: WebSocket): Received {
  const text: Array<Record<string, unknown>> = [];
  const binary: Buffer[] = [];
  const raw: string[] = [];
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) binary.push(data);
    else { const t = data.toString("utf8"); raw.push(t); text.push(JSON.parse(t) as Record<string, unknown>); }
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.once("close", (code: number, reason: Buffer) => resolve({ code, reason: reason.toString("utf8") }));
  });
  return { text, binary, raw, closed };
}

export const hello = (mode: "hands-free" | "push-to-talk" = "hands-free") => JSON.stringify({ type: "hello", protocol: 1, mode, client: "web" });

export async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  for (let waited = 0; waited < ms && !check(); waited += 10) await new Promise((r) => setTimeout(r, 10));
  if (!check()) throw new Error("timed out waiting");
}
