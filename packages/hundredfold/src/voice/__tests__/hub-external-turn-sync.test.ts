import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VoiceHub } from "../hub.js";
import { baseConfig } from "./hub-harness.js";
import { FakeClock, FakeSocket, FakeStt, FakeTts, FakeVad, settle } from "./fakes.js";

// A throwaway home before anything that reads it is imported.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-voice-external-"));
process.env.HUNDREDFOLD_HOME = tmpHome;

type Registry = typeof import("../../sessions/registry.js");
type External = typeof import("../../gateway/external-turns.js");
let registry: Registry;
let external: External;

beforeAll(async () => {
  registry = await import("../../sessions/registry.js");
  external = await import("../../gateway/external-turns.js");
  (await import("../../shared/db.js")).initDb();
});

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

let counter = 0;

/** A transcript jsonl of [role, text, offset in ms from now] entries, as the Claude CLI writes it. */
function writeTranscript(entries: Array<{ type: "user" | "assistant"; text: string; offsetMs: number }>): string {
  const file = path.join(tmpHome, `transcript-${++counter}.jsonl`);
  fs.writeFileSync(file, entries.map((e) => JSON.stringify({
    type: e.type,
    timestamp: new Date(Date.now() + e.offsetMs).toISOString(),
    isSidechain: false,
    message: { role: e.type, content: [{ type: "text", text: e.text }] },
  })).join("\n") + "\n");
  return file;
}

/** A hub on the real registry, with the sync's own emit teed into it as the gateway wires it. */
function liveHub(sessionId: string) {
  const clock = new FakeClock();
  const stt = new FakeStt();
  const tts = new FakeTts();
  const merges: string[] = [];
  const hub = new VoiceHub({
    config: () => baseConfig(),
    providers: () => ({ stt, tts, createVad: () => new FakeVad() }),
    getSession: (id) => registry.getSession(id),
    getEngine: () => undefined,
    turnRunning: () => false,
    deliver: async () => ({ messageId: "unused" }),
    mergeMessageMeta: (id, patch) => { merges.push(id); registry.mergeMessageMeta(id, patch); },
    findReplyMessageId: registry.latestAssistantMessageId,
    newestMessageCursor: registry.newestMessageCursor,
    messageCursor: registry.messageCursor,
    messagesAfterCursor: registry.messagesAfterCursor,
    clock,
    log: { info: () => undefined, warn: () => undefined },
    newId: () => `id${++counter}`,
  });
  const socket = new FakeSocket();
  const attachment = hub.attach(socket, { sessionId, principal: { kind: "operator" } })!;
  attachment.onText(JSON.stringify({ type: "hello", protocol: 1, mode: "hands-free", client: "web" }));
  const emit = (event: string, payload: unknown) => hub.onEvent(event, payload);
  return { hub, socket, emit, tts, merges };
}

function newClaudeSession(): string {
  return registry.createSession({ engine: "claude", source: "web", sourceRef: `web:voice-external-${++counter}`, prompt: "test" }).id;
}

describe("the CLI's own report of finished background work, through the real sync and store (FR-016)", () => {
  it("is spoken, and its stored message learns what was spoken", async () => {
    const id = newClaudeSession();
    registry.insertMessage(id, "user", "run the long build");
    registry.insertMessage(id, "assistant", "It is running in the background.");
    const live = liveHub(id);
    // Claude Code re-invokes the model when the background command ends: a CLI-native turn, no gateway turn.
    const file = writeTranscript([
      { type: "assistant", text: "The build finished with zero errors. Nothing else to report.", offsetMs: 2_000 },
    ]);
    const stored = external.syncExternalTurn(id, live.emit as never, { hook_event_name: "Stop", transcript_path: file });
    expect(stored).toBe(1);
    await settle();
    expect(live.socket.ofType("segment_start").map((f) => f.text)).toEqual(["The build finished with zero errors.", "Nothing else to report."]);
    expect(live.socket.audio().length).toBeGreaterThan(0);
    const row = registry.getMessages(id).filter((m) => m.role === "assistant").slice(-1)[0];
    expect(live.socket.ofType("segment_start")[0].messageId).toBe(row.id);
    expect(row.meta).toMatchObject({ voice: { spokenText: "The build finished with zero errors. Nothing else to report." } });
    live.hub.shutdown();
  });

  it("a sync that reconciles a turn the gateway already stored emits, and speaks nothing", async () => {
    const id = newClaudeSession();
    const live = liveHub(id);
    // The gateway turn: spoken from deltas, then stored.
    live.hub.onEvent("session:started", { sessionId: id });
    live.hub.onEvent("session:delta", { sessionId: id, type: "text", content: "On it." });
    registry.insertMessage(id, "user", "do the thing");
    registry.insertMessage(id, "assistant", "On it.");
    live.hub.onEvent("session:completed", { sessionId: id, result: "On it.", error: null });
    await settle();
    expect(live.socket.ofType("segment_start")).toHaveLength(1);
    // The harness then wrote the full text of that same turn: the sync upgrades the row in place.
    const file = writeTranscript([
      { type: "user", text: "do the thing", offsetMs: 1_000 },
      { type: "assistant", text: "On it. Done, and nothing went wrong.", offsetMs: 2_000 },
    ]);
    const events: string[] = [];
    const stored = external.syncExternalTurn(id, ((event: string, payload: unknown) => { events.push(event); live.emit(event, payload); }) as never, { hook_event_name: "Stop", transcript_path: file });
    expect(stored).toBe(0);
    expect(events).toEqual(["session:external-turn"]);
    await settle();
    expect(registry.getMessages(id).filter((m) => m.role === "assistant").map((m) => m.content)).toEqual(["On it. Done, and nothing went wrong."]);
    expect(live.socket.ofType("segment_start")).toHaveLength(1);
    live.hub.shutdown();
  });

  it("a message stored before the attachment is not spoken when a later sync arrives", async () => {
    const id = newClaudeSession();
    registry.insertMessage(id, "assistant", "Said before anyone attached.");
    const live = liveHub(id);
    live.emit("session:external-turn", { sessionId: id });
    await settle();
    expect(live.socket.ofType("segment_start")).toEqual([]);
    live.hub.shutdown();
  });
});
