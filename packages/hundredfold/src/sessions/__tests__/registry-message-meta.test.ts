import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Point the DB at a throwaway dir BEFORE importing the registry (SESSIONS_DB is
// resolved from HUNDREDFOLD_HOME at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-message-meta-"));
process.env.HUNDREDFOLD_HOME = tmp;

type Reg = typeof import("../registry.js");
let reg: Reg;
let db: ReturnType<typeof import("../../shared/db.js").initDb>;

beforeAll(async () => {
  reg = await import("../registry.js");
  db = (await import("../../shared/db.js")).initDb();
});

const storedMeta = (id: string): unknown => {
  const row = db.prepare("SELECT meta FROM messages WHERE id = ?").get(id) as { meta: string | null };
  return row.meta === null ? null : JSON.parse(row.meta);
};

describe("mergeMessageMeta", () => {
  it("adds a key without dropping the others", () => {
    const s = reg.createSession({ engine: "mock", source: "web", sourceRef: "web:meta-keep" });
    const id = reg.insertMessage(s.id, "assistant", "hello", undefined, undefined, undefined, { kind: "keep-me", voice: { ttfaMs: 120 } });
    expect(reg.mergeMessageMeta(id, { voice: { spokenText: "hel", interrupted: true } })).toBe(true);
    expect(storedMeta(id)).toEqual({ kind: "keep-me", voice: { ttfaMs: 120, spokenText: "hel", interrupted: true } });
  });

  it("creates the meta when the row has none", () => {
    const s = reg.createSession({ engine: "mock", source: "web", sourceRef: "web:meta-null" });
    const id = reg.insertMessage(s.id, "assistant", "hello");
    expect(storedMeta(id)).toBeNull();
    expect(reg.mergeMessageMeta(id, { voice: { ttfaMs: 80 } })).toBe(true);
    expect(storedMeta(id)).toEqual({ voice: { ttfaMs: 80 } });
  });

  it("overwrites a key it names", () => {
    const s = reg.createSession({ engine: "mock", source: "web", sourceRef: "web:meta-overwrite" });
    const id = reg.insertMessage(s.id, "assistant", "hello", undefined, undefined, undefined, { voice: { ttfaMs: 500 } });
    reg.mergeMessageMeta(id, { voice: { ttfaMs: 90 } });
    expect(storedMeta(id)).toEqual({ voice: { ttfaMs: 90 } });
  });

  it("changes nothing for an unknown id", () => {
    expect(reg.mergeMessageMeta("no-such-message", { voice: { ttfaMs: 1 } })).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE id = 'no-such-message'").get()).toEqual({ n: 0 });
  });

  it("keeps two writers' different keys when they run one after the other", () => {
    const s = reg.createSession({ engine: "mock", source: "web", sourceRef: "web:meta-two" });
    const id = reg.insertMessage(s.id, "assistant", "hello");
    reg.mergeMessageMeta(id, { voice: { ttfaMs: 70 } });
    reg.mergeMessageMeta(id, { voice: { spokenText: "hello" } });
    expect(storedMeta(id)).toEqual({ voice: { ttfaMs: 70, spokenText: "hello" } });
  });
});

describe("latestAssistantMessageId", () => {
  it("is the newest assistant text row since the time asked, never a tool call or a user row", () => {
    const s = reg.createSession({ engine: "mock", source: "web", sourceRef: "web:meta-latest" });
    const before = Date.now() - 1;
    reg.insertMessage(s.id, "user", "question");
    const older = reg.insertMessage(s.id, "assistant", "first");
    const newer = reg.insertMessage(s.id, "assistant", "second");
    db.prepare("INSERT INTO messages (id, session_id, role, content, timestamp, tool_call) VALUES (?, ?, 'assistant', 'tool', ?, 'Bash')")
      .run("tool-row-meta-latest", s.id, Date.now() + 5);
    expect(reg.latestAssistantMessageId(s.id, before)).toBe(newer);
    expect(older).not.toBe(newer);
    expect(reg.latestAssistantMessageId(s.id, Date.now() + 10_000)).toBeUndefined();
  });
});
