import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every place the gateway creates a session row, and which of them pick an account (docs/design/fallback-account-groups.md,
 * "Every way a session starts"). A new `createSession(` call fails here until it is listed: a start that runs an agent on Claude
 * goes through `pinAccountAtCreation` (directly, or through `validateNewSessionSelection` / `newSessionEngineSelection`),
 * and one that does not says why it never starts an agent on Claude.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Sites that start an agent session on Claude: each must route its account through the pin. */
const PINNED: Record<string, { calls: number; through: string[] }> = {
  "gateway/api.ts": { calls: 1, through: ["validateNewSessionSelection", "chargeAccountStart"] },
  "gateway/spawn-session.ts": { calls: 1, through: ["validateNewSessionSelection", "chargeAccountStart"] },
  "gateway/todo-employee-session.ts": { calls: 1, through: ["validateNewSessionSelection", "chargeAccountStart"] },
  "gateway/todo-dispatch.ts": { calls: 1, through: ["pinAccountAtCreation", "chargeAccountStart"] },
  "gateway/todo-capture-api.ts": { calls: 1, through: ["pinAccountAtCreation", "chargeAccountStart"] },
  "gateway/talk-turn-api.ts": { calls: 1, through: ["pinAccountAtCreation", "chargeAccountStart"] },
  "talk/control/delegation-adapter.ts": { calls: 1, through: ["pinAccountAtCreation", "chargeAccountStart"] },
  "sessions/manager.ts": { calls: 1, through: ["newSessionEngineSelection", "chargeAccountStart"] },
};

/** Sites that never start an agent on Claude, and why. */
const EXEMPT: Record<string, { calls: number; reason: string }> = {
  "sessions/registry.ts": { calls: 1, reason: "the definition of createSession itself" },
  "gateway/talk-api.ts": { calls: 1, reason: "a row for a realtime voice session on the realtime provider: it runs no Claude agent, the row only carries spend" },
  "gateway/terminal-api.ts": { calls: 1, reason: "a terminal on a host: a shell, not an agent session" },
  "gateway/remote-mcp/principal.ts": { calls: 1, reason: "the anchor a connector's tool calls run as: it never runs an engine" },
};

/** `createSession(` calls on the registry function: not a method (`this.createSession(`), not a declaration of one (`async createSession(`, `function createSession(`). */
function callsOf(source: string): number {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return [...code.matchAll(/(?<![.\w])createSession\(/g)].filter((match) => !/(?:async|function)\s+$/.test(code.slice(0, match.index))).length
    + [...code.matchAll(/function createSession\(/g)].length;
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" || entry.name === "node_modules" ? [] : sourceFiles(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

describe("createSession call sites", () => {
  const found = new Map(sourceFiles(SRC).map((file) => [path.relative(SRC, file).split(path.sep).join("/"), callsOf(fs.readFileSync(file, "utf8"))] as const).filter(([, calls]) => calls > 0));

  it("are all listed, with the number of calls each makes", () => {
    const listed = new Map([...Object.entries(PINNED).map(([file, site]) => [file, site.calls] as const), ...Object.entries(EXEMPT).map(([file, site]) => [file, site.calls] as const)]);
    expect([...found.entries()].sort()).toEqual([...listed.entries()].sort());
  });

  it.each(Object.entries(PINNED))("%s routes its account through the pin", (file, site) => {
    const source = fs.readFileSync(path.join(SRC, file), "utf8");
    for (const name of site.through) expect(source, `${file} must use ${name}`).toContain(name);
  });

  it("gives every exempt site a reason", () => {
    for (const [file, site] of Object.entries(EXEMPT)) expect(site.reason.length, file).toBeGreaterThan(10);
  });
});
