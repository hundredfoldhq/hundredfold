import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Engine, EngineResult, EngineRunOpts, HundredfoldConfig, StreamDelta } from "../../shared/types.js";
import type { CompactionStats } from "../../shared/compaction-stats.js";
import type { TurnReceipt, TurnSurface } from "../turn/types.js";

/**
 * an operator's `/compact`, end to end through `runTurn` — what the
 * engine is handed, what the chat is told, and how the session settles.
 */

// Every engine counts as installed, so a rate-limited Claude has a fallback to
// switch to — the path a compaction must never take.
vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));

// Isolate the DB: HUNDREDFOLD_HOME must be set before importing the registry.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-compact-command-"));
process.env.HUNDREDFOLD_HOME = tmp;
const reg = await import("../registry.js");
const { runTurn } = await import("../turn/runner.js");
const { supersedeRunningTurn } = await import("../turn/superseded.js");
const { COMPACT_STARTED_STATUS, COMPACTION_UNCONFIRMED } = await import("../compact-command.js");

interface Recorded {
  events: string[];
  notices: string[];
  deltas: StreamDelta[];
  replies: string[];
  receipts: TurnReceipt[];
  /** What the surface was told of confirmed compactions, with the meter's reading at that moment. */
  compactions: Array<{ stats: CompactionStats; meter: number | null | undefined }>;
}

function recordingSurface(sessionId?: string): { surface: TurnSurface; seen: Recorded } {
  const seen: Recorded = { events: [], notices: [], deltas: [], replies: [], receipts: [], compactions: [] };
  const surface: TurnSurface = {
    started: async () => { seen.events.push("started"); },
    delta: (d) => { seen.events.push(`delta:${d.type}`); seen.deltas.push(d); },
    notice: async (text) => { seen.events.push("notice"); seen.notices.push(text); },
    reply: async (text) => { seen.replies.push(text); },
    waiting: async () => {},
    settled: async (receipt) => { seen.events.push("settled"); seen.receipts.push(receipt); },
    compacted: (stats) => { seen.compactions.push({ stats, meter: sessionId ? reg.getSession(sessionId)?.lastContextTokens : undefined }); },
  };
  return { surface, seen };
}

function recordingEngine(name: string, behaviour: (opts: EngineRunOpts, call: number) => Promise<EngineResult>) {
  const prompts: string[] = [];
  const engine: Engine = {
    name,
    async run(opts) {
      prompts.push(opts.prompt);
      return behaviour(opts, prompts.length);
    },
  };
  return { engine, prompts };
}

const config = { gateway: {}, engines: { default: "claude", opencode: { mode: "server" } }, sessions: {} } as unknown as HundredfoldConfig;

interface RunArgs {
  engineName: string;
  engine: Engine;
  sessionId: string;
  prompt: string;
  surface: TurnSurface;
  config?: HundredfoldConfig;
  /** Engines registered alongside the session's own. */
  engines?: Array<[string, Engine]>;
}

async function runOne(engineName: string, engine: Engine, sessionId: string, prompt: string, surface: TurnSurface): Promise<void> {
  return runWith({ engineName, engine, sessionId, prompt, surface });
}

/** `runOne`, with a different config or extra engines alongside. */
async function runWith({ engineName, engine, sessionId, prompt, surface, ...extra }: RunArgs): Promise<void> {
  const started = reg.beginSessionAttempt(sessionId)!;
  await runTurn({
    session: reg.getSession(sessionId)!,
    attemptToken: started.attemptToken!,
    prompt,
    attachments: [],
    config: extra.config ?? config,
    engines: new Map([[engineName, engine], ...(extra.engines ?? [])]),
    gatewayBootId: "test-boot",
    connectorNames: [],
    channel: "web",
    user: "operator",
  }, surface);
}

function establishedSession(engine: string, sourceRef: string): string {
  const created = reg.createSession({ engine, source: "web", sourceRef, model: "opus" });
  reg.recordEngineSessionId(created.id, engine, `${engine}-thread-1`, { model: "opus" });
  return created.id;
}

describe("/compact through runTurn", () => {
  beforeEach(async () => {
    const db = (await import("../../shared/db.js")).initDb();
    db.exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
  });

  it("runs Claude's own /compact and confirms it with the sizes either side", async () => {
    const sessionId = establishedSession("claude", "web:compact-claude");
    const { engine, prompts } = recordingEngine("claude", async () => ({
      sessionId: "claude-thread-1", result: "", compaction: { preTokens: 123_456, postTokens: 2_706 }, contextTokens: 2_706,
    }));
    const { surface, seen } = recordingSurface();

    await runOne("claude", engine, sessionId, "/compact keep the Todo ids", surface);

    expect(prompts).toEqual(["/compact keep the Todo ids"]);
    // Status while it runs, the confirmation before the turn completes.
    expect(seen.events).toEqual(["started", "delta:status", "notice", "settled"]);
    expect(seen.deltas[0]).toEqual({ type: "status", content: COMPACT_STARTED_STATUS });
    expect(seen.notices).toEqual(["🗜️ Context compacted: 123k tokens → 2.7k tokens."]);
    // Nothing is claimed as the model's answer, and nothing goes up as a result.
    expect(seen.receipts[0]!.result).toBe("");
    expect(reg.getMessages(sessionId).filter((m) => m.role === "assistant")).toEqual([]);
    const settled = reg.getSession(sessionId)!;
    expect(settled.status).toBe("idle");
    expect(settled.lastContextTokens).toBe(2_706);
  });

  it("tells the surface of a confirmed compaction once the meter holds the size after it", async () => {
    const sessionId = establishedSession("claude", "web:compact-told");
    reg.updateSession(sessionId, { lastContextTokens: 123_456 });
    const { engine } = recordingEngine("claude", async () => ({
      sessionId: "claude-thread-1", result: "", compaction: { preTokens: 123_456, postTokens: 2_706 }, contextTokens: 2_706,
    }));
    const { surface, seen } = recordingSurface(sessionId);

    await runOne("claude", engine, sessionId, "/compact", surface);

    // Told before the turn completes, so a live view corrects its streamed figure first.
    expect(seen.compactions).toEqual([{ stats: { preTokens: 123_456, postTokens: 2_706 }, meter: 2_706 }]);
  });

  it("tells the surface of an opencode compaction that reports no size after it, with none to give", async () => {
    const sessionId = establishedSession("opencode", "web:compact-told-oc");
    const { engine } = recordingEngine("opencode", async () => ({
      sessionId: "opencode-thread-1", result: "", compaction: { preTokens: 48_200 },
    }));
    const { surface, seen } = recordingSurface(sessionId);

    await runOne("opencode", engine, sessionId, "/compact", surface);

    expect(seen.compactions).toEqual([{ stats: { preTokens: 48_200 }, meter: null }]);
  });

  it("does not tell the surface of a compaction the engine never confirmed, or that failed", async () => {
    const unconfirmed = establishedSession("claude", "web:compact-told-none");
    const { surface: quiet, seen: quietSeen } = recordingSurface(unconfirmed);
    await runOne("claude", recordingEngine("claude", async () => ({ sessionId: "claude-thread-1", result: "" })).engine, unconfirmed, "/compact", quiet);
    expect(quietSeen.compactions).toEqual([]);

    const failed = establishedSession("claude", "web:compact-told-failed");
    const { surface: failing, seen: failedSeen } = recordingSurface(failed);
    await runOne("claude", recordingEngine("claude", async () => ({
      sessionId: "claude-thread-1", result: "", error: "boom", compaction: { preTokens: 5_000, postTokens: 900 },
    })).engine, failed, "/compact", failing);
    expect(failedSeen.compactions).toEqual([]);
  });

  it("tells the surface the size the meter is written with, never one the meter does not hold", async () => {
    const sessionId = establishedSession("claude", "web:compact-told-agree");
    reg.updateSession(sessionId, { lastContextTokens: 123_456 });
    // Stats carry a size after the compaction but the engine gave no reading: the meter is emptied.
    const { engine } = recordingEngine("claude", async () => ({
      sessionId: "claude-thread-1", result: "", compaction: { preTokens: 123_456, postTokens: 2_706 },
    }));
    const { surface, seen } = recordingSurface(sessionId);

    await runOne("claude", engine, sessionId, "/compact", surface);

    expect(seen.compactions).toEqual([{ stats: { preTokens: 123_456 }, meter: null }]);
  });

  it("does not tell the surface of a compaction a newer message cut off", async () => {
    const sessionId = establishedSession("claude", "web:compact-told-preempted");
    const { engine } = recordingEngine("claude", async () => {
      supersedeRunningTurn(reg.getSession(sessionId)!);
      return { sessionId: "claude-thread-1", result: "", compaction: { preTokens: 5_000, postTokens: 900 }, contextTokens: 900 };
    });
    const { surface, seen } = recordingSurface(sessionId);

    await runOne("claude", engine, sessionId, "/compact", surface);

    expect(seen.compactions).toEqual([]);
  });

  it("does not tell the surface of compaction stats on a turn that was not a compaction", async () => {
    const sessionId = establishedSession("claude", "web:compact-told-plain");
    const { engine } = recordingEngine("claude", async () => ({
      sessionId: "claude-thread-1", result: "an answer", compaction: { preTokens: 5_000, postTokens: 900 }, contextTokens: 900,
    }));
    const { surface, seen } = recordingSurface(sessionId);

    await runOne("claude", engine, sessionId, "just a message", surface);

    expect(seen.compactions).toEqual([]);
  });

  it("confirms an opencode compaction with the size it replaced", async () => {
    const sessionId = establishedSession("opencode", "web:compact-opencode");
    const { engine, prompts } = recordingEngine("opencode", async () => ({
      sessionId: "opencode-thread-1", result: "", numTurns: 1, compaction: { preTokens: 48_200 },
    }));
    const { surface, seen } = recordingSurface();

    await runOne("opencode", engine, sessionId, "/compact", surface);

    expect(prompts).toEqual(["/compact"]);
    expect(seen.notices).toEqual(["🗜️ Context compacted (it was 48.2k tokens)."]);
  });

  it("empties the context meter when the compaction reports no size after it", async () => {
    const sessionId = establishedSession("opencode", "web:compact-meter");
    reg.updateSession(sessionId, { lastContextTokens: 48_200 });
    const { engine } = recordingEngine("opencode", async () => ({
      sessionId: "opencode-thread-1", result: "", compaction: { preTokens: 48_200 },
    }));

    await runOne("opencode", engine, sessionId, "/compact", recordingSurface().surface);

    expect(reg.getSession(sessionId)!.lastContextTokens).toBeNull();
  });

  it("tells the operator opencode ignored their focus text, but not for a self-compaction", async () => {
    const { buildCompactCommand } = await import("../self-compaction.js");
    const compacted = async (): Promise<EngineResult> => ({ sessionId: "opencode-thread-1", result: "", compaction: { preTokens: 900 } });

    const typed = recordingSurface();
    await runOne("opencode", recordingEngine("opencode", compacted).engine,
      establishedSession("opencode", "web:compact-focus"), "/compact keep the Todo ids", typed.surface);
    expect(typed.seen.notices).toEqual([
      "🗜️ Context compacted (it was 900 tokens). opencode's summarize takes no focus instructions, so the text after `/compact` was not used.",
    ]);

    const self = recordingSurface();
    await runOne("opencode", recordingEngine("opencode", compacted).engine,
      establishedSession("opencode", "web:compact-self"), buildCompactCommand({ goal: "ship TST-1362" }), self.surface);
    expect(self.seen.notices).toEqual(["🗜️ Context compacted (it was 900 tokens)."]);

    const claude = recordingSurface();
    await runOne("claude", recordingEngine("claude", async () => ({ sessionId: "claude-thread-1", result: "", compaction: {} })).engine,
      establishedSession("claude", "web:compact-claude-focus"), "/compact keep the Todo ids", claude.surface);
    expect(claude.seen.notices).toEqual(["🗜️ Context compacted."]);
  });

  it("does not claim a compaction the engine never confirmed", async () => {
    const sessionId = establishedSession("claude", "web:compact-unconfirmed");
    const { engine } = recordingEngine("claude", async () => ({ sessionId: "claude-thread-1", result: "" }));
    const { surface, seen } = recordingSurface();

    await runOne("claude", engine, sessionId, "/compact", surface);

    expect(seen.notices).toEqual([COMPACTION_UNCONFIRMED]);
  });

  it("says nothing of compaction when the compaction failed — the error is the answer", async () => {
    const sessionId = establishedSession("opencode", "web:compact-failed");
    const { engine } = recordingEngine("opencode", async () => ({
      sessionId: "opencode-thread-1", result: "", error: "opencode compaction failed: summarize answered 500",
    }));
    const { surface, seen } = recordingSurface();

    await runOne("opencode", engine, sessionId, "/compact", surface);

    expect(seen.notices).toEqual([]);
    expect(reg.getMessages(sessionId).at(-1)!.content).toContain("summarize answered 500");
  });

  it("answers an engine that cannot compact without ever running it, and does not fail the session", async () => {
    const sessionId = establishedSession("codex", "web:compact-codex");
    const { engine, prompts } = recordingEngine("codex", async () => ({ sessionId: "x", result: "the model answering '/compact'" }));
    const { surface, seen } = recordingSurface();

    await runOne("codex", engine, sessionId, "/compact", surface);

    expect(prompts).toEqual([]);
    expect(seen.events).toEqual(["notice", "settled"]);
    expect(seen.notices[0]).toMatch(/isn't supported on the codex engine.*Nothing was sent to the model/);
    const settled = reg.getSession(sessionId)!;
    expect(settled.status).toBe("idle");
    expect(settled.attemptOutcome).toBe("succeeded");
    expect(settled.lastError ?? null).toBeNull();
  });

  it("never hands a rate-limited /compact to a fallback engine (QA repro)", async () => {
    const sessionId = establishedSession("claude", "web:compact-limited-fallback");
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const { engine: claude, prompts: claudePrompts } = recordingEngine("claude", async () => ({
      sessionId: "claude-thread-1", result: "", error: "rate limit", rateLimit: { status: "rejected", resetsAt },
    }));
    const { engine: codex, prompts: codexPrompts } = recordingEngine("codex", async () => ({ sessionId: "codex-1", result: "Sure — what would you like me to compact?" }));
    const withFallback = { ...config, engines: { ...config.engines, claude: { fallback: ["codex"] }, codex: {} } } as unknown as HundredfoldConfig;
    const { surface, seen } = recordingSurface();

    await runWith({
      engineName: "claude", engine: claude, sessionId, prompt: "/compact", surface, config: withFallback, engines: [["codex", codex]],
    });

    expect(claudePrompts).toEqual(["/compact"]);
    expect(codexPrompts).toEqual([]);
    expect(seen.replies).toEqual([]);
    expect(seen.notices).toEqual([expect.stringMatching(/^⏳ Claude is at its usage limit \(resets .+\), so `\/compact` was not run and the session stays on Claude\./)]);
    const settled = reg.getSession(sessionId)!;
    expect(settled.engine).toBe("claude");
    expect(settled.status).toBe("idle");
    // Recorded like any limited turn's, so the next turn need not rediscover it.
    const { readEngineHealth } = await import("../../shared/engine-health.js");
    expect(readEngineHealth().claude).toMatchObject({ state: "exhausted", reason: "Claude usage limit" });
  });

  it("does not park a rate-limited /compact to retry it when there is no fallback", async () => {
    const sessionId = establishedSession("claude", "web:compact-limited-wait");
    const { engine: claude, prompts } = recordingEngine("claude", async () => ({
      sessionId: "claude-thread-1", result: "", error: "rate limit", rateLimit: { status: "rejected" },
    }));
    const { surface, seen } = recordingSurface();

    await runOne("claude", claude, sessionId, "/compact", surface);

    expect(prompts).toEqual(["/compact"]);
    expect(seen.notices).toEqual([expect.stringContaining("`/compact` was not run")]);
    expect(reg.getSession(sessionId)!.status).toBe("idle");
  });

  it("keeps a message an interrupt held back for the turn after the compaction", async () => {
    const sessionId = establishedSession("claude", "web:compact-carry");
    const { engine, prompts } = recordingEngine("claude", async (_opts, call) => {
      if (call === 1) {
        supersedeRunningTurn(reg.getSession(sessionId)!);
        return { sessionId: "", result: "", error: "Interrupted by a new message" };
      }
      if (call === 2) return { sessionId: "claude-thread-1", result: "", compaction: {} };
      return { sessionId: "claude-thread-1", result: "ok" };
    });
    const quiet = recordingSurface().surface;

    await runOne("claude", engine, sessionId, "Hey", quiet);
    await runOne("claude", engine, sessionId, "/compact", quiet);
    await runOne("claude", engine, sessionId, "Ho", quiet);

    expect(prompts[1]).toBe("/compact");
    expect(prompts[2]).toContain("Hey");
    expect(prompts[2]).toContain("Ho");
  });
});
