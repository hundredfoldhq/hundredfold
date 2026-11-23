import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Employee, HundredfoldConfig } from "../../shared/types.js";

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));

/** The board walk previews an opencode Todo's start on the account the balancer would pick for it. */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-walk-opencode-"));
process.env.HUNDREDFOLD_HOME = home;

const m = {} as {
  accounts: typeof import("../accounts.js");
  store: typeof import("../../work-items/store.js");
  dispatch: typeof import("../../work-items/dispatch-config.js");
};
const NOW = Date.parse("2026-10-06T12:00:00Z");
const roster: Record<string, Employee> = {
  op: { name: "op", engine: "claude", model: "opus" } as Employee,
  coder: { name: "coder", engine: "codex" } as Employee,
};

beforeAll(async () => {
  m.accounts = await import("../accounts.js");
  m.store = await import("../../work-items/store.js");
  m.dispatch = await import("../../work-items/dispatch-config.js");
});
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

describe("an opencode assignee whose chain opens with a group of accounts", () => {
  const ocConfig = {
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "opus" },
      opencode: {
        bin: "opencode", model: "opencode-go/glm-5",
        fallback: [{ group: [{ engine: "opencode", profile: "go-a" }, { engine: "opencode", profile: "go-b" }] }],
        accounts: { "go-a": { provider: "opencode-go" }, "go-b": { provider: "opencode-go-b", base: "opencode-go", keyEnv: "OPENCODE_GO_B_API_KEY" } },
      },
    },
    models: {
      claude: { default: "opus", models: [{ id: "opus" }] },
      opencode: { default: "opencode-go/glm-5", models: ["opencode-go/glm-5", "opencode-go-b/glm-5"].map((id) => ({ id })) },
    },
  } as unknown as HundredfoldConfig;
  const A = "opencode/opencode-go";
  const B = "opencode/opencode-go-b";
  const limitsDir = path.join(home, "tmp", "engine-limits");
  const ocRoster: Record<string, Employee> = {
    ...roster,
    "oc-dev": { name: "oc-dev", engine: "opencode", model: "opencode-go/glm-5" } as Employee,
  };

  /** `used` percent in each account's 5h window, read fresh at NOW. */
  function writeUsage(used: Record<string, number>): void {
    fs.rmSync(limitsDir, { recursive: true, force: true });
    fs.mkdirSync(limitsDir, { recursive: true });
    for (const [account, percent] of Object.entries(used)) {
      fs.writeFileSync(path.join(limitsDir, `opencode-usage-history.${encodeURIComponent(account)}.json`), JSON.stringify([{ at: NOW - 60_000, windows: [{ name: "5h", usedPercent: percent, resetsAt: Math.floor((NOW + 3 * 3600_000) / 1000) }] }]));
    }
  }
  const view = () => m.accounts.walkAccounts({ config: ocConfig, now: NOW, health: {}, employee: (name) => ocRoster[name] });
  const todo = (assignee: string, dispatch?: { engine: string; model?: string }) => {
    const item = m.store.createWorkItem({ title: `oc-${assignee}`, status: "backlog", source: "human", assignee });
    if (dispatch) m.dispatch.setTodoDispatchConfig(item.id, dispatch, ocConfig);
    return { id: item.id, assignee };
  };

  it("previews the pick for an opencode Todo, and for a Claude employee's Todo that names opencode", async () => {
    // B has the headroom, so the balancer would send a start there.
    writeUsage({ [A]: 90, [B]: 10 });
    const { resetAccountCredits } = await import("../../shared/fallback-account-pick.js");
    resetAccountCredits();
    expect(view().of(todo("oc-dev"))).toBe(B);
    expect(view().of(todo("oc-dev", { engine: "opencode" }))).toBe(B);
    // A dispatch override naming opencode on a Claude employee runs on the engine's own model and chain.
    expect(view().of(todo("op", { engine: "opencode" }))).toBe(B);
    resetAccountCredits();
  });

  it("leaves a Claude Todo on its own account", () => {
    writeUsage({ [A]: 90, [B]: 10 });
    expect(view().of(todo("op"))).toBe("claude");
    expect(view().of(todo("coder"))).toBe("codex");
  });
});
