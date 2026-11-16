import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The registry DB is resolved from HUNDREDFOLD_HOME when the module loads: point it at a throwaway dir first.
process.env.HUNDREDFOLD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-pause-notice-"));

type Notice = typeof import("../pause-notice.js");
type Fixture = typeof import("./pause-notice-fixture.js");
let notice: Notice;
let fx: Fixture;

beforeAll(async () => {
  notice = await import("../pause-notice.js");
  fx = await import("./pause-notice-fixture.js");
});

const KINDS = ["compaction", "restart", "usage-limit"] as const;
const LABELS = { compaction: "compaction", restart: "gateway restart", "usage-limit": "usage limit" } as const;

describe("stampSessionPause", () => {
  it("records when and why, and keeps the earliest pause until it is consumed", async () => {
    const session = fx.newSession();
    notice.stampSessionPause(session, "compaction", new Date("2026-01-01T00:00:00.000Z"));
    notice.stampSessionPause(session, "restart", new Date("2026-01-02T00:00:00.000Z"));
    expect(fx.stampOf(session)).toEqual({ at: "2026-01-01T00:00:00.000Z", kind: "compaction" });
  });

  it("does nothing for a session that does not exist", () => {
    expect(() => notice.stampSessionPause("no-such-session", "restart")).not.toThrow();
  });

  it("leaves the rest of the session's transport meta alone", () => {
    const session = fx.newSession({ keep: "me" });
    notice.stampSessionPause(session, "usage-limit");
    expect(fx.metaOf(session)).toMatchObject({ keep: "me", pausedAt: { kind: "usage-limit" } });
  });
});

describe("takePauseNotice", () => {
  it.each(KINDS)("%s: one line for a Todo another actor moved, and the stamp is gone", async (kind) => {
    const session = fx.newSession();
    const todo = await fx.workedTodo(session);
    notice.stampSessionPause(session, kind);
    await fx.tick();
    fx.move(todo, "blocked", "reconciler");

    const line = notice.takePauseNotice(session);

    expect(line).toBe(
      `[Gateway notice] While this session was paused (${LABELS[kind]}), ${todo} moved executing → blocked (by reconciler). `
      + "If that is wrong, correct it with update_work_item; otherwise carry on.",
    );
    expect(line).not.toContain("\n");
    expect(fx.stampOf(session)).toBeUndefined();
    expect(notice.takePauseNotice(session)).toBeUndefined();
  });

  it("names the operator when the operator moved it", async () => {
    const session = fx.newSession();
    const todo = await fx.workedTodo(session);
    notice.stampSessionPause(session, "restart");
    await fx.tick();
    fx.move(todo, "in_review", "operator");
    expect(notice.takePauseNotice(session)).toContain(`${todo} moved executing → in_review (by operator)`);
  });

  it("names another session by its employee, or just as another session", async () => {
    const session = fx.newSession();
    const named = await fx.workedTodo(session);
    const unnamed = await fx.workedTodo(session);
    notice.stampSessionPause(session, "compaction");
    await fx.tick();
    fx.move(named, "blocked", "session:someone-else", { actorEmployee: "parent-dev" });
    fx.move(unnamed, "blocked", "session:someone-else");
    const line = notice.takePauseNotice(session)!;
    expect(line).toContain(`${named} moved executing → blocked (by parent-dev)`);
    expect(line).toContain(`${unnamed} moved executing → blocked (by another session)`);
  });

  it("does not report the session's own moves", async () => {
    const session = fx.newSession();
    const todo = await fx.workedTodo(session);
    notice.stampSessionPause(session, "compaction");
    await fx.tick();
    fx.move(todo, "in_review", `session:${session}`);
    expect(notice.takePauseNotice(session)).toBeUndefined();
    expect(fx.stampOf(session)).toBeUndefined();
  });

  it("does not report a flap that came back to where it was", async () => {
    const session = fx.newSession();
    const todo = await fx.workedTodo(session);
    notice.stampSessionPause(session, "restart");
    await fx.tick();
    fx.move(todo, "blocked", "reconciler");
    fx.move(todo, "executing", "reconciler");
    expect(notice.takePauseNotice(session)).toBeUndefined();
  });

  it("reports the net move across several changes by others", async () => {
    const session = fx.newSession();
    const todo = await fx.workedTodo(session);
    notice.stampSessionPause(session, "restart");
    await fx.tick();
    fx.move(todo, "blocked", "reconciler");
    fx.move(todo, "executing", "reconciler");
    fx.move(todo, "in_review", "operator");
    expect(notice.takePauseNotice(session)).toContain(`${todo} moved executing → in_review (by operator)`);
  });

  it("measures a move by others from where the session's own earlier move left the Todo", async () => {
    const session = fx.newSession();
    const todo = await fx.workedTodo(session);
    notice.stampSessionPause(session, "compaction");
    await fx.tick();
    fx.move(todo, "in_review", `session:${session}`);
    fx.move(todo, "blocked", "operator");
    const line = notice.takePauseNotice(session)!;
    expect(line).toContain(`${todo} moved in_review → blocked (by operator)`);
    expect(line).not.toContain("executing");
  });

  it("reports an escalation to the operator like any other status change", async () => {
    const session = fx.newSession();
    const todo = await fx.workedTodo(session);
    notice.stampSessionPause(session, "restart");
    await fx.tick();
    fx.move(todo, "blocked", "reconciler");
    fx.markLastStatusEventEscalated(todo);
    expect(notice.takePauseNotice(session)).toContain(`${todo} moved executing → blocked (by reconciler)`);
  });

  it("does not tell a session about a Todo it has already corrected itself", async () => {
    const session = fx.newSession();
    const todo = await fx.workedTodo(session);
    notice.stampSessionPause(session, "compaction");
    await fx.tick();
    fx.move(todo, "blocked", "reconciler");
    fx.move(todo, "executing", `session:${session}`);
    fx.move(todo, "in_review", `session:${session}`);
    expect(notice.takePauseNotice(session)).toBeUndefined();
  });

  it("ignores moves made before the pause began", async () => {
    const session = fx.newSession();
    const todo = await fx.workedTodo(session);
    fx.move(todo, "blocked", "reconciler");
    fx.move(todo, "executing", "operator");
    fx.move(todo, "in_review", "operator");
    await fx.tick();
    notice.stampSessionPause(session, "restart");
    expect(notice.takePauseNotice(session)).toBeUndefined();
  });

  it("still finds a Todo whose run the move closed", async () => {
    const session = fx.newSession();
    const todo = await fx.workedTodo(session);
    notice.stampSessionPause(session, "restart");
    await fx.tick();
    fx.move(todo, "blocked", "reconciler");
    fx.closeRun(session, todo);
    expect(notice.takePauseNotice(session)).toContain(`${todo} moved executing → blocked`);
  });

  it("leaves out a Todo whose run closed before the pause when the session is not linked to it", async () => {
    const session = fx.newSession();
    const todo = await fx.workedTodo(session);
    fx.closeRun(session, todo);
    await fx.tick();
    notice.stampSessionPause(session, "restart");
    await fx.tick();
    fx.move(todo, "blocked", "reconciler");
    expect(notice.takePauseNotice(session)).toBeUndefined();
  });

  it.each(KINDS)("finds the Todo a session is linked to after its first run has closed (%s)", async (kind) => {
    const session = fx.newSession();
    const todo = await fx.linkedTodoRunClosed(session);
    await fx.tick();
    notice.stampSessionPause(session, kind);
    await fx.tick();
    fx.move(todo, "blocked", "operator");

    const line = notice.takePauseNotice(session);

    expect(line).toContain(`(${LABELS[kind]})`);
    expect(line).toContain(`${todo} moved executing → blocked (by operator)`);
  });

  it.each(["review", "consult"] as const)("does not count a %s link as a Todo the session works", async (role) => {
    const session = fx.newSession();
    const todo = await fx.linkedTodoRunClosed(session, role);
    await fx.tick();
    notice.stampSessionPause(session, "compaction");
    await fx.tick();
    fx.move(todo, "blocked", "operator");
    expect(notice.takePauseNotice(session)).toBeUndefined();
  });

  it("forgets a pause the operator ended by stopping the session", async () => {
    const { markSessionStopped } = await import("../stopped-marker.js");
    const session = fx.newSession();
    const todo = await fx.linkedTodoRunClosed(session);
    notice.stampSessionPause(session, "usage-limit");
    await fx.tick();
    markSessionStopped(session);
    fx.move(todo, "blocked", "operator");

    expect(fx.stampOf(session)).toBeUndefined();
    expect(notice.takePauseNotice(session)).toBeUndefined();
  });

  it("covers every Todo the session works, at most three named, the rest counted, under about 300 characters", async () => {
    const session = fx.newSession();
    const todos = [] as string[];
    for (let i = 0; i < 5; i += 1) todos.push(await fx.workedTodo(session));
    notice.stampSessionPause(session, "compaction");
    await fx.tick();
    for (const todo of todos) fx.move(todo, "blocked", "reconciler");

    const line = notice.takePauseNotice(session)!;

    expect(todos.slice(0, 3).every((todo) => line.includes(todo))).toBe(true);
    expect(todos.slice(3).some((todo) => line.includes(todo))).toBe(false);
    expect(line).toContain("; and 2 more");
    expect(line.length).toBeLessThanOrEqual(320);
    expect(line).not.toContain("\n");
  });

  it("does not report a Todo some other session works", async () => {
    const session = fx.newSession();
    const mine = await fx.workedTodo(session);
    const theirs = await fx.workedTodo(fx.newSession());
    notice.stampSessionPause(session, "restart");
    await fx.tick();
    fx.move(mine, "blocked", "reconciler");
    fx.move(theirs, "blocked", "reconciler");
    const line = notice.takePauseNotice(session)!;
    expect(line).toContain(mine);
    expect(line).not.toContain(theirs);
  });

  it("consumes the stamp even when the session works no Todo", () => {
    const session = fx.newSession();
    notice.stampSessionPause(session, "restart");
    expect(notice.takePauseNotice(session)).toBeUndefined();
    expect(fx.stampOf(session)).toBeUndefined();
  });

  it("drops a stamp it cannot read", () => {
    const session = fx.newSession({ pausedAt: "garbage" });
    expect(notice.takePauseNotice(session)).toBeUndefined();
    expect(fx.metaOf(session)).not.toHaveProperty("pausedAt");
  });

  it("is undefined for a session that was never paused", () => {
    expect(notice.takePauseNotice(fx.newSession())).toBeUndefined();
    expect(notice.takePauseNotice("no-such-session")).toBeUndefined();
  });
});

describe("who the line says moved it", () => {
  async function labelFor(actor: string, detail?: Record<string, unknown>): Promise<string> {
    const session = fx.newSession();
    const todo = await fx.workedTodo(session);
    notice.stampSessionPause(session, "restart");
    await fx.tick();
    fx.move(todo, "blocked", actor, detail);
    const line = notice.takePauseNotice(session)!;
    return /\(by ([^)]*)\)/.exec(line)![1]!;
  }

  it("names the operator, the reconciler, another session's employee and a board member", async () => {
    expect(await labelFor("operator")).toBe("operator");
    expect(await labelFor("reconciler")).toBe("reconciler");
    expect(await labelFor("session:s-other", { actorEmployee: "parent-dev" })).toBe("parent-dev");
    expect(await labelFor("session:s-other")).toBe("another session");
    expect(await labelFor("user:u_1a2b3c4d5e6f")).toBe("a board member");
  });

  it.each([
    "delegation:3f1c2a9e-1111-2222-3333-444455556666",
    "cron:3f1c2a9e-1111-2222-3333-444455556666",
    "plugin:calendar",
    "workflow:run",
    "todo-recovery",
    "merger",
  ])("says the gateway for the actor %s, and never quotes its id", async (actor) => {
    expect(await labelFor(actor)).toBe("the gateway");
  });
});

describe("takeTurnPause", () => {
  it("covers a carried pause from its earlier start, as one line", async () => {
    const session = fx.newSession();
    const first = await fx.workedTodo(session);
    const second = await fx.workedTodo(session);
    const carried = { at: new Date().toISOString(), kind: "compaction" as const };
    await fx.tick();
    fx.move(first, "blocked", "reconciler");
    await fx.tick();
    notice.stampSessionPause(session, "usage-limit");
    await fx.tick();
    fx.move(second, "blocked", "operator");

    const { stamp, notice: line } = notice.takeTurnPause(session, "go", "go", carried);

    expect(stamp).toEqual(carried);
    expect(line).toContain(`${first} moved executing → blocked (by reconciler)`);
    expect(line).toContain(`${second} moved executing → blocked (by operator)`);
    expect(line).toContain("(compaction)");
    expect(line).not.toContain("\n");
    expect(fx.stampOf(session)).toBeUndefined();
  });

  it("keeps the carried pause when the new one is the earlier", async () => {
    const session = fx.newSession();
    notice.stampSessionPause(session, "restart", new Date("2026-01-01T00:00:00.000Z"));
    const carried = { at: "2026-01-02T00:00:00.000Z", kind: "compaction" as const };
    expect(notice.takeTurnPause(session, "go", "go", carried).stamp).toEqual({ at: "2026-01-01T00:00:00.000Z", kind: "restart" });
  });

  it.each(["/compact", "  /compact keep the plan", "/init"])("neither carries nor consumes for the slash command %j", async (command) => {
    const session = fx.newSession();
    const todo = await fx.workedTodo(session);
    notice.stampSessionPause(session, "compaction");
    await fx.tick();
    fx.move(todo, "blocked", "reconciler");

    expect(notice.takeTurnPause(session, command, command)).toEqual({});
    expect(fx.stampOf(session)).toBeDefined();
    expect(notice.takeTurnPause(session, "carry on", "carry on").notice).toContain(todo);
    expect(fx.stampOf(session)).toBeUndefined();
  });

  it("leaves a stamp in place when the prompt that will run is a slash command", async () => {
    const session = fx.newSession();
    notice.stampSessionPause(session, "compaction");
    expect(notice.takeTurnPause(session, "go", "/compact")).toEqual({});
    expect(fx.stampOf(session)).toBeDefined();
  });
});

describe("withPauseNotice / withoutPauseNotice", () => {
  const LABEL = "[Gateway notice] While this session was paused (";
  const LINE = `${LABEL}compaction), TST-1 moved executing → blocked (by reconciler). If that is wrong, correct it with update_work_item; otherwise carry on.`;

  it("appends the line after the message, or stands alone for an empty one", () => {
    expect(notice.withPauseNotice("hello", LINE)).toBe(`hello\n\n${LINE}`);
    expect(notice.withPauseNotice("  ", LINE)).toBe(LINE);
    expect(notice.withPauseNotice("hello", undefined)).toBe("hello");
  });

  it.each(["/compact", "  /review 12"])("leaves the slash command %j alone", (command) => {
    expect(notice.withPauseNotice(command, LINE)).toBe(command);
  });

  it("takes the appended line back off a transcript prompt, and nothing else", () => {
    expect(notice.withoutPauseNotice(notice.withPauseNotice("hello\n\nthere", LINE))).toBe("hello\n\nthere");
    expect(notice.withoutPauseNotice(notice.withPauseNotice("", LINE))).toBe("");
    expect(notice.withoutPauseNotice("hello")).toBe("hello");
    const quoted = `the line reads ${LABEL}x) and so on`;
    expect(notice.withoutPauseNotice(quoted)).toBe(quoted);
    const trailing = `${LINE}\nand then more text`;
    expect(notice.withoutPauseNotice(trailing)).toBe(trailing);
  });
});
