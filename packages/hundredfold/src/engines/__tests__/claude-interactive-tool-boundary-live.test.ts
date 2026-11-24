import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

/**
 * Live test of cutting a running turn between two tool calls (interruptAtToolBoundary) against a
 * REAL Claude Code. Skipped unless CLAUDE_STEER_LIVE=1: it spends model tokens, needs a signed-in
 * `claude`, and takes a couple of minutes. Run it with the environment of the soft-interrupt live test:
 *
 *   CLAUDE_STEER_LIVE=1 CLAUDE_BIN=~/.local/bin/claude \
 *   CLAUDE_STEER_CONFIG_DIR=<the signed-in Claude config directory> \
 *   CLAUDE_STEER_CWD=<a directory Claude Code already trusts> \
 *   [CLAUDE_STEER_MODEL=haiku] \
 *   pnpm exec vitest run src/engines/__tests__/claude-interactive-tool-boundary-live.test.ts
 *
 * What it checks that the fake-PTY suite cannot: Esc pressed the moment a foreground command's
 * PostToolUse arrives ends the turn without losing the command's result or its follow-on, leaves
 * the process and the background work a call started, and the same session then takes the next
 * message as a clean turn.
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
import { isolateLiveClaudeEnv } from "./live-claude-env.js";

const dirs: string[] = [];
// The real claude gets its own HOME and no auto-updater (see live-claude-env.ts), and the host's launcher link is checked after.
let liveEnv: ReturnType<typeof isolateLiveClaudeEnv> | undefined;
beforeAll(() => { if (LIVE) liveEnv = isolateLiveClaudeEnv(); });
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  liveEnv?.restore();
});

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


const sleepCommand = (log: string, i: number, seconds: number) =>
  `echo start-${i} >> ${log}; sleep ${seconds}; echo done-${i} >> ${log}; echo ZEBRA-${i}`;

describe.skipIf(!LIVE || !CONFIG_DIR)("InteractiveClaudeEngine interrupt at a tool boundary — real Claude Code", () => {
  it("waits for a running foreground command, cuts the turn when it ends, and the session resumes with the command's result", async () => {
    const id = "boundary-live-chain";
    const live = await liveEngine(id);
    const { engine, lifecycle, hooks, until } = live;
    const log = path.join(dirs[dirs.length - 1]!, "chain.log");
    const read = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
    try {
      const turn = engine.run(live.runOpts(
        `Run these three Bash commands one after another, each in the foreground (no run_in_background), starting the next only after the previous one has finished:\n1. ${sleepCommand(log, 1, 8)}\n2. ${sleepCommand(log, 2, 8)}\n3. ${sleepCommand(log, 3, 8)}\nThen reply with exactly: CHAIN-DONE`,
      ));
      expect(await until(() => read().includes("start-1"), 90_000)).toBe(true);
      const ptyBefore = lifecycle.getWarm(id);
      const asked = Date.now();
      const first = await engine.interruptAtToolBoundary(id, "Interrupted: new message received", { waitMs: 2_000 });
      // Command 1 is still running: the answer is "waiting", and nothing has been pressed.
      expect(first).toBe("waiting");
      expect(read()).toEqual(["start-1"]);
      const result = await turn;
      expect(result.error).toBe("Interrupted: new message received");
      // Cut the moment command 1 ended, before the model could start command 2, and never inside a command.
      expect(read()).toEqual(["start-1", "done-1"]);
      expect(Date.now() - asked).toBeLessThan(8_000 + 6_000);
      // The turn is over within a few seconds of the command's end (the log's last write).
      const settledAfter = Date.now() - fs.statSync(log).mtimeMs;
      console.log(`turn settled ${settledAfter} ms after the command ended`);
      expect(settledAfter).toBeLessThan(5_000);
      expect(lifecycle.getWarm(id)).toBe(ptyBefore);
      expect(engine.holdsTurn(id)).toBe(false);

      // The same session resumes: the result of the command it had run is still in its context, and the
      // prompt Esc put back in the composer (if any) was cleared, so the next prompt is exactly what was sent.
      const next = await engine.run(live.runOpts("What did the Bash command you ran print on its last line? Answer with that one word only.", { resumeSessionId: result.sessionId }));
      expect(next.error).toBeUndefined();
      expect(next.result).toContain("ZEBRA-1");
      const submitted = hooks.filter((h) => h.event === "UserPromptSubmit").map((h) => h.prompt ?? "");
      expect(submitted[submitted.length - 1]).toBe("What did the Bash command you ran print on its last line? Answer with that one word only.");
      expect(read()).toEqual(["start-1", "done-1"]);
      expect(lifecycle.getWarm(id)).toBe(ptyBefore);
    } finally {
      live.close();
    }
  }, 300_000);

  it("leaves a background command running through the cut, and its notification wakes the session", async () => {
    const id = "boundary-live-background";
    const live = await liveEngine(id);
    const { engine, lifecycle, hooks, until } = live;
    const dir = dirs[dirs.length - 1]!;
    const marker = path.join(dir, "background.txt");
    const log = path.join(dir, "fg.log");
    try {
      const turn = engine.run(live.runOpts(
        `First run this Bash command with run_in_background set to true: sleep 20; echo finished > ${marker}\nThen run this Bash command in the foreground: ${sleepCommand(log, 1, 6)}\nThen run this one in the foreground: ${sleepCommand(log, 2, 6)}\nThen reply with exactly: BG-DONE`,
      ));
      expect(await until(() => fs.existsSync(log), 90_000)).toBe(true);
      const ptyBefore = lifecycle.getWarm(id);
      // The background command is no call in flight, the foreground one is: waits for it, then cuts.
      expect(await engine.interruptAtToolBoundary(id, "Interrupted: new message received", { waitMs: 1_000 })).toBe("waiting");
      const result = await turn;
      expect(result.error).toBe("Interrupted: new message received");
      expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual(["start-1", "done-1"]);
      expect(lifecycle.getWarm(id)).toBe(ptyBefore);
      // The background command was not touched by the cut, and woke the session when it ended.
      expect(await until(() => fs.existsSync(marker), 60_000)).toBe(true);
      expect(await until(() => hooks.some((h) => h.event === "UserPromptSubmit" && (h.prompt ?? "").includes("<task-notification>")), 60_000)).toBe(true);
      expect(lifecycle.getWarm(id)).toBe(ptyBefore);
    } finally {
      live.close();
    }
  }, 300_000);
});
