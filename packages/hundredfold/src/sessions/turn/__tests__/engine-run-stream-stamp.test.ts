import { describe, expect, it, vi } from "vitest";
import type { HundredfoldConfig, Session, StreamDelta } from "../../../shared/types.js";
import type { TurnInput, TurnPlan } from "../types.js";

// The registry DB is resolved from HUNDREDFOLD_HOME when the module loads, which is before the imports below run.
vi.hoisted(() => {
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  process.env.HUNDREDFOLD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-stream-stamp-"));
});

vi.mock("../../../shared/logger.js", () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../claude-auth-watch.js", () => ({ refuseClaudeLaunch: vi.fn(() => undefined) }));
vi.mock("../../../gateway/budgets.js", () => ({ isBudgetExhausted: vi.fn(() => false) }));
vi.mock("../../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../shared/models.js")>()),
  engineAvailable: vi.fn(() => true),
  effortLevelsForModel: vi.fn(() => []),
}));
vi.mock("../../engine-run-mcp.js", () => ({
  resolveEngineRunMcp: vi.fn(() => ({ mcpConfigPath: undefined, resolvedMcp: { mcpServers: { hundredfold: {} } } })),
}));

import { initDb } from "../../../shared/db.js";
import { createSession, updateSession } from "../../registry.js";
import { createPartialStreamWriter, getLiveStreamBlock } from "../../partial-stream.js";
import { preflightTurn } from "../preflight.js";
import { runEngineAttempt } from "../engine-run.js";

initDb();

function turnFor(session: Session): TurnInput {
  const config = { engines: { default: "claude", claude: {}, codex: {}, opencode: { mode: "server" } } } as unknown as HundredfoldConfig;
  return {
    session, attemptToken: "stamp-turn", prompt: "q", attachments: [], config,
    engines: new Map(["claude", "opencode", "codex"].map((e) => [e, {} as never])), gatewayBootId: "boot",
    connectorNames: [], channel: "web", user: "operator",
  } as TurnInput;
}

describe("a turn's stream as the live view receives it", () => {
  it("carries each delta out once, stamped by the writer, while a read can see the block", async () => {
    const created = createSession({ engine: "claude", source: "web", sourceRef: "web:stamp", prompt: "q" });
    updateSession(created.id, { status: "running", attemptToken: "stamp-turn" });
    const session = { ...created, status: "running", attemptToken: "stamp-turn" } as Session;
    const turn = turnFor(session);
    const planned = preflightTurn(turn) as TurnPlan;
    expect(planned.ok).toBe(true);

    const sent: StreamDelta[] = [];
    let duringRun: ReturnType<typeof getLiveStreamBlock> = null;
    const plan: TurnPlan = {
      ...planned,
      engine: {
        name: "claude",
        run: async (opts: { onStream?: (delta: StreamDelta) => void }) => {
          opts.onStream?.({ type: "text", content: "Let me " });
          opts.onStream?.({ type: "text", content: "look." });
          duringRun = getLiveStreamBlock(created.id, "stamp-turn");
          opts.onStream?.({ type: "tool_use", content: "", toolName: "Read" });
          opts.onStream?.({ type: "text", content: "Found it." });
          return { result: "Found it.", sessionId: "x" };
        },
      } as never,
      prepareContext: () => ({ fingerprint: "f", refresh: undefined, systemPrompt: "SYSTEM" }),
    };
    await runEngineAttempt({
      input: turn, plan, model: undefined, turnStartedAt: Date.now(),
      surface: { delta: (delta: StreamDelta) => { sent.push(delta); } } as never,
      heartbeat: { beat: vi.fn(), stop: vi.fn() } as never,
      partialStream: createPartialStreamWriter(created.id, "stamp-turn"),
    });

    expect(sent.map((d) => d.type)).toEqual(["text", "text", "tool_use", "text"]);
    const [first, second, tool, next] = sent;
    expect(first).toMatchObject({ offset: 0 });
    expect(second).toMatchObject({ streamBlock: first.streamBlock, offset: "Let me ".length });
    expect(tool.streamBlock).toBe(first.streamBlock);
    expect(next.streamBlock).toBeGreaterThan(first.streamBlock!);
    expect(next.offset).toBe(0);
    expect(duringRun).toMatchObject({ block: first.streamBlock, text: "Let me look." });
    // The run is over: no block is reported as streaming.
    expect(getLiveStreamBlock(created.id, "stamp-turn")).toBeNull();
  });
});
