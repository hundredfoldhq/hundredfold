import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-pause-restart-"));
process.env.HUNDREDFOLD_HOME = home;

vi.mock("../../shared/config.js", () => ({
  loadConfig: vi.fn(() => ({ gateway: {} })),
}));

type Registry = typeof import("../registry.js");
type RestartResume = typeof import("../restart-resume.js");
type Notice = typeof import("../pause-notice.js");
type Fixture = typeof import("./pause-notice-fixture.js");
let registry: Registry;
let restartResume: RestartResume;
let notice: Notice;
let fx: Fixture;
let db: import("better-sqlite3").Database;

beforeAll(async () => {
  registry = await import("../registry.js");
  restartResume = await import("../restart-resume.js");
  notice = await import("../pause-notice.js");
  fx = await import("./pause-notice-fixture.js");
  db = (await import("../../shared/db.js")).initDb();
});

beforeEach(() => {
  db.prepare("DELETE FROM sessions").run();
});

afterAll(() => {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const GATEWAY = { bootId: "boot0001", gatewayVersion: "0.31.0" };

function sessionIn(status: string, meta?: Record<string, never> | Record<string, unknown>): string {
  const id = fx.newSession(meta as never);
  db.prepare("UPDATE sessions SET status = ? WHERE id = ?").run(status, id);
  return id;
}

describe("the boot sweep (recoverStaleSessions)", () => {
  it("stamps a restart pause on every running and waiting session, in the same write as the resume mark", () => {
    const running = sessionIn("running");
    const waiting = sessionIn("waiting");
    const idle = sessionIn("idle");

    expect(registry.recoverStaleSessions()).toBe(2);

    for (const id of [running, waiting]) {
      expect(fx.stampOf(id)).toMatchObject({ kind: "restart" });
      expect(fx.metaOf(id)).toHaveProperty(registry.RESTART_RESUME_META_KEY);
    }
    expect(fx.metaOf(idle)).not.toHaveProperty("pausedAt");
  });

  it("keeps an earlier pause (a usage-limit wait the restart cut short) as it was", () => {
    const stamped = { at: "2026-01-01T00:00:00.000Z", kind: "usage-limit" };
    const waiting = sessionIn("waiting", { pausedAt: stamped, keep: "me" });

    registry.recoverStaleSessions();

    expect(fx.stampOf(waiting)).toEqual(stamped);
    expect(fx.metaOf(waiting)).toMatchObject({ keep: "me" });
  });

  it("tells the resumed session about a Todo the reconciler moved meanwhile", async () => {
    const id = sessionIn("running");
    const todo = await fx.workedTodo(id);
    await fx.tick();
    registry.recoverStaleSessions();
    await fx.tick();
    fx.move(todo, "blocked", "reconciler");

    expect(notice.takePauseNotice(id)).toContain(`While this session was paused (gateway restart), ${todo} moved executing → blocked (by reconciler)`);
  });
});

describe("the graceful shutdown sweep (interruptRunningSessionsForShutdown)", () => {
  it("stamps a restart pause on a session that was running, and not on one that was idle, waiting or errored", () => {
    const running = sessionIn("running");
    const others = ["idle", "waiting", "error"].map((status) => sessionIn(status));

    restartResume.interruptRunningSessionsForShutdown(GATEWAY);

    expect(fx.stampOf(running)).toMatchObject({ kind: "restart" });
    expect(fx.metaOf(running)).toHaveProperty(registry.RESTART_RESUME_META_KEY);
    for (const id of others) expect(fx.metaOf(id)).not.toHaveProperty("pausedAt");
  });

  it("keeps an earlier pause", () => {
    const stamped = { at: "2026-01-01T00:00:00.000Z", kind: "compaction" };
    const running = sessionIn("running", { pausedAt: stamped });

    restartResume.interruptRunningSessionsForShutdown(GATEWAY);

    expect(fx.stampOf(running)).toEqual(stamped);
  });

  it("does not stamp a restart-requesting session, which the restart notice nudge resumes", () => {
    const requester = sessionIn("running", { [registry.RESTART_ACK_META_KEY]: new Date().toISOString() });

    restartResume.interruptRunningSessionsForShutdown(GATEWAY);

    expect(fx.metaOf(requester)).not.toHaveProperty("pausedAt");
  });

  it("is not overwritten by the boot sweep that follows it", () => {
    const running = sessionIn("running");
    restartResume.interruptRunningSessionsForShutdown(GATEWAY);
    const first = fx.stampOf(running);

    registry.recoverStaleSessions();

    expect(fx.stampOf(running)).toEqual(first);
  });
});
