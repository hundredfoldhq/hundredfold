import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, afterAll } from "vitest";

/**
 * Live test of soft-interrupting a running turn against a REAL Claude Code.
 *
 * Skipped unless CLAUDE_STEER_LIVE=1: it spends model tokens, needs a signed-in `claude`, and takes
 * a couple of minutes. It is the check the fake-PTY suite cannot make, and the one that decides how
 * softInterrupt works (recorded on Claude Code 2.1.330):
 *
 * - Esc alone SIGTERMs a foreground Bash, so softInterrupt presses Ctrl+B first, which moves the
 *   command to a background task; Esc then ends the turn and the command runs on.
 * - A `<task-notification>` wakes the session when the command ends.
 * - Esc before the model has produced anything puts the prompt back in the composer; softInterrupt
 *   empties it, so the next turn is not prefixed with the interrupted prompt.
 *
 * Run with the same environment as the steering live test:
 *
 *   CLAUDE_STEER_LIVE=1 CLAUDE_BIN=~/.local/bin/claude \
 *   CLAUDE_STEER_CONFIG_DIR=<the signed-in Claude config directory, e.g. ~/.claude> \
 *   CLAUDE_STEER_CWD=<a directory Claude Code already trusts> \
 *   [CLAUDE_STEER_MODEL=haiku] \
 *   pnpm exec vitest run src/engines/__tests__/claude-interactive-soft-interrupt-live.test.ts
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
    hooks: Object.fromEntries(["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Notification", "PostCompact"].map((e) => [e, [{ hooks: [cmd] }]])),
  }));
  const lifecycle = new PtyLifecycleManager({ maxLivePtys: 4 });
  const engine = new InteractiveClaudeEngine(lifecycle, registry);
  const runOpts = (prompt: string, extra: Record<string, unknown> = {}) => ({ sessionId: id, prompt, cwd: CWD, bin: BIN, model: MODEL, claudeProfile: claudeProfileFromDir(CONFIG_DIR!), ...extra }) as any;
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

/** A foreground command that outlives the soft interrupt, and says when it ran to its end. */
const longCommand = (marker: string) =>
  `node -e "setTimeout(()=>require('fs').writeFileSync('${marker}','finished'),25000)"`;

describe.skipIf(!LIVE || !CONFIG_DIR)("InteractiveClaudeEngine soft interrupt — real Claude Code", () => {
  it("a running Bash is moved to the background and survives; its notification wakes the session; the process stays", async () => {
    const id = "soft-live-bash";
    const live = await liveEngine(id);
    const { engine, lifecycle, hooks, unclaimed, until } = live;
    const marker = path.join(dirs[dirs.length - 1]!, "marker.txt");
    try {
      const turn = engine.run(live.runOpts(`Run exactly this Bash command in the foreground, with no run_in_background: ${longCommand(marker)}  Then reply with exactly: LONG-DONE`));
      expect(await until(() => hooks.some((h) => h.event === "PreToolUse"), 60_000)).toBe(true);
      expect(await until(() => engine.foregroundWork(id) !== null, 10_000)).toBe(true);
      expect(engine.foregroundWork(id)).toMatchObject({ tool: "Bash" });
      const ptyBefore = lifecycle.getWarm(id);
      expect(ptyBefore).toBeDefined();

      const outcome = await engine.softInterrupt(id, "voice barge-in");
      expect(outcome.ended).toBe(true);
      if (!outcome.ended) return;
      // The task id came from the hook stream, not from the notification that follows.
      expect(outcome.backgrounded).toHaveLength(1);
      expect(outcome.backgrounded[0]!.taskId).toMatch(/\w+/);
      expect(engine.backgroundTasks(id).tasks.map((t) => t.id)).toContain(outcome.backgrounded[0]!.taskId);

      const result = await turn;
      expect(result.error).toBe("Interrupted: voice barge-in");
      // Never released: the process is the same and the command was not killed with it.
      expect(lifecycle.getWarm(id)).toBe(ptyBefore);
      expect(engine.holdsTurn(id)).toBe(false);

      // The command ran to its end, and Claude Code woke itself with a task notification.
      expect(await until(() => fs.existsSync(marker), 60_000)).toBe(true);
      expect(await until(() => hooks.some((h) => h.event === "UserPromptSubmit" && (h.prompt ?? "").includes("<task-notification>")), 60_000)).toBe(true);
      expect(await until(() => unclaimed.length > 0, 60_000)).toBe(true);
      expect(lifecycle.getWarm(id)).toBe(ptyBefore);
    } finally {
      live.close();
    }
  }, 300_000);

  it("a tool that failed is no longer foreground work: a Bash after a failed Read is backgroundable", async () => {
    const id = "soft-live-failed";
    const live = await liveEngine(id);
    const { engine, hooks, until } = live;
    const marker = path.join(dirs[dirs.length - 1]!, "marker.txt");
    try {
      const turn = engine.run(live.runOpts(`First use the Read tool on /nonexistent/missing-file.txt (it is expected to fail). Then run exactly this Bash command in the foreground, with no run_in_background: ${longCommand(marker)}  Then reply with exactly: LONG-DONE`));
      // A failed call fires PostToolUseFailure and no PostToolUse.
      expect(await until(() => hooks.some((h) => h.event === "PostToolUseFailure"), 60_000)).toBe(true);
      expect(await until(() => engine.foregroundWork(id)?.tool === "Bash", 60_000)).toBe(true);
      // Were the failed Read still counted, an interrupt would be taken to abort it.
      expect(engine.foregroundWork(id)).toMatchObject({ tool: "Bash", backgroundable: true });
      const result = await turn;
      expect(result.error).toBeUndefined();
      expect(engine.foregroundWork(id)).toBeNull();
    } finally {
      live.close();
    }
  }, 240_000);

  it("an interrupted prompt Esc put back in the composer does not prefix the next turn", async () => {
    const id = "soft-live-composer";
    const live = await liveEngine(id);
    const { engine, lifecycle, hooks, until } = live;
    try {
      const turn = engine.run(live.runOpts("Write a 600-word essay about the history of lighthouses. Use no tools. Start immediately."));
      expect(await until(() => hooks.some((h) => h.event === "UserPromptSubmit"), 60_000)).toBe(true);
      const ptyBefore = lifecycle.getWarm(id);
      // Before the model has produced anything: the case where Esc restores the prompt.
      const outcome = await engine.softInterrupt(id, "voice barge-in");
      expect(outcome).toEqual({ ended: true, backgrounded: [] });
      const interrupted = await turn;
      expect(interrupted.error).toBe("Interrupted: voice barge-in");
      expect(lifecycle.getWarm(id)).toBe(ptyBefore);

      const next = await engine.run(live.runOpts("Reply with exactly the word MANGO", { resumeSessionId: interrupted.sessionId }));
      expect(next.error).toBeUndefined();
      expect(next.result).toContain("MANGO");
      const submitted = hooks.filter((h) => h.event === "UserPromptSubmit").map((h) => h.prompt ?? "");
      expect(submitted[submitted.length - 1]).toBe("Reply with exactly the word MANGO");
      expect(lifecycle.getWarm(id)).toBe(ptyBefore);
    } finally {
      live.close();
    }
  }, 240_000);
});
