import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CronJob, HundredfoldConfig } from "../../shared/types.js";

/**
 * A cron fire is a root: nobody signed in started it, so its session carries no account, and the
 * parent-to-child inheritance that attributes a person's tree never reaches it.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-cron-root-"));
process.env.HUNDREDFOLD_HOME = tmp;

vi.mock("../jobs.js", () => ({ appendRunLog: vi.fn() }));
vi.mock("../../gateway/org-registry.js", () => ({ orgRegistry: vi.fn(() => new Map()) }));
vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const job: CronJob = { id: "root-job", name: "Root Job", enabled: true, schedule: "0 * * * *", prompt: "do something" };
const config = {
  engines: { default: "claude", claude: { model: "sonnet" } },
  logging: { file: false, stdout: false, level: "info" },
} as unknown as HundredfoldConfig;

beforeAll(async () => {
  (await import("../../shared/db.js")).initDb();
});

afterAll(async () => {
  (await import("../../shared/db.js")).__closeDbForTest();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("runCronJob — the session it starts is unattributed", () => {
  it("stores no user_id on the cron root", async () => {
    const { runCronJob } = await import("../runner.js");
    const { SessionManager } = await import("../../sessions/manager.js");
    const { beginSessionAttempt, listSessions } = await import("../../sessions/registry.js");
    const manager = new SessionManager(config, new Map(), "boot");
    vi.spyOn(manager as unknown as { runSession: (session: { id: string }) => Promise<void> }, "runSession")
      .mockImplementation(async (session) => { beginSessionAttempt(session.id); });

    await runCronJob(job, manager, config, new Map());

    const roots = listSessions().filter((session) => session.source === "cron");
    expect(roots).toHaveLength(1);
    expect(roots[0]!.parentSessionId).toBeNull();
    expect(roots[0]!.userId).toBeNull();
  });
});
