import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { EngineResult, EngineRunOpts, StreamDelta } from "../../shared/types.js";
import { USER_STOP_INTERRUPTION_REASON } from "../../sessions/interruption-reasons.js";
import { OpencodeEngine } from "../opencode.js";
import { OpencodeServerPool } from "../opencode-server.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";

/**
 * e2e: Hundredfold's server mode against a real OpenCode 2 server (`/api/*`), with a
 * mock OpenAI-compatible provider. One Hundredfold session, several turns: an
 * answer, a resume, a tool call, an MCP tool call, a model switch, a stop and
 * what the next turn is told about it, and a compaction with its re-seed. Then
 * the host plugin: a pre-stream 400 is retried in place.
 *
 * Skipped unless OPENCODE2_E2E=1:
 *
 *   OPENCODE2_E2E=1 OPENCODE2_BIN=/path/to/opencode-2.x \
 *   pnpm exec vitest run src/engines/__tests__/opencode-v2-e2e.test.ts
 */

const RUN = process.env.OPENCODE2_E2E === "1";
const BIN = process.env.OPENCODE2_BIN ?? "opencode";
const MOCK = path.join(path.dirname(new URL(import.meta.url).pathname), "opencode-v2-mock-upstream.mjs");
const MCP_STUB = path.join(path.dirname(new URL(import.meta.url).pathname), "opencode-v2-mcp-stub.mjs");
/** The host plugin the OpenCode 2 upgrade guide installs. */
const PLUGINS = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../../../examples/opencode-plugins");

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" }, () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
  });
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

interface MockRequest { url: string; model: string; hasTools: boolean; tools: string[]; lastUser: string; all: string }

describe.skipIf(!RUN)("opencode server mode on OpenCode 2", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-v2-e2e-"));
  const port = 9400 + Math.floor(Math.random() * 400);
  const mockLog = path.join(home, "mock.jsonl");
  const sessionId = `opencode-v2-e2e-${Date.now()}`;
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
  let mock: ChildProcess;
  let pool: OpencodeServerPool;
  let engine: OpencodeEngine;
  let resume = "";

  const requests = (): MockRequest[] =>
    fs.readFileSync(mockLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as MockRequest);
  const mainRequests = () => requests().filter((r) => r.hasTools);
  const turn = async (prompt: string, extra: Partial<EngineRunOpts> = {}): Promise<{ result: EngineResult; deltas: StreamDelta[] }> => {
    const deltas: StreamDelta[] = [];
    const result = await engine.run({
      prompt,
      cwd: path.join(home, "work"),
      sessionId,
      bin: BIN,
      model: "mock/m1",
      systemPrompt: "SYSTEM_PROMPT_MARKER",
      ...(resume ? { resumeSessionId: resume } : {}),
      onStream: (d) => deltas.push(d),
      ...extra,
    });
    if (result.sessionId) resume = result.sessionId;
    return { result, deltas };
  };

  beforeAll(async () => {
    const models = { m1: { name: "M1", limit: { context: 100000, output: 8000 } }, m2: { name: "M2", limit: { context: 100000, output: 8000 } } };
    const provider = (prefix: string) => ({ npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${port}/${prefix}`, apiKey: "dummy" }, models });
    writeJson(path.join(home, ".config", "opencode", "opencode.json"), {
      model: "mock/m1",
      // The provider id the error-retry plugin watches.
      provider: { mock: provider("v1"), "opencode-go": provider("primary/v1") },
    });
    fs.mkdirSync(path.join(home, ".config", "opencode", "plugin"), { recursive: true });
    fs.copyFileSync(path.join(PLUGINS, "error-retry.js"), path.join(home, ".config", "opencode", "plugin", "error-retry.js"));
    fs.mkdirSync(path.join(home, "work"), { recursive: true });
    fs.writeFileSync(mockLog, "");
    mock = spawn(process.execPath, [MOCK], { env: { ...process.env, MOCK_PORT: String(port), MOCK_LOG: mockLog }, stdio: "ignore" });
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    const lifecycle = new PtyLifecycleManager({ maxLivePtys: 8, enforceLocalCap: false });
    pool = new OpencodeServerPool(lifecycle, { bin: () => BIN, limits: () => ({ startTimeoutMs: 120_000 }) });
    engine = new OpencodeEngine({ mode: () => "server", servers: pool });
    for (let i = 0; i < 50 && !(await canConnect(port)); i++) await new Promise((r) => setTimeout(r, 100));
  }, 30_000);

  afterAll(async () => {
    engine?.killAll();
    await pool?.stopAll();
    mock?.kill("SIGKILL");
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("answers a first turn on a v2 server, with the system prompt in front", async () => {
    const { result } = await turn("say hello");
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("hello from mock");
    expect(result.sessionId).toMatch(/^ses_/);
    expect(result.numTurns).toBe(1);
    expect(pool.get(sessionId)?.api).toBe(2);
    expect(mainRequests().at(-1)!.all).toContain("SYSTEM_PROMPT_MARKER");
  }, 180_000);

  it("resumes the session and reports a tool call", async () => {
    const first = resume;
    const { result, deltas } = await turn("run it TOOLCALL");
    expect(result.error).toBeUndefined();
    expect(result.sessionId).toBe(first);
    expect(result.result).toBe("tool done");
    expect(result.numTurns).toBe(2);
    expect(deltas.some((d) => d.type === "tool_use" && d.toolName === "shell")).toBe(true);
    expect(deltas.some((d) => d.type === "tool_result" && d.content.includes("hi-from-tool"))).toBe(true);
  }, 60_000);

  it("offers the session's MCP tools as tools, not behind code mode, and runs one", async () => {
    const resolvedMcp = { mcpServers: { hundredfold: { command: process.execPath, args: [MCP_STUB], env: { STUB_MARK: "staged-env" } } } };
    const { result, deltas } = await turn("call it MCPCALL", { resolvedMcp });
    expect(mainRequests().at(-1)!.tools).toContain("hundredfold_echo");
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("tool done");
    expect(deltas.some((d) => d.type === "tool_result" && d.toolName === "hundredfold_echo" && d.content.includes("ECHO:staged-env"))).toBe(true);
  }, 120_000);

  it("keeps its answer when the operator steers a message in while its tool runs", async () => {
    const args = Buffer.from(JSON.stringify({ command: "sleep 3", description: "wait" })).toString("base64");
    const running = turn(`wait CALLTOOL=shell ARGS64=${args}`);
    await new Promise((r) => setTimeout(r, 1500));
    // The previous test's MCP change restarts the session's server, which may still be coming up.
    await waitFor(() => Boolean(pool.get(sessionId)));
    // As the terminal sends it: no delivery, which 2.x takes as a steer.
    const server = pool.get(sessionId)!;
    const res = await fetch(`${server.apiUrl}/api/session/${resume}/prompt`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`opencode:${server.password}`).toString("base64")}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "operator aside" }),
    });
    expect(res.ok).toBe(true);
    const { result } = await running;
    expect(result.error).toBeUndefined();
    expect(result.result).not.toBe("");
  }, 60_000);

  it("keeps its answer when the operator queues a message and then switches it to steer", async () => {
    const args = Buffer.from(JSON.stringify({ command: "sleep 3", description: "wait" })).toString("base64");
    const running = turn(`wait CALLTOOL=shell ARGS64=${args}`);
    await new Promise((r) => setTimeout(r, 1500));
    await waitFor(() => Boolean(pool.get(sessionId)));
    const server = pool.get(sessionId)!;
    const headers = { authorization: `Basic ${Buffer.from(`opencode:${server.password}`).toString("base64")}`, "content-type": "application/json" };
    const posted = await fetch(`${server.apiUrl}/api/session/${resume}/prompt`, { method: "POST", headers, body: JSON.stringify({ text: "operator aside", delivery: "queue" }) });
    const item = (await posted.json()) as { data: { id: string } };
    await new Promise((r) => setTimeout(r, 300));
    // The terminal's per-item toggle.
    const patched = await fetch(`${server.apiUrl}/api/session/${resume}/inbox/${item.data.id}`, { method: "PATCH", headers, body: JSON.stringify({ delivery: "steer" }) });
    expect(patched.ok).toBe(true);
    const { result } = await running;
    expect(result.error).toBeUndefined();
    expect(result.result).not.toBe("");
  }, 60_000);

  /** The session's store, oldest first, as `user:<text>`, `assistant`, `idle:<outcome>`. */
  const storeOf = async (): Promise<string[]> => {
    const server = pool.get(sessionId)!;
    const res = await fetch(`${server.apiUrl}/api/session/${resume}/message?limit=60&order=asc`, {
      headers: { authorization: `Basic ${Buffer.from(`opencode:${server.password}`).toString("base64")}` },
    });
    const items = ((await res.json()) as { data: Array<Record<string, unknown>> }).data;
    return items.map((m) => (m.type === "user" ? `user:${String(m.text).slice(0, 40)}` : m.type === "idle" ? `idle:${String(m.outcome)}` : String(m.type)));
  };
  const serverCall = async (method: string, route: string, body?: unknown): Promise<{ status: number; json: any }> => {
    const server = pool.get(sessionId)!;
    const res = await fetch(`${server.apiUrl}${route}`, {
      method,
      headers: { authorization: `Basic ${Buffer.from(`opencode:${server.password}`).toString("base64")}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
  const waitFor = async (check: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error("timed out waiting");
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  // What 2.0.32 does with a steered input (the engine's SteerableEngine contract rests on it):
  // - during a tool call it is delivered at the next step of the SAME execution (one idle for
  //   both inputs), and the model's next upstream request carries it after the tool result;
  // - during the last step it is delivered right after that step ends (the same millisecond
  //   as `session.step.ended`), in the same execution, and one more step answers it: a turn
  //   that ended with the step would lose that answer, so the turn waits for it;
  // - with no execution running it starts one at once (nothing is held back in the inbox).
  it("steers an input into a running tool call: the next request of the same execution carries it", async () => {
    const before = (await storeOf()).filter((e) => e.startsWith("idle:")).length;
    const args = Buffer.from(JSON.stringify({ command: "sleep 4", description: "wait" })).toString("base64");
    const mainBefore = mainRequests().length;
    const running = turn(`steer into me CALLTOOL=shell ARGS64=${args}`);
    await waitFor(() => mainRequests().length === mainBefore + 1);
    await new Promise((r) => setTimeout(r, 1500));
    expect(engine.canSteer(sessionId)).toBe(true);
    const outcome = await engine.steer(sessionId, "STEERED_MARKER also say hi");
    const { result } = await running;
    expect(outcome).toBe("steered");
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("heard the steer");
    expect(result.numTurns).toBeGreaterThan(1);

    const after = mainRequests().slice(mainBefore);
    expect(after).toHaveLength(2);
    // The second request is the model's next step: the tool's result, then the steered text.
    const roles = (JSON.parse(after[1]!.all) as Array<{ role: string; content: unknown }>);
    expect(roles.at(-1)).toMatchObject({ role: "user" });
    expect(JSON.stringify(roles.at(-1)!.content)).toContain("STEERED_MARKER also say hi");
    expect(roles.at(-2)).toMatchObject({ role: "tool" });
    // One execution for both: the steered input sits between the turn's steps, one idle closes it.
    const store = await storeOf();
    expect(store.filter((e) => e.startsWith("idle:")).length).toBe(before + 1);
    expect(store.slice(-4)).toEqual(["assistant", "user:STEERED_MARKER also say hi", "assistant", "idle:succeeded"]);
    expect(engine.canSteer(sessionId)).toBe(false);
  }, 60_000);

  it("keeps a turn open for an input that arrives during its last step, and answers with the reply to it", async () => {
    const before = (await storeOf()).filter((e) => e.startsWith("idle:")).length;
    const mainBefore = mainRequests().length;
    // SLOW streams its answer for ten seconds; steer a second before it ends.
    const running = turn("go SLOW");
    await waitFor(() => mainRequests().length === mainBefore + 1);
    await new Promise((r) => setTimeout(r, 9000));
    expect(engine.canSteer(sessionId)).toBe(true);
    const outcome = engine.steer(sessionId, "STEERED_MARKER one more thing");
    const { result } = await running;
    expect(await outcome).toBe("steered");
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("heard the steer");
    expect(result.numTurns).toBeGreaterThan(1);
    const store = await storeOf();
    expect(store.filter((e) => e.startsWith("idle:")).length).toBe(before + 1);
    expect(store.slice(-4)).toEqual(["assistant", "user:STEERED_MARKER one more thing", "assistant", "idle:succeeded"]);
  }, 60_000);

  it("starts an execution for a steer that arrives with none running (nothing waits in the inbox)", async () => {
    await waitFor(async () => Object.keys((await serverCall("GET", "/api/session/active")).json.data).length === 0);
    const mainBefore = mainRequests().length;
    const posted = await serverCall("POST", `/api/session/${resume}/prompt`, { id: `msg_${"0".repeat(8)}idlesteer0000000`, text: "STEERED_MARKER while idle", delivery: "steer" });
    expect(posted.status).toBe(200);
    await waitFor(async () => (await storeOf()).at(-1) === "idle:succeeded" && mainRequests().length === mainBefore + 1);
    expect((await serverCall("GET", `/api/session/${resume}/inbox`)).json.data).toEqual([]);
    expect((await storeOf()).slice(-3)).toEqual(["user:STEERED_MARKER while idle", "assistant", "idle:succeeded"]);
  }, 60_000);

  it("takes a steered input back out when the turn is stopped before the server delivered it", async () => {
    const mainBefore = mainRequests().length;
    const running = turn("go SLOW");
    await waitFor(() => mainRequests().length === mainBefore + 1);
    await new Promise((r) => setTimeout(r, 1500));
    // The server holds a steer until the step it arrived in ends, so this one is still waiting.
    const outcome = engine.steer(sessionId, "STEERED_MARKER never delivered");
    await waitFor(async () => ((await serverCall("GET", `/api/session/${resume}/inbox`)).json.data as unknown[]).length === 1);
    engine.kill(sessionId, USER_STOP_INTERRUPTION_REASON);
    const { result } = await running;
    expect(result.error).toBe(USER_STOP_INTERRUPTION_REASON);
    expect(await outcome).toBe("withdrawn");
    expect((await serverCall("GET", `/api/session/${resume}/inbox`)).json.data).toEqual([]);
    // Nothing ran it unattended afterwards.
    await new Promise((r) => setTimeout(r, 1500));
    expect(mainRequests().slice(mainBefore).some((r) => r.all.includes("never delivered"))).toBe(false);
    expect(engine.isAlive(sessionId)).toBe(false);
  }, 60_000);

  it("switches the session's model when a turn names another", async () => {
    const { result } = await turn("which model", { model: "mock/m2" });
    expect(result.error).toBeUndefined();
    expect(mainRequests().at(-1)!.model).toBe("m2");
  }, 60_000);

  it("stops a turn, and tells the next turn the user stopped it", async () => {
    const running = turn("go SLOW");
    await new Promise((r) => setTimeout(r, 2500));
    engine.kill(sessionId, USER_STOP_INTERRUPTION_REASON);
    const { result } = await running;
    expect(result.error).toBe(USER_STOP_INTERRUPTION_REASON);
    expect(engine.isAlive(sessionId)).toBe(false);
    const next = await turn("after the stop");
    expect(next.result.error).toBeUndefined();
    expect(mainRequests().at(-1)!.all).toContain("the user stopped the request(s) below");
    expect(mainRequests().at(-1)!.all).toContain("go SLOW");
  }, 60_000);

  it("compacts the session and re-seeds the system prompt for the next turn", async () => {
    const { result } = await turn("/compact");
    expect(result.error).toBeUndefined();
    expect(result.compaction?.preTokens).toBeGreaterThan(0);
    const next = await turn("after compaction");
    expect(next.result.error).toBeUndefined();
    const all = mainRequests().at(-1)!.all;
    expect(all).toContain("Mock objective");
    expect(all).toContain("Your context was just compacted");
    expect(all).toContain("SYSTEM_PROMPT_MARKER");
  }, 120_000);

  it("puts the system prompt back, once, after opencode compacts the session itself", async () => {
    const marker = "SYSTEM_PROMPT_MARKER";
    const count = (all: string) => all.split(marker).length - 1;
    // The answer reports a context past the budget; opencode compacts at the top of the session's next execution,
    // inside the next turn, whose delivered prompt cannot carry the system prompt: the turn after it does.
    const filled = await turn("fill the context BIGCONTEXT");
    expect(filled.result.error).toBeUndefined();
    const compacting = await turn("the turn opencode compacts at the start of");
    expect(compacting.result.error).toBeUndefined();
    expect(compacting.result.notices).toBeUndefined();
    expect(mainRequests().at(-1)!.all).toContain("Mock objective");
    expect(mainRequests().at(-1)!.all).not.toContain("Your context was just compacted");
    const next = await turn("after the native compaction");
    expect(next.result.error).toBeUndefined();
    const sent = mainRequests().at(-1)!.all;
    expect(sent).toContain("Your context was just compacted");
    expect(count(sent)).toBe(1);
    // Once: a turn after that sends it no more.
    await turn("and one more");
    expect(mainRequests().at(-1)!.all).toContain("after the native compaction");
    expect(count(mainRequests().at(-1)!.all)).toBe(1);
  }, 120_000);

  it("retries a pre-stream 400 in place (error-retry plugin), so the turn answers", async () => {
    const { result } = await turn("once E400ONCE", { model: "opencode-go/m2" });
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("hello from mock");
    const last = mainRequests().slice(-2);
    expect(last.map((r) => r.url.split("/")[1])).toEqual(["primary", "primary"]);
  }, 120_000);

  it("caps a shell command the model gave no timeout at the command ceiling, and the turn carries on", async () => {
    const lifecycle = new PtyLifecycleManager({ maxLivePtys: 8, enforceLocalCap: false });
    const capped = new OpencodeServerPool(lifecycle, { bin: () => BIN, limits: () => ({ startTimeoutMs: 120_000 }), commandTimeoutMs: () => 2000 });
    const cappedEngine = new OpencodeEngine({ mode: () => "server", servers: capped, commandTimeoutMs: () => 2000 });
    try {
      const args = Buffer.from(JSON.stringify({ command: "sleep 30", description: "wait", timeout: 0 })).toString("base64");
      const deltas: StreamDelta[] = [];
      const started = Date.now();
      const result = await cappedEngine.run({
        prompt: `wait CALLTOOL=shell ARGS64=${args}`, cwd: path.join(home, "work"), sessionId: `${sessionId}-capped`, bin: BIN, model: "mock/m1",
        onStream: (d) => deltas.push(d),
      });
      expect(result.error).toBeUndefined();
      expect(result.result).toBe("tool done");
      expect(Date.now() - started).toBeLessThan(25_000);
      expect(deltas.some((d) => d.type === "tool_result" && /exceeded timeout of 2000 ms/.test(d.content))).toBe(true);
    } finally {
      cappedEngine.killAll();
      await capped.stopAll();
    }
  }, 120_000);
});
