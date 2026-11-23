import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Where a remote session's profile directory is worked out (docs/design/fallback-account-groups.md, section 11).
 *
 * A remote employee's session may be pinned to another account on its host than its employee's own login, so the directory
 * a launch runs under is the session's (`sessionRemoteTarget`, `withStandingRemoteAccount`), never the employee's alone.
 * `resolveRemoteClaudeConfigDir` answers for ONE target: the employee's, or one a chokepoint built. A new caller fails here
 * until it is listed with the reason it may ask, so a session path cannot quietly launch under its employee's directory.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Every file that may call `resolveRemoteClaudeConfigDir`, how many times, and why the answer is the right directory there. */
const ALLOWED: Record<string, { calls: number; reason: string }> = {
  "cli/remote.ts": { calls: 1, reason: "the operator's `remote` command reports an employee's own profile on its host, no session involved" },
  "engines/claude-interactive.ts": { calls: 3, reason: "the engine launches on the target the turn gives it: `sessionRemoteTarget`'s, which already holds the session's directory" },
  "engines/remote-stage.ts": { calls: 4, reason: "staging, the folder-trust seed and the department sync act on the target the engine was handed, the session's own" },
  "sessions/fallback-reroute.ts": { calls: 1, reason: "a creation reroute onto the employee's own login (the session may be pinned to another account): the directory of that login, by design the employee's" },
  "sessions/substitute-launch.ts": { calls: 2, reason: "a swap onto the session's own login reads a target built with the session's pin and no override; a swap onto the employee's login reads the employee's" },
  "shared/employee-fallback.ts": { calls: 1, reason: "the roster loader keys an employee's own login, which is no session's" },
  "shared/engine-account.ts": { calls: 1, reason: "`remoteAccountForTarget` keys the account of the target it is given" },
  "shared/engine-limits-accounts.ts": { calls: 1, reason: "the Limits roster keys each employee's own login, which is no session's" },
};

/** The directory of the declaration itself, which is no caller. */
const DEFINITION = "shared/remote-target.ts";

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" || entry.name === "node_modules" ? [] : sourceFiles(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

/** `resolveRemoteClaudeConfigDir(` calls, not the declaration and not a comment. */
function callsOf(source: string): number {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return [...code.matchAll(/(?<![.\w])resolveRemoteClaudeConfigDir\(/g)].filter((match) => !/function\s+$/.test(code.slice(0, match.index))).length;
}

describe("resolveRemoteClaudeConfigDir callers", () => {
  const found = new Map(
    sourceFiles(SRC)
      .map((file) => [path.relative(SRC, file).split(path.sep).join("/"), callsOf(fs.readFileSync(file, "utf8"))] as const)
      .filter(([file, calls]) => calls > 0 && file !== DEFINITION),
  );

  it("are all listed, with the number of calls each makes", () => {
    const listed = new Map(Object.entries(ALLOWED).map(([file, site]) => [file, site.calls] as const));
    expect([...found.entries()].sort()).toEqual([...listed.entries()].sort());
  });

  it("each have a reason", () => {
    for (const [file, site] of Object.entries(ALLOWED)) expect(site.reason.length, file).toBeGreaterThan(20);
  });
});
