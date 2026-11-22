import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildVoiceEnvelope, VOICE_PROMPT_OPEN, VOICE_REMINDER } from "../envelope.js";
import { transcriptEntryText } from "../../gateway/external-turns.js";
import { VoiceHub } from "../hub.js";
import { baseConfig } from "./hub-harness.js";
import { FakeClock, FakeSocket, FakeStt, FakeTts, FakeVad, settle } from "./fakes.js";

// A throwaway home before anything that reads it is imported.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-voice-deliver-"));
process.env.HUNDREDFOLD_HOME = tmpHome;
fs.mkdirSync(path.join(tmpHome, "org"), { recursive: true });

type Registry = typeof import("../../sessions/registry.js");
type Deliver = typeof import("../deliver.js");
let registry: Registry;
let deliver: Deliver;
let queueItems: typeof import("../../sessions/queue-item-registry.js");
let merge: typeof import("../../sessions/queue-merge.js");

interface StubEngine {
  name: string;
  runs: Array<{ prompt: string; sessionId?: string }>;
  kills: string[];
  steered: string[];
  turnRunning: boolean;
  work: { tool: string; startedAt: number; description: string | null } | null;
  run: (opts: { prompt: string; sessionId?: string }) => Promise<{ result: string }>;
  [member: string]: unknown;
}

function stubEngine(over: { steerable?: boolean; reportsWork?: boolean } = {}): StubEngine {
  const engine: StubEngine = {
    name: "stub", runs: [], kills: [], steered: [], turnRunning: false, work: null,
    run: async (opts) => { engine.runs.push({ prompt: opts.prompt, sessionId: opts.sessionId }); return { result: "ok" }; },
    isAlive: () => engine.turnRunning,
    isTurnRunning: () => engine.turnRunning,
    kill: (id: string) => { engine.kills.push(id); },
    killAll: () => {},
    killIdle: () => {},
    foregroundWork: () => engine.work,
  };
  if (over.reportsWork === false) delete engine.foregroundWork;
  if (over.steerable) {
    engine.canSteer = () => true;
    engine.steer = async (_id: string, prompt: string) => { engine.steered.push(prompt); return "steered"; };
  }
  return engine;
}

let engine: StubEngine = stubEngine();
const emitted: string[] = [];
const queueStub = {
  enqueue: async (_key: string, fn: () => Promise<void>) => { await fn(); },
  clearCancelled: () => {},
  isPaused: () => false,
  clearQueue: () => {},
  pauseQueue: () => {},
  resumeQueue: () => {},
  getPendingCount: () => 0,
  getRowlessWaitingCount: () => 0,
  getTransportState: (_key: string, status: string) => status,
};
const context = {
  getConfig: () => ({
    gateway: {}, engines: { default: "codex", codex: { bin: "codex", model: "gpt-5.5" } }, sessions: {},
    mcp: { browser: { enabled: false }, gateway: { enabled: false } },
  }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: (event: string) => { emitted.push(event); },
  sessionManager: { getEngines: () => new Map(), getEngine: () => engine, getQueue: () => queueStub },
} as unknown as import("../../gateway/api.js").ApiContext;

beforeAll(async () => {
  registry = await import("../../sessions/registry.js");
  deliver = await import("../deliver.js");
  queueItems = await import("../../sessions/queue-item-registry.js");
  merge = await import("../../sessions/queue-merge.js");
}, 120_000);

afterAll(() => { fs.rmSync(tmpHome, { recursive: true, force: true }); });

beforeEach(() => {
  engine = stubEngine();
  emitted.length = 0;
});

let n = 0;
function newSession(status?: "running") {
  const session = registry.createSession({ engine: "codex", source: "web", sourceRef: `web:voice-deliver-${n++}` });
  if (status) registry.updateSession(session.id, { status });
  return session;
}

async function engineRan(count = 1): Promise<void> {
  for (let i = 0; i < 1500 && engine.runs.length < count; i += 1) await new Promise((r) => setTimeout(r, 10));
}

const meta = { voice: { utteranceId: "u1", sttProvider: "local", audioMs: 1200 } };

describe("a spoken message reaches the session like a typed one", () => {
  it("stores only the person's words and the voice facts; the engine gets the envelope ahead of them", async () => {
    const session = newSession();
    const envelope = buildVoiceEnvelope({ text: "what time is it", prompt: "Be brief.", full: true });
    const result = await deliver.deliverVoiceMessage(context, { sessionId: session.id, text: "what time is it", envelope, meta, mode: "queue", operator: true });
    await engineRan();

    const rows = registry.getMessages(session.id).filter((m) => m.role === "user");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(result.messageId);
    expect(rows[0].content).toBe("what time is it");
    expect(rows[0].meta).toEqual(meta);

    expect(engine.runs).toHaveLength(1);
    expect(engine.runs[0].prompt.startsWith(`${VOICE_PROMPT_OPEN}\nBe brief.`)).toBe(true);
    expect(engine.runs[0].prompt.endsWith("\n\nwhat time is it")).toBe(true);
    // What the engine's own transcript would hold reads back as the stored message: no second row.
    expect(transcriptEntryText({ type: "user", message: { content: engine.runs[0].prompt }, timestamp: new Date().toISOString() }))
      .toEqual({ role: "user", content: "what time is it" });
  });

  it("the queue row keeps the clean text and carries the envelope in its dispatch payload", async () => {
    const session = newSession();
    const envelope = `${VOICE_REMINDER}\n\n`;
    await deliver.deliverVoiceMessage(context, { sessionId: session.id, text: "and now this", envelope, meta, mode: "queue", operator: true });
    await engineRan();
    const messages = registry.getMessages(session.id).filter((m) => m.role === "user");
    expect(messages.map((m) => m.content)).toEqual(["and now this"]);
    expect(engine.runs[0].prompt).toBe(`${envelope}and now this`);
  });

  it("a command goes through with no envelope, exactly as typed", async () => {
    const session = newSession();
    await deliver.deliverVoiceMessage(context, { sessionId: session.id, text: "/hello-skill now", envelope: "", meta, mode: "queue", operator: true });
    await engineRan();
    expect(engine.runs[0].prompt).toBe("/hello-skill now");
  });

  it("refuses a session that is gone or a terminal", async () => {
    await expect(deliver.deliverVoiceMessage(context, { sessionId: "nope", text: "x", envelope: "", meta, mode: "queue", operator: true })).rejects.toThrow(/not found/);
  });

  it("an interrupted-state session is resumed and a limit-paused one is retried, as for a typed message", async () => {
    const waiting = newSession();
    registry.updateSession(waiting.id, { status: "waiting" });
    await deliver.deliverVoiceMessage(context, { sessionId: waiting.id, text: "retry now", envelope: "", meta, mode: "queue", operator: true });
    await engineRan();
    expect(engine.runs.length).toBeGreaterThan(0);
  });
});

describe("a running turn is cut only when nothing long runs in it", () => {
  it("interrupt with no foreground work is the existing send-now: the engine is killed once", async () => {
    const session = newSession("running");
    engine.turnRunning = true;
    await deliver.deliverVoiceMessage(context, { sessionId: session.id, text: "stop that", envelope: "", meta, mode: "interrupt", operator: true });
    expect(engine.kills).toEqual([session.id]);
    expect(emitted).toContain("session:interrupted");
  });

  it("interrupt while the engine reports a foreground call is carried out as a queued message: never a kill", async () => {
    const session = newSession("running");
    engine.turnRunning = true;
    engine.work = { tool: "Bash", startedAt: Date.now() - 60_000, description: "pnpm test" };
    await deliver.deliverVoiceMessage(context, { sessionId: session.id, text: "stop that", envelope: "", meta, mode: "interrupt", operator: true });
    expect(engine.kills).toEqual([]);
    expect(emitted).not.toContain("session:interrupted");
    const rows = registry.getMessages(session.id).filter((m) => m.role === "user");
    expect(rows).toHaveLength(1);
  });

  it("interrupt on an engine that cannot say what is running is carried out as a queued message: it is taken to be running long work", async () => {
    engine = stubEngine({ reportsWork: false });
    const session = newSession("running");
    engine.turnRunning = true;
    await deliver.deliverVoiceMessage(context, { sessionId: session.id, text: "stop that", envelope: "", meta, mode: "interrupt", operator: true });
    expect(engine.kills).toEqual([]);
    expect(emitted).not.toContain("session:interrupted");
  });

  it("interrupt on a session whose turn is not running kills nothing", async () => {
    const session = newSession();
    await deliver.deliverVoiceMessage(context, { sessionId: session.id, text: "hello", envelope: "", meta, mode: "interrupt", operator: true });
    expect(engine.kills).toEqual([]);
  });

  it("queue never kills, whatever is running", async () => {
    const session = newSession("running");
    engine.turnRunning = true;
    await deliver.deliverVoiceMessage(context, { sessionId: session.id, text: "later", envelope: "", meta, mode: "queue", operator: true });
    expect(engine.kills).toEqual([]);
  });

  it("steer hands the engine prompt, envelope included, to the running turn, and the row does not run a second turn", async () => {
    engine = stubEngine({ steerable: true });
    const session = newSession("running");
    engine.turnRunning = true;
    const envelope = `${VOICE_REMINDER}\n\n`;
    await deliver.deliverVoiceMessage(context, { sessionId: session.id, text: "also check logs", envelope, meta, mode: "steer", operator: true });
    for (let i = 0; i < 50 && engine.steered.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(engine.steered).toEqual([`${envelope}also check logs`]);
    await new Promise((r) => setTimeout(r, 150));
    expect(engine.runs).toHaveLength(0);
    expect(engine.kills).toEqual([]);
  });

  it("steer on an engine that cannot take it is queued instead", async () => {
    const session = newSession("running");
    engine.turnRunning = true;
    await deliver.deliverVoiceMessage(context, { sessionId: session.id, text: "queued instead", envelope: "", meta, mode: "steer", operator: true });
    await engineRan();
    expect(engine.runs.map((r) => r.prompt)).toEqual(["queued instead"]);
  });
});

describe("a send-now folds parked messages without dropping the voice envelope", () => {
  it("the merged row keeps the first spoken row's envelope, and no envelope appears from nowhere", () => {
    const session = newSession();
    const key = session.sessionKey || session.sourceRef || session.id;
    const envelope = `${VOICE_REMINDER}\n\n`;
    const typed = queueItems.enqueueQueueItem(session.id, key, "typed one", { dispatch: { attachments: [], speechDerived: false } });
    const spoken = queueItems.enqueueQueueItem(session.id, key, "spoken two", { dispatch: { attachments: [], speechDerived: false, voiceEnvelope: envelope } });
    const folded = merge.mergePendingQueueItems(key, spoken);
    expect(folded).toEqual([typed]);
    const merged = queueItems.getQueueItem(spoken);
    expect(merged?.prompt).toBe("typed one\n\nspoken two");
    expect(merged?.dispatch?.voiceEnvelope).toBe(envelope);

    const a = queueItems.enqueueQueueItem(session.id, key, "plain a", { dispatch: { attachments: [], speechDerived: false } });
    queueItems.enqueueQueueItem(session.id, key, "plain b", { dispatch: { attachments: [], speechDerived: false } });
    merge.mergePendingQueueItems(key, a);
    expect(queueItems.getQueueItem(a)?.dispatch?.voiceEnvelope).toBeUndefined();
  });
});

describe("what the hub stores on the chat, through the real registry (what the web re-reads)", () => {
  it("the user message carries utteranceId, sttProvider and audioMs; the reply carries spokenText and ttfaMs, and interrupted when cut off", async () => {
    const session = newSession();
    const clock = new FakeClock();
    const stt = new FakeStt();
    const tts = new FakeTts();
    const vads: FakeVad[] = [];
    let ids = 0;
    const hub = new VoiceHub({
      config: () => baseConfig(),
      providers: () => ({ stt, tts, createVad: () => { const vad = new FakeVad(); vads.push(vad); return vad; } }),
      getSession: (id) => registry.getSession(id),
      getEngine: () => engine as unknown as import("../../shared/types.js").Engine,
      turnRunning: () => false,
      deliver: (delivery) => deliver.deliverVoiceMessage(context, delivery),
      mergeMessageMeta: (id, patch) => { registry.mergeMessageMeta(id, patch); },
      findReplyMessageId: registry.latestAssistantMessageId,
      externalRepliesSince: registry.externalRepliesSince,
      clock,
      log: { info: () => undefined, warn: () => undefined },
      newId: () => `id${++ids}`,
    });
    const socket = new FakeSocket();
    const attachment = hub.attach(socket, { sessionId: session.id, principal: { kind: "operator" } })!;
    attachment.onText(JSON.stringify({ type: "hello", protocol: 1, mode: "hands-free", client: "web" }));

    // 1. A spoken question; the session answers.
    vads[0].start(0);
    for (let i = 0; i < 10; i += 1) attachment.onBinary(Buffer.alloc(640, 1));
    vads[0].end();
    clock.advance(40);
    stt.last().final("what is two plus two");
    await settle();
    await engineRan();
    const user = registry.getMessages(session.id).filter((m) => m.role === "user")[0];
    expect(user.content).toBe("what is two plus two");
    expect(user.meta).toEqual({ voice: { utteranceId: "id2", sttProvider: "fake-stt", audioMs: expect.any(Number) } });

    clock.advance(300);
    hub.onEvent("session:started", { sessionId: session.id });
    hub.onEvent("session:delta", { sessionId: session.id, type: "text", content: "It is four. Anything else? " });
    await settle();
    hub.onEvent("session:completed", { sessionId: session.id, result: "It is four. Anything else?", error: null });
    await settle();
    const reply = registry.getMessages(session.id).filter((m) => m.role === "assistant").slice(-1)[0];
    // The engine's own settle wrote its keys on the row (assistantPhase, turnOutcome); the voice facts merge in beside them.
    expect(reply.meta).toMatchObject({ assistantPhase: "final", voice: { spokenText: "It is four. Anything else?", ttfaMs: 300 } });
    expect((reply.meta as { voice: Record<string, unknown> }).voice).toEqual({ spokenText: "It is four. Anything else?", ttfaMs: 300 });

    // 2. The person talks over the next reply: it is marked interrupted, with what was heard.
    hub.onEvent("session:started", { sessionId: session.id });
    hub.onEvent("session:delta", { sessionId: session.id, type: "text", content: "A long second reply here. And more after it. " });
    await settle();
    const second = registry.insertMessage(session.id, "assistant", "A long second reply here. And more after it.");
    hub.onEvent("session:completed", { sessionId: session.id, result: "A long second reply here. And more after it.", error: null });
    await settle();
    attachment.onText(JSON.stringify({ type: "barge_in", segmentId: 4, playedMs: 0 }));
    vads[0].start();
    for (let i = 0; i < 5; i += 1) attachment.onBinary(Buffer.alloc(640, 1));
    vads[0].end();
    stt.last().final("stop");
    await settle();
    expect(registry.getMessages(session.id).find((m) => m.id === second)?.meta).toMatchObject({ voice: { interrupted: true, spokenText: expect.any(String) } });
    hub.shutdown();
  });
});
