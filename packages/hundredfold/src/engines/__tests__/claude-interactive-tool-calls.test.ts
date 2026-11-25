import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

/**
 * Every tool call a claude session makes is recorded as a `tool_call` row.
 *
 * The SSE proxy reports a call as it streams, but it only tees the main
 * agent's stream, and a remote session has no proxy at all. Those calls are
 * reported by their PreToolUse hooks instead (a sub-agent's carry `agent_id`;
 * verified on Claude Code 2.1.286), and a main-agent call that both report is
 * recorded once.
 *
 * Deltas go through the real partial-stream writer and settlement into a
 * throwaway registry, so the assertions are on the rows themselves.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-claude-tool-calls-"));
process.env.HUNDREDFOLD_HOME = home;

const REMOTE_STAGE = "/mnt/hundredfold-home/.hundredfold-remote-stage";

const hoisted = vi.hoisted(() => ({
  ptys: [] as Array<{ bin: string }>,
  /** The per-PTY SSE proxy's event sink, captured so a test can stream model output. */
  sseSinks: [] as Array<(e: unknown) => void>,
}));

vi.mock("node-pty", () => ({
  spawn: vi.fn((bin: string) => {
    hoisted.ptys.push({ bin });
    return {
      pid: 5000 + hoisted.ptys.length,
      _exitCode: null,
      onData() { return { dispose() {} }; },
      onExit() {},
      kill() {},
      write() {},
      resize() {},
      on() {},
    };
  }),
}));
vi.mock("../sse-pty-proxy.js", () => ({
  MAIN_AGENT_SENTINEL: "<!-- hundredfold-main-agent:5c1f -->",
  SsePtyProxy: class {
    port = 0;
    constructor(_label: string, onEvent: (e: unknown) => void) { hoisted.sseSinks.push(onEvent); }
    async start() { return 41500; }
    stop() {}
  },
}));
vi.mock("../remote-stage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../remote-stage.js")>();
  return {
    ...actual,
    ensureRemoteReady: vi.fn(async () => ({
      ready: true,
      facts: {
        home: "/home/builder",
        stageDir: REMOTE_STAGE,
        nodeBin: "/usr/bin/node",
        claudeBin: "/usr/local/bin/claude",
        hundredfoldVersion: "0.32.0",
        entryDir: "/usr/lib/hundredfold/src/mcp",
      },
    })),
    prepareRemoteSession: vi.fn(async () => ({
      destination: "builder@build-box",
      tunnelPort: 44321,
      sessionHome: `${REMOTE_STAGE}/sessions/remote`,
      settingsPath: `${REMOTE_STAGE}/sessions/remote/tmp/settings.json`,
      envFilePath: `${REMOTE_STAGE}/sessions/remote/tmp/session-env.sh`,
    })),
  };
});

import { InteractiveClaudeEngine } from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { HookRegistry, type HookPayload } from "../../gateway/hook-registry.js";
import type { StreamDelta } from "../../shared/types.js";

type Registry = typeof import("../../sessions/registry.js");
type PartialStream = typeof import("../../sessions/partial-stream.js");
type StreamedBlocks = typeof import("../../gateway/streamed-blocks.js");
let tools: typeof import("../../sessions/tool-details.js");
let registry: Registry;
let partialStream: PartialStream;
let streamedBlocks: StreamedBlocks;

beforeAll(async () => {
  registry = await import("../../sessions/registry.js");
  partialStream = await import("../../sessions/partial-stream.js");
  streamedBlocks = await import("../../gateway/streamed-blocks.js");
  tools = await import("../../sessions/tool-details.js");
});

const REMOTE_TARGET = { remoteHost: "build-box", remoteUser: "builder", remoteCwd: "/srv/work/proj" };

const preTool = (name: string, id: string, agentId?: string): HookPayload => ({
  hook_event_name: "PreToolUse",
  tool_name: name,
  tool_use_id: id,
  tool_input: {},
  ...(agentId ? { agent_id: agentId, agent_type: "general-purpose" } : {}),
});
const postTool = (name: string, id: string, agentId?: string): HookPayload => ({
  hook_event_name: "PostToolUse",
  tool_name: name,
  tool_use_id: id,
  tool_input: {},
  tool_response: { stdout: "ok" },
  ...(agentId ? { agent_id: agentId, agent_type: "general-purpose" } : {}),
});
const sseToolStart = (name: string, id: string) => ({
  type: "content_block_start",
  content_block: { type: "tool_use", id, name },
});

interface ToolRow { tool_call: string; tool_id: string | null; content: string; partial: number | null; meta: string | null }

describe("InteractiveClaudeEngine — tool calls reach the registry", () => {
  let hooks: HookRegistry;
  let engine: InteractiveClaudeEngine;
  let lifecycle: PtyLifecycleManager;

  beforeEach(() => {
    vi.useFakeTimers();
    hoisted.ptys.length = 0;
    hoisted.sseSinks.length = 0;
    hooks = new HookRegistry();
    lifecycle = new PtyLifecycleManager({ maxLivePtys: 4 });
    engine = new InteractiveClaudeEngine(lifecycle, hooks, {
      remote: () => ({ root: "/srv/work", mount: "/mnt/hundredfold-home" }),
      gatewayPort: () => 8722,
    });
  });
  afterEach(() => {
    lifecycle.killAll();
    hooks.dispose();
    vi.useRealTimers();
  });

  /** Start a turn whose deltas are persisted exactly as the turn runner does. */
  async function startTurn(sid: string, target: Record<string, unknown> = {}) {
    const writer = partialStream.createPartialStreamWriter(sid);
    const deltas: StreamDelta[] = [];
    const turn = engine.run({
      sessionId: sid,
      prompt: "go",
      cwd: "/tmp",
      ...target,
      onStream: (d: StreamDelta) => { deltas.push(d); writer.persist(d); },
    } as any);
    await vi.advanceTimersByTimeAsync(20);
    hooks.deliver(sid, { hook_event_name: "SessionStart", session_id: `claude-${sid}` });
    hooks.deliver(sid, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    return {
      deltas,
      /** Finish the turn and settle its partial rows as the runner would. */
      async finish(answer: string) {
        hooks.deliver(sid, { hook_event_name: "Stop", session_id: `claude-${sid}`, last_assistant_message: answer });
        const result = await turn;
        writer.finish();
        const streamed = registry.getPartialMessages(sid);
        registry.settlePartialMessages(sid, streamedBlocks.completedStreamedBlockIds({
          quietPreempted: false,
          rateLimited: false,
          result: result.result,
          error: result.error,
          streamedBlocks: streamed,
        }));
        return result;
      },
    };
  }

  function toolRows(sid: string): ToolRow[] {
    return (registry.getMessages(sid) as Array<{ toolCall?: string; toolId?: string; content: string; partial?: boolean; meta?: unknown }>)
      .filter((m) => m.toolCall)
      .map((m) => ({
        tool_call: m.toolCall!,
        tool_id: m.toolId ?? null,
        content: m.content,
        partial: m.partial ? 1 : null,
        meta: m.meta ? JSON.stringify(m.meta) : null,
      }));
  }

  it("a remote session's N tool calls produce N tool_call rows", async () => {
    const sid = "remote-tools";
    const turn = await startTurn(sid, REMOTE_TARGET);
    expect(hoisted.ptys[0]?.bin).toMatch(/ssh$/);
    // No SSE proxy runs for a remote session: the hooks are the only report.
    expect(hoisted.sseSinks).toHaveLength(0);
    for (const [name, id] of [["Read", "tu-r1"], ["Bash", "tu-r2"], ["Grep", "tu-r3"]] as const) {
      hooks.deliver(sid, preTool(name, id));
      hooks.deliver(sid, postTool(name, id));
    }
    expect((await turn.finish("done")).result).toBe("done");

    const rows = toolRows(sid);
    expect(rows.map((r) => [r.tool_call, r.tool_id, r.content])).toEqual([
      ["Read", "tu-r1", "Used Read"],
      ["Bash", "tu-r2", "Used Bash"],
      ["Grep", "tu-r3", "Used Grep"],
    ]);
    // Each call's card keeps what it returned (and no input: these hooks carried none).
    expect(rows.every((r) => r.partial === null && r.meta === JSON.stringify({ tool: { output: "ok" } }))).toBe(true);
  });

  it("a main-agent call reported by both the SSE proxy and its hook is recorded once", async () => {
    const sid = "local-dedupe";
    const turn = await startTurn(sid);
    const sse = hoisted.sseSinks[0]!;
    sse({ type: "message_start" });
    sse(sseToolStart("Read", "tu-l1"));
    sse({ type: "message_stop" });
    hooks.deliver(sid, preTool("Read", "tu-l1"));
    hooks.deliver(sid, postTool("Read", "tu-l1"));
    // And the other order: the hook lands before the proxy has parsed the block.
    hooks.deliver(sid, preTool("Bash", "tu-l2"));
    sse({ type: "message_start" });
    sse(sseToolStart("Bash", "tu-l2"));
    sse({ type: "message_stop" });
    hooks.deliver(sid, postTool("Bash", "tu-l2"));
    await turn.finish("done");

    expect(turn.deltas.filter((d) => d.type === "tool_use").map((d) => d.toolId)).toEqual(["tu-l1", "tu-l2"]);
    expect(toolRows(sid).map((r) => [r.tool_call, r.content])).toEqual([
      ["Read", "Used Read"],
      ["Bash", "Used Bash"],
    ]);
  });

  it("a sub-agent's tool calls are recorded on the parent session, marked as sidechain", async () => {
    const sid = "local-subagent";
    const turn = await startTurn(sid);
    const sse = hoisted.sseSinks[0]!;
    // The main agent calls the Agent tool; the proxy tees only this stream.
    sse({ type: "message_start" });
    sse(sseToolStart("Agent", "tu-agent"));
    sse({ type: "message_stop" });
    hooks.deliver(sid, preTool("Agent", "tu-agent"));
    // The sub-agent's own calls arrive only as hooks carrying agent_id.
    hooks.deliver(sid, preTool("Bash", "tu-sub1", "agent-1"));
    hooks.deliver(sid, postTool("Bash", "tu-sub1", "agent-1"));
    hooks.deliver(sid, preTool("mcp__example__lookup", "tu-sub2", "agent-1"));
    hooks.deliver(sid, postTool("mcp__example__lookup", "tu-sub2", "agent-1"));
    hooks.deliver(sid, postTool("Agent", "tu-agent"));
    await turn.finish("done");

    const rows = toolRows(sid);
    expect(rows.map((r) => [r.tool_call, r.content, r.meta])).toEqual([
      ["Agent", "Used Agent", JSON.stringify({ tool: { output: "ok" } })],
      ["Bash", "Used Bash", JSON.stringify({ sidechain: true, tool: { output: "ok" } })],
      ["mcp__example__lookup", "Used mcp__example__lookup", JSON.stringify({ sidechain: true, tool: { output: "ok" } })],
    ]);
  });

  it("an Agent launch's async result puts the sub-agent id on its card row", async () => {
    const sid = "local-agent-launch";
    const turn = await startTurn(sid);
    const sse = hoisted.sseSinks[0]!;
    sse({ type: "message_start" });
    sse(sseToolStart("Agent", "tu-agent"));
    sse({ type: "message_stop" });
    hooks.deliver(sid, preTool("Agent", "tu-agent"));
    hooks.deliver(sid, {
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      tool_use_id: "tu-agent",
      tool_input: { description: "scan the repo" },
      tool_response: { status: "async_launched", agentId: "agent-42" },
    });
    await turn.finish("done");

    expect(toolRows(sid)).toEqual([
      {
        tool_call: "Agent",
        tool_id: "tu-agent",
        content: "Used Agent",
        partial: null,
        meta: JSON.stringify({
          agentId: "agent-42",
          tool: { input: { description: "scan the repo" }, output: JSON.stringify({ status: "async_launched", agentId: "agent-42" }) },
        }),
      },
    ]);
  });

  it("a call's input and output are kept on its row, whichever of the proxy and the hook reports first", async () => {
    const sid = "local-detail";
    const turn = await startTurn(sid);
    const sse = hoisted.sseSinks[0]!;
    sse({ type: "message_start" });
    sse(sseToolStart("Bash", "tu-d1"));
    sse({ type: "message_stop" });
    // The proxy announced the call without its input; the hook that fires as it starts has it.
    hooks.deliver(sid, { ...preTool("Bash", "tu-d1"), tool_input: { command: "ls -la", description: "list" } });
    expect(turn.deltas.filter((d) => d.type === "tool_update").map((d) => d.toolDetail)).toEqual([
      { input: { command: "ls -la", description: "list" } },
    ]);
    // Running: the row already carries the input.
    expect(toolRows(sid).map((r) => [r.content, r.meta])).toEqual([["Using Bash", JSON.stringify({ tool: { input: { command: "ls -la", description: "list" } } })]]);
    hooks.deliver(sid, { ...postTool("Bash", "tu-d1"), tool_input: { command: "ls -la", description: "list" }, tool_response: { stdout: "a\nb", stderr: "warn" } });
    await turn.finish("done");

    expect(toolRows(sid).map((r) => [r.content, r.meta])).toEqual([
      ["Used Bash", JSON.stringify({ tool: { input: { command: "ls -la", description: "list" }, output: "a\nb\nwarn" } })],
    ]);
  });

  it("a call whose card was cut keeps its whole input and output for the endpoint, and the stream and the row stay small", async () => {
    const sid = "local-full";
    const turn = await startTurn(sid);
    const sse = hoisted.sseSinks[0]!;
    sse({ type: "message_start" });
    sse(sseToolStart("Bash", "tu-full"));
    sse({ type: "message_stop" });
    const command = `${"echo line && ".repeat(300)}true`;
    hooks.deliver(sid, { ...preTool("Bash", "tu-full"), tool_input: { command } });
    const output = Array.from({ length: 4_000 }, (_, i) => `row ${i}`).join("\n");
    hooks.deliver(sid, { ...postTool("Bash", "tu-full"), tool_input: { command }, tool_response: { stdout: output, stderr: "" } });
    await turn.finish("done");

    const stored = tools.getToolDetail(sid, "tu-full")!;
    expect(stored.input?.command).toBe(command);
    expect(stored.output).toBe(output);
    expect(stored.outputChars).toBeUndefined();
    const [row] = toolRows(sid);
    const meta = JSON.parse(row.meta!).tool;
    expect(meta).toMatchObject({ full: true, inputTruncated: true });
    expect(meta.output.length).toBeLessThan(3_100);
    expect(meta.outputChars).toBe(output.length);
    // The whole text never rides a stream event.
    expect(JSON.stringify(turn.deltas.map((d) => d.toolDetail))).not.toContain("row 3999");
    expect(JSON.stringify(registry.getMessages(sid))).not.toContain("row 3999");
  });

  it("a thinking stream becomes thinking rows in order beside the text and the call, settled with the turn", async () => {
    const sid = "local-thinking";
    const turn = await startTurn(sid);
    const sse = hoisted.sseSinks[0]!;
    const think = (thinking: string) => sse({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } });
    const say = (text: string) => sse({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text } });
    sse({ type: "message_start" });
    think("I should look at ");
    think("the directory.");
    say("Let me check.");
    sse(sseToolStart("Bash", "tu-t1"));
    sse({ type: "message_stop" });
    hooks.deliver(sid, postTool("Bash", "tu-t1"));
    sse({ type: "message_start" });
    think("It worked.");
    say("All done.");
    sse({ type: "message_stop" });
    await turn.finish("All done.");

    // The streamed copy of the answer goes at settle, replaced by the final row the turn runner writes.
    expect(registry.getMessages(sid).map((m) => [m.role, m.content, m.partial ?? false])).toEqual([
      ["thinking", "I should look at the directory.", false],
      ["assistant", "Let me check.", false],
      ["assistant", "Used Bash", false],
      ["thinking", "It worked.", false],
    ]);
    // The answer is the one the engine returns: thinking is never part of it.
    expect(turn.deltas.filter((d) => d.type === "thinking").map((d) => d.content)).toEqual(["I should look at ", "the directory.", "It worked."]);
  });

  it("a call that failed ends as an error row carrying the failure", async () => {
    const sid = "local-failed";
    const turn = await startTurn(sid);
    hooks.deliver(sid, { ...preTool("Read", "tu-f1"), tool_input: { file_path: "/nope" } });
    hooks.deliver(sid, { hook_event_name: "PostToolUseFailure", tool_name: "Read", tool_use_id: "tu-f1", tool_input: { file_path: "/nope" }, error: "File does not exist." });
    await turn.finish("done");

    expect(toolRows(sid).map((r) => [r.content, r.meta])).toEqual([
      ["Used Read", JSON.stringify({ tool: { input: { file_path: "/nope" }, output: "File does not exist.", isError: true } })],
    ]);
  });

  it("a secret in a call's input or output never reaches the stream or the row", async () => {
    const sid = "local-secret";
    const turn = await startTurn(sid);
    hooks.deliver(sid, { ...preTool("Bash", "tu-s1"), tool_input: { command: "curl -H 'Authorization: Bearer abc123def456' x", api_key: "hunter2" } });
    hooks.deliver(sid, { ...postTool("Bash", "tu-s1"), tool_response: { stdout: "MY_API_TOKEN=sk-abcdef123456789" } });
    await turn.finish("done");

    const everything = JSON.stringify([turn.deltas, toolRows(sid)]);
    expect(everything).not.toContain("abc123def456");
    expect(everything).not.toContain("hunter2");
    expect(everything).not.toContain("sk-abcdef123456789");
  });

  it("a PreToolUse replayed from before the turn is not reported again", async () => {
    const sid = "local-replay";
    // Buffered with no turn registered: it belongs to whatever ran before.
    hooks.deliver(sid, preTool("Read", "tu-old"));
    const turn = await startTurn(sid);
    await turn.finish("done");
    expect(turn.deltas.filter((d) => d.type === "tool_use")).toEqual([]);
    expect(toolRows(sid)).toEqual([]);
  });
});
