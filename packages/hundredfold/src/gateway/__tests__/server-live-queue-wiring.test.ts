import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

/**
 * The owed-turn check (sessions/owed-turns.ts) reads the queue rows themselves
 * until the gateway registers its live queue, and the live queue afterwards.
 * server.ts owns both calls, so this boots the real `startGateway` in a throwaway
 * home and reads the check's answer for a row the live queue does not hold at
 * each point of the boot and at shutdown. The row is a connector session's: a
 * boot replay never re-dispatches it, so nothing but the live queue can say it
 * will not run.
 *
 * Dropping the registration, moving it before the replay, or dropping the
 * unregistration at shutdown each changes one of these answers.
 */

// paths.js reads HUNDREDFOLD_HOME once, so every gateway import is dynamic and comes after this.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-live-queue-wiring-"));
process.env.HUNDREDFOLD_HOME = tmpHome;

/** What the check answered for the probe row at the step the boot had reached. */
const owedAt: Record<string, boolean> = {};
let probeSessionId = "";
let probeOwed: () => boolean = () => {
  throw new Error("the probe is read before the gateway module graph is loaded");
};

// The two recovery steps the registration must follow. Each runs for real; the
// wrapper only reads the check's answer once it returns.
vi.mock("../api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.js")>();
  return {
    ...actual,
    resumePendingWebQueueItems: (...args: Parameters<typeof actual.resumePendingWebQueueItems>) => {
      actual.resumePendingWebQueueItems(...args);
      owedAt.afterQueueReplay = probeOwed();
    },
  };
});
vi.mock("../../sessions/restart-resume.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../sessions/restart-resume.js")>();
  return {
    ...actual,
    resumeRestartInterruptedSessions: (...args: Parameters<typeof actual.resumeRestartInterruptedSessions>) => {
      const result = actual.resumeRestartInterruptedSessions(...args);
      owedAt.afterRestartNudge = probeOwed();
      return result;
    },
  };
});

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

let cleanup: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const port = await freePort();
  fs.writeFileSync(
    path.join(tmpHome, "config.yaml"),
    yaml.dump({
      gateway: { port, host: "127.0.0.1" },
      engines: { default: "claude", claude: { bin: "claude", model: "sonnet" } },
      portal: { portalName: "Live queue wiring", setupComplete: true },
      connectors: {},
      mcp: {},
      sessions: {},
      logging: { level: "error", stdout: false },
    }),
  );

  const registry = await import("../../sessions/registry.js");
  const { gatewayOwesTurn } = await import("../../sessions/owed-turns.js");
  const { loadConfig } = await import("../../shared/config.js");

  // A connector session whose last turn failed and whose queue row is still pending.
  // Boot never replays it, and no live queue has it, so it is a row nothing will run.
  const session = registry.createSession({
    engine: "claude",
    source: "slack",
    sourceRef: "slack:live-queue-wiring-probe",
    prompt: "a turn nothing will run",
  });
  probeSessionId = session.id;
  registry.updateSession(session.id, { status: "error", attemptOutcome: "failed", lastError: "the turn ended badly" });
  registry.enqueueQueueItem(session.id, "slack:live-queue-wiring-probe", "a turn nothing will run");
  probeOwed = () => gatewayOwesTurn(probeSessionId);

  const { startGateway } = await import("../server.js");
  cleanup = await startGateway(loadConfig());
  owedAt.afterBoot = probeOwed();
}, 60_000);

afterAll(async () => {
  // Only reached with the gateway still up when a test failed before the shutdown test ran.
  await cleanup?.().catch(() => undefined);
  fs.rmSync(tmpHome, { recursive: true, force: true });
}, 30_000);

describe("the gateway registers the live queue for the owed-turn check", () => {
  it("reads the rows themselves while the boot replay still runs, so the replay is not undone by a block", () => {
    // Registering the queue before the replay would read the not-yet-dispatched rows as stranded.
    expect(owedAt.afterQueueReplay).toBe(true);
    expect(owedAt.afterRestartNudge).toBe(true);
  });

  it("registers the live queue once the boot has finished, so a row it does not hold is not an owed turn", () => {
    // Without the registration the row still counts: a Todo would stay `executing` behind it.
    expect(owedAt.afterBoot).toBe(false);
  });

  it("unregisters the live queue at shutdown", async () => {
    expect(probeOwed()).toBe(false);
    await cleanup!();
    cleanup = undefined;
    // Back to reading the rows themselves: a queue that is gone must not keep answering for them.
    expect(probeOwed()).toBe(true);
  }, 30_000);
});
