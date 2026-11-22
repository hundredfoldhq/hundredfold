import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAutoCompactPolicy } from "../../shared/auto-compact-config.js";
import { logger } from "../../shared/logger.js";
import { redactText } from "../../shared/redact.js";
import type { HundredfoldConfig } from "../../shared/types.js";
import { autoCompactDisabledLogLine, resetDisabledNotices } from "../turn/auto-compact.js";

/**
 * An engine whose auto-compaction is off compacts nothing, and used to say
 * nothing: a fleet of long Claude sessions sat cold-resuming on their whole
 * context while the only `[auto-compact]` lines in the log were opencode's.
 * A long session's turn on such an engine now says so, once per session.
 */

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));

const { reg, recordingEngine, recordingSurface, configWith, coldSession, runOne, answered, ENABLED, MINUTE } =
  await import("./helpers/auto-compact-harness.js");

const policy = resolveAutoCompactPolicy({ engines: {} } as unknown as HundredfoldConfig, "claude")!;

/** The `[auto-compact]` lines logged at info while `fn` runs. */
async function infoLines(fn: () => Promise<void>): Promise<string[]> {
  const info = vi.spyOn(logger, "info");
  try {
    await fn();
    return info.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith("[auto-compact]"));
  } finally {
    info.mockRestore();
  }
}

describe("the disabled-policy line", () => {
  it("names the session, the engine, how cold it is and the key to set, and survives the logger's redaction", () => {
    const line = autoCompactDisabledLogLine({ sessionId: "s1", engine: "claude", context: 325_548, idleMs: 6_720_000, policy, configured: false });
    expect(line).toBe("[auto-compact] session=s1 engine=claude outcome=skipped skip=disabled context=325548 idleSec=6720 cold=true "
      + "config=absent hint=\"set engines.claude.autoCompact.enabled: true to compact long cold sessions before their next turn\"");
    expect(redactText(line)).toBe(line);
  });

  it("tells a block set off from no block, a warm session from a cold one, and writes '-' for an unknown idle time", () => {
    const warm = autoCompactDisabledLogLine({ sessionId: "s2", engine: "claude", context: 150_000, idleMs: 60_000, policy, configured: true });
    expect(warm).toContain("idleSec=60 cold=false config=off");
    const unknown = autoCompactDisabledLogLine({ sessionId: "s3", engine: "opencode", context: 150_000, policy, configured: false });
    expect(unknown).toContain("idleSec=- cold=unknown config=absent");
    expect(unknown).toContain("engines.opencode.autoCompact.enabled");
    expect(redactText(unknown)).toBe(unknown);
  });
});

describe("a long session on an engine with auto-compaction off, through runTurn", () => {
  beforeEach(async () => {
    resetDisabledNotices();
    const db = (await import("../../shared/db.js")).initDb();
    db.exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
  });

  it("says so at info once per session, not on every turn, and still runs the message untouched", async () => {
    const sessionId = coldSession("claude", "web:ac-off-once", 325_548, 112 * MINUTE);
    const { engine, calls } = recordingEngine("claude", async () => answered("claude-thread-1"));

    const first = await infoLines(() => runOne(engine, sessionId, "carry on", recordingSurface().surface, configWith(undefined)));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatch(new RegExp(`^\\[auto-compact\\] session=${sessionId} engine=claude outcome=skipped skip=disabled context=325548 idleSec=67\\d\\d cold=true config=absent `));

    // The turn left the meter at 3,000; make it long again and ask once more.
    reg.updateSession(sessionId, { lastContextTokens: 325_548 });
    const second = await infoLines(() => runOne(engine, sessionId, "and again", recordingSurface().surface, configWith(undefined)));
    expect(second).toEqual([]);
    expect(calls.map((c) => c.prompt)).toEqual(["carry on", "and again"]);

    // Another long session is told in its own right.
    const other = coldSession("claude", "web:ac-off-other", 200_000, 30 * MINUTE);
    const lines = await infoLines(() => runOne(engine, other, "hello", recordingSurface().surface, configWith(undefined)));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`session=${other} `);
  });

  it("says config=off when a block is present but disabled", async () => {
    const sessionId = coldSession("claude", "web:ac-off-block", 180_000, 30 * MINUTE);
    const { engine } = recordingEngine("claude", async () => answered("claude-thread-1"));
    const lines = await infoLines(() => runOne(engine, sessionId, "carry on", recordingSurface().surface, configWith({ ...ENABLED, enabled: false })));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("config=off");
  });

  it("stays quiet for a short session, an enabled engine, and an engine that cannot compact", async () => {
    const { engine } = recordingEngine("claude", async () => answered("claude-thread-1"));
    const short = coldSession("claude", "web:ac-off-short", 20_000, 30 * MINUTE);
    expect(await infoLines(() => runOne(engine, short, "hi", recordingSurface().surface, configWith(undefined)))).toEqual([]);

    // Enabled: the session compacts (its own lines), and none of them says "disabled".
    const enabled = coldSession("claude", "web:ac-on", 180_000, 30 * MINUTE);
    const compacting = recordingEngine("claude", async (_opts, call) => call === 1
      ? { sessionId: "claude-thread-1", result: "", compaction: { preTokens: 180_000, postTokens: 9_000 }, contextTokens: 9_000 }
      : answered("claude-thread-1"));
    const onLines = await infoLines(() => runOne(compacting.engine, enabled, "hi", recordingSurface().surface, configWith(ENABLED)));
    expect(onLines.join("\n")).not.toContain("skip=disabled");

    const codex = coldSession("codex", "web:ac-codex", 500_000, 30 * MINUTE);
    const codexEngine = recordingEngine("codex", async () => answered("codex-thread-1"));
    expect(await infoLines(() => runOne(codexEngine.engine, codex, "hi", recordingSurface().surface, configWith(undefined)))).toEqual([]);
  });
});
