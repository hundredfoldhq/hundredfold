import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, afterAll } from "vitest";

/**
 * Live test of steering a running turn against a REAL Claude Code.
 *
 * Skipped unless CLAUDE_STEER_LIVE=1: it spends model tokens, needs a signed-in
 * `claude`, and takes about a minute. It is the check the fake-PTY suite cannot
 * make — that the real TUI queues a message pasted into a busy turn, folds it
 * in at the next tool boundary, and records that in the transcript the engine
 * reads. Run with:
 *
 *   CLAUDE_STEER_LIVE=1 CLAUDE_BIN=~/.local/bin/claude \
 *   CLAUDE_STEER_CONFIG_DIR=<the signed-in Claude config directory, e.g. ~/.claude> \
 *   CLAUDE_STEER_CWD=<a directory Claude Code already trusts> \
 *   [CLAUDE_STEER_MODEL=haiku] \
 *   pnpm exec vitest run src/engines/__tests__/claude-interactive-steer-live.test.ts
 *
 * The hooks reach a real HookRegistry through a small HTTP relay, as they reach
 * the gateway's in production. The suite replaces CLAUDE_CONFIG_DIR so no test
 * reaches real credentials; this one names the account on purpose.
 */
const LIVE = process.env.CLAUDE_STEER_LIVE === "1";
const BIN = process.env.CLAUDE_BIN ?? "claude";
const CWD = process.env.CLAUDE_STEER_CWD ?? process.cwd();
const MODEL = process.env.CLAUDE_STEER_MODEL ?? "haiku";
const CONFIG_DIR = process.env.CLAUDE_STEER_CONFIG_DIR;

const hoisted = vi.hoisted(() => ({ settingsPath: "" }));
vi.mock("../../shared/claude-settings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/claude-settings.js")>()),
  writeSessionSettings: () => hoisted.settingsPath,
}));

import { InteractiveClaudeEngine } from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { HookRegistry } from "../../gateway/hook-registry.js";
import { claudeProfileFromDir } from "../../shared/claude-profile.js";

const STEER = "STEER-MSG: also add the single word PINEAPPLE to your final answer.";
const SLEEP = 'node -e "setTimeout(()=>{},20000)"';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

/** One engine on a real claude, with its hooks relayed into a real HookRegistry. */
async function liveEngine(id: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-steer-live-"));
  dirs.push(dir);
  const registry = new HookRegistry(30_000, 5_000, 2_000);
  const hooks: Array<{ event: string; prompt?: string; last?: string }> = [];
  const unclaimed: string[] = [];
  registry.setUnclaimedHookHandler((_id, h) => { unclaimed.push(String(h.last_assistant_message ?? "")); });
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      try {
        const h = JSON.parse(body);
        hooks.push({ event: h.hook_event_name, prompt: h.prompt, last: h.last_assistant_message });
        registry.deliver(id, h);
      } catch { /* not a hook */ }
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const relay = path.join(dir, "relay.mjs");
  fs.writeFileSync(relay, [
    'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",d=>s+=d);',
    `process.stdin.on("end",()=>fetch("http://127.0.0.1:${port}/",{method:"POST",body:s}).catch(()=>{}).finally(()=>process.exit(0)));`,
  ].join(""));
  const cmd = { type: "command", command: `node ${relay}` };
  hoisted.settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(hoisted.settingsPath, JSON.stringify({
    hooks: Object.fromEntries(["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "PreToolUse", "PostToolUse", "Notification", "PostCompact"].map((e) => [e, [{ hooks: [cmd] }]])),
  }));
  const lifecycle = new PtyLifecycleManager({ maxLivePtys: 4 });
  const engine = new InteractiveClaudeEngine(lifecycle, registry);
  const runOpts = (prompt: string) => ({ sessionId: id, prompt, cwd: CWD, bin: BIN, model: MODEL, claudeProfile: claudeProfileFromDir(CONFIG_DIR!) }) as any;
  const until = async (done: () => boolean, ms: number) => {
    const deadline = Date.now() + ms;
    while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    return done();
  };
  return {
    engine, lifecycle, hooks, unclaimed, runOpts, until,
    close() { engine.killAll(); registry.dispose?.(); server.close(); },
  };
}

describe.skipIf(!LIVE || !CONFIG_DIR)("InteractiveClaudeEngine steering — real Claude Code", () => {
  it("an input handed to a running turn is answered within it: no kill, one turn", async () => {
    const id = "steer-live-fold";
    const live = await liveEngine(id);
    const { engine, lifecycle, hooks, unclaimed, until } = live;
    try {
      const turn = engine.run(live.runOpts(`Run exactly this Bash command: ${SLEEP}  Then run it a second time in a separate Bash call. Then reply with exactly: FIRST-DONE`));
      // Not steerable until the turn's own prompt is running.
      expect(engine.canSteer(id)).toBe(false);
      expect(await until(() => engine.canSteer(id), 60_000)).toBe(true);
      // Into the first tool call, so the turn is demonstrably mid-work.
      expect(await until(() => hooks.some((h) => h.event === "PreToolUse"), 60_000)).toBe(true);
      const ptyBefore = lifecycle.getWarm(id);
      expect(ptyBefore).toBeDefined();

      const steeredAt = Date.now();
      expect(await engine.steer(id, STEER)).toBe("steered");
      // Taken in at the tool boundary, while the turn is still running.
      expect(engine.isTurnRunning(id)).toBe(true);
      expect(Date.now() - steeredAt).toBeLessThan(45_000);

      const result = await turn;
      expect(result.error).toBeUndefined();
      // The model read it in the same turn: its one answer carries both.
      expect(result.result).toContain("FIRST-DONE");
      expect(result.result).toContain("PINEAPPLE");
      // Not cut off: the same process served the whole turn, and is still up.
      expect(lifecycle.getWarm(id)).toBe(ptyBefore);
      // One turn: one Stop, and nothing left over for the external-turn sync.
      expect(hooks.filter((h) => h.event === "Stop")).toHaveLength(1);
      await new Promise((r) => setTimeout(r, 3_000));
      expect(unclaimed).toEqual([]);
      expect(engine.holdsTurn(id)).toBe(false);
    } finally {
      live.close();
    }
  }, 240_000);

  it("a turn that ends before a tool boundary: the input runs as the next turn, and the session is held for it", async () => {
    const id = "steer-live-unfolded";
    const live = await liveEngine(id);
    const { engine, lifecycle, hooks, unclaimed, until } = live;
    try {
      // No tools: the turn never reaches a boundary to fold the input at.
      const turn = engine.run(live.runOpts("Write a 400-word essay about the history of lighthouses. Use no tools. Start immediately."));
      expect(await until(() => engine.canSteer(id), 60_000)).toBe(true);
      const ptyBefore = lifecycle.getWarm(id);

      let outcome: string | undefined;
      void engine.steer(id, "Reply with the single word PINEAPPLE.").then((o) => { outcome = o; });
      const result = await turn;
      expect(result.error).toBeUndefined();
      // The turn's own answer is the essay, not the steered input's.
      expect(result.result).not.toContain("PINEAPPLE");
      // Claude Code dequeues the input after the Stop; it cannot be taken back.
      expect(await until(() => outcome !== undefined, 10_000)).toBe(true);
      expect(outcome).toBe("steered");
      expect(lifecycle.getWarm(id)).toBe(ptyBefore);
      // It runs as a turn of its own, which the engine holds the session for
      // and whose answer reaches the external-turn sync.
      expect(engine.holdsTurn(id) || unclaimed.length > 0).toBe(true);
      expect(await until(() => unclaimed.length > 0, 60_000)).toBe(true);
      expect(unclaimed[0]).toContain("PINEAPPLE");
      expect(hooks.filter((h) => h.event === "Stop")).toHaveLength(2);
    } finally {
      live.close();
    }
  }, 240_000);
});
