import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

/**
 * server-live-queue-wiring.test.ts proves the gateway registers its live queue
 * at the right moments, but it only probes a row the live queue does NOT hold,
 * so a registration whose lambdas answer a constant would still pass it. This
 * one proves the registered queue is the real session queue.
 *
 * It boots the real `startGateway`, starts a web session over HTTP on an engine
 * that never finishes its turn, and reads the owed-turn check for that session:
 * its row is in the queue's hands and its lane is open, so a turn is owed. It
 * then pauses the lane over HTTP, and the same row is owed no longer.
 *
 * `holds` forced false or aimed at the wrong id fails the first answer;
 * `isPaused` forced true fails the first answer, forced false fails the paused
 * one; registering a hand-rolled `{ holds: () => false, isPaused: () => false }`
 * fails the first.
 */

// paths.js reads HUNDREDFOLD_HOME once, so every gateway import is dynamic and comes after this.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-live-queue-delegation-"));
process.env.HUNDREDFOLD_HOME = tmpHome;

/** The turn the fake engine is holding open, so its row stays with the queue. */
const turn = vi.hoisted(() => {
  let release: () => void = () => undefined;
  let started: () => void = () => undefined;
  return {
    gate: new Promise<void>((resolve) => { release = resolve; }),
    release: () => release(),
    running: new Promise<void>((resolve) => { started = resolve; }),
    markRunning: () => started(),
  };
});

// A pi engine that starts a turn and never finishes it until the test lets it.
vi.mock("../../engines/pi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../engines/pi.js")>();
  class GatedPiEngine {
    name = "pi" as const;
    async run(opts: { sessionId?: string }) {
      turn.markRunning();
      await turn.gate;
      return { sessionId: opts.sessionId ?? "gated", result: "released" };
    }
    kill() { /* nothing to kill: the turn is only a promise */ }
    isAlive() { return false; }
    killAll() { turn.release(); }
    killIdle() { /* nothing idle */ }
  }
  return { ...actual, PiEngine: GatedPiEngine };
});

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

let port = 0;
let cleanup: (() => Promise<void>) | undefined;
let sessionId = "";
let authToken = "";
let owed: (id: string) => boolean = () => {
  throw new Error("the owed-turn check is read before the gateway module graph is loaded");
};

async function post(route: string, body?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${authToken}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(async () => {
  port = await freePort();
  fs.writeFileSync(
    path.join(tmpHome, "config.yaml"),
    yaml.dump({
      gateway: { port, host: "127.0.0.1" },
      engines: { default: "claude", claude: { bin: "claude", model: "sonnet" }, pi: { bin: process.execPath, model: "default" } },
      portal: { portalName: "Live queue delegation", setupComplete: true },
      connectors: {},
      mcp: {},
      sessions: {},
      logging: { level: "error", stdout: false },
    }),
  );

  const { gatewayOwesTurn } = await import("../../sessions/owed-turns.js");
  const { loadConfig } = await import("../../shared/config.js");
  owed = gatewayOwesTurn;

  const { startGateway } = await import("../server.js");
  cleanup = await startGateway(loadConfig());

  // The gateway writes its bearer token into the home it booted from.
  authToken = (JSON.parse(fs.readFileSync(path.join(tmpHome, "gateway.json"), "utf-8")) as { token: string }).token;

  const spawned = await post("/api/sessions", { prompt: "hold this turn open", engine: "pi" });
  expect(spawned.status, await spawned.clone().text()).toBe(201);
  sessionId = ((await spawned.json()) as { id: string }).id;
  // The row is `running` and the gateway's queue is in the middle of it.
  await turn.running;
}, 60_000);

afterAll(async () => {
  turn.release();
  await cleanup?.().catch(() => undefined);
  fs.rmSync(tmpHome, { recursive: true, force: true });
}, 30_000);

describe("the registered live queue is the gateway's real session queue", () => {
  it("owes a turn the queue is holding on an open lane", () => {
    // A `holds` that never answers true would read every queued turn as stranded and block its Todo.
    expect(owed(sessionId)).toBe(true);
  });

  it("stops owing it once the operator pauses the lane, and owes it again on resume", async () => {
    expect((await post(`/api/sessions/${sessionId}/queue/pause`)).status).toBe(200);
    expect(owed(sessionId)).toBe(false);

    expect((await post(`/api/sessions/${sessionId}/queue/resume`)).status).toBe(200);
    expect(owed(sessionId)).toBe(true);
  });
});
