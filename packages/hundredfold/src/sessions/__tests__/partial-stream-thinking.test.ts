import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { StreamDelta } from "../../shared/types.js";
import { completedStreamedBlockIds } from "../../gateway/streamed-blocks.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-partial-thinking-"));
process.env.HUNDREDFOLD_HOME = home;
const dbModule = await import("../../shared/db.js");

let registry: typeof import("../registry.js");
let partial: typeof import("../partial-stream.js");
let store: typeof import("../tool-details.js");

const thinking = (content: string): StreamDelta & { type: "thinking" } => ({ type: "thinking", content });
const text = (content: string): StreamDelta => ({ type: "text", content });

function runningSession(ref: string): string {
  const session = registry.createSession({ engine: "claude", source: "web", sourceRef: `web:${ref}`, prompt: "q" });
  registry.insertMessage(session.id, "user", "q");
  registry.updateSession(session.id, { status: "running", attemptToken: ref });
  return session.id;
}

const rows = (sessionId: string) => registry.getMessages(sessionId).map((m) => ({ role: m.role, content: m.content, partial: m.partial, tool: m.toolCall }));

beforeAll(async () => {
  dbModule.initDb();
  registry = await import("../registry.js");
  partial = await import("../partial-stream.js");
  store = await import("../tool-details.js");
});

afterEach(() => vi.useRealTimers());

describe("thinking in the partial stream", () => {
  it("is its own row, in stream order with the text and the tool calls around it", () => {
    const id = runningSession("order");
    const writer = partial.createPartialStreamWriter(id, "order");
    writer.persist(thinking("Let me "));
    writer.persist(thinking("think."));
    writer.persist(text("I will look."));
    writer.persist({ type: "tool_use", content: "Bash", toolName: "Bash", toolId: "toolu_1" });
    writer.persist(thinking("Now what?"));
    writer.persist(text("Done."));
    writer.finish();
    expect(rows(id).slice(1)).toEqual([
      { role: "thinking", content: "Let me think.", partial: true, tool: undefined },
      { role: "assistant", content: "I will look.", partial: true, tool: undefined },
      { role: "assistant", content: "Using Bash", partial: true, tool: "Bash" },
      { role: "thinking", content: "Now what?", partial: true, tool: undefined },
      { role: "assistant", content: "Done.", partial: true, tool: undefined },
    ]);
  });

  it("stamps each run with its own block and offset, so a view can join the stored row to the live deltas", () => {
    const id = runningSession("blocks");
    const writer = partial.createPartialStreamWriter(id, "blocks");
    const first = writer.persist(thinking("abc"))!;
    const second = writer.persist(thinking("def"))!;
    const answer = writer.persist(text("xyz"));
    expect(first).toMatchObject({ type: "thinking", content: "abc", streamBlock: expect.any(Number), offset: 0 });
    expect(second).toMatchObject({ streamBlock: first.streamBlock, offset: 3 });
    expect(answer.streamBlock).toBeGreaterThan(first.streamBlock!);
    expect(answer.offset).toBe(0);
    expect(partial.getLiveStreamBlock(id, "blocks")).toMatchObject({ block: answer.streamBlock, text: "xyz" });
  });

  it("keeps the head of a long thought and a marker, and drops what follows", () => {
    const id = runningSession("cap");
    const writer = partial.createPartialStreamWriter(id, "cap");
    const big = "t".repeat(partial.THINKING_ROW_MAX - 5);
    expect(writer.persist(thinking(big))?.content).toBe(big);
    const cut = writer.persist(thinking("0123456789"))!;
    expect(cut.content).toBe("01234…");
    expect(writer.persist(thinking("more"))).toBeNull();
    writer.persist(text("answer"));
    writer.finish();
    const [row] = rows(id).filter((r) => r.role === "thinking");
    expect(row.content.length).toBe(partial.THINKING_ROW_MAX + 1);
    expect(row.content.endsWith("01234…")).toBe(true);
  });

  it("has no row for thinking that is only whitespace", () => {
    const id = runningSession("blank");
    const writer = partial.createPartialStreamWriter(id, "blank");
    writer.persist(thinking("  \n"));
    writer.persist(text("answer"));
    writer.finish();
    expect(rows(id).map((r) => r.role)).toEqual(["user", "assistant"]);
  });

  it("is written on the flush timer like text", () => {
    vi.useFakeTimers();
    const id = runningSession("timer");
    const writer = partial.createPartialStreamWriter(id, "timer");
    writer.persist(thinking("hmm"));
    expect(rows(id).filter((r) => r.role === "thinking")).toHaveLength(0);
    vi.advanceTimersByTime(700);
    expect(rows(id).filter((r) => r.role === "thinking")).toHaveLength(1);
    writer.finish();
  });

  it("is kept when a turn settles with an answer, dropped when it was cut off, and never stands in for the answer", () => {
    const streamed = [
      { id: "t1", role: "thinking", content: "pondering" },
      { id: "a1", role: "assistant", content: "interim" },
      { id: "a2", role: "assistant", content: "final answer" },
      { id: "w", role: "thinking", content: "  " },
    ];
    const settled = completedStreamedBlockIds({ quietPreempted: false, rateLimited: false, result: "final answer", error: null, streamedBlocks: streamed });
    expect([...settled].sort()).toEqual(["a1", "t1"]);
    const cut = completedStreamedBlockIds({ quietPreempted: false, rateLimited: false, result: "", error: null, streamedBlocks: streamed });
    expect([...cut]).toEqual([]);
    const thinkingOnly = completedStreamedBlockIds({ quietPreempted: false, rateLimited: false, result: "pondering", error: null, streamedBlocks: [{ id: "t1", role: "thinking", content: "pondering" }] });
    expect([...thinkingOnly]).toEqual(["t1"]);
  });
});

describe("a tool call's full detail in the partial stream", () => {
  const full = { input: { command: "seq 1 99999" }, output: "1\n2\n3\n", isError: false };

  it("is stored when the call's card was cut, and does not go out with the delta", () => {
    const id = runningSession("full-1");
    const writer = partial.createPartialStreamWriter(id, "full-1");
    const started = writer.persist({ type: "tool_use", content: "Bash", toolName: "Bash", toolId: "toolu_f", toolDetail: { input: { command: "seq" }, inputTruncated: true, full: true }, toolFull: { input: full.input } });
    expect(started).not.toHaveProperty("toolFull");
    expect(store.getToolDetail(id, "toolu_f")).toEqual({ input: full.input });
    const ended = writer.persist({ type: "tool_result", content: "Bash", toolName: "Bash", toolId: "toolu_f", toolDetail: { output: "1\n2…", outputChars: 500_000 }, toolFull: { output: full.output, outputChars: 5_000_000 } });
    expect(ended).not.toHaveProperty("toolFull");
    expect(store.getToolDetail(id, "toolu_f")).toEqual({ input: full.input, output: full.output, outputChars: 5_000_000 });
    const row = rows(id).find((r) => r.tool === "Bash");
    expect(row?.content).toBe("Used Bash");
    expect(registry.getMessages(id).find((m) => m.toolId === "toolu_f")?.meta).toMatchObject({ tool: { full: true, output: "1\n2…" } });
  });

  it("takes the input from a later update, as the claude hook delivers it after the stream announced the call", () => {
    const id = runningSession("full-2");
    const writer = partial.createPartialStreamWriter(id, "full-2");
    writer.persist({ type: "tool_use", content: "Write", toolName: "Write", toolId: "toolu_u" });
    expect(store.getToolDetail(id, "toolu_u")).toBeUndefined();
    writer.persist({ type: "tool_update", content: "Write", toolName: "Write", toolId: "toolu_u", toolDetail: { input: { content: "q" }, inputTruncated: true, full: true }, toolFull: { input: { content: "qqqq" } } });
    expect(store.getToolDetail(id, "toolu_u")).toEqual({ input: { content: "qqqq" } });
  });

  it("keeps the output of a call whose input was cut but whose output was not, so the detail is whole", () => {
    const id = runningSession("full-3");
    const writer = partial.createPartialStreamWriter(id, "full-3");
    writer.persist({ type: "tool_use", content: "Write", toolName: "Write", toolId: "toolu_w", toolDetail: { input: { content: "q" }, inputTruncated: true, full: true }, toolFull: { input: { content: "qqqq" } } });
    writer.persist({ type: "tool_result", content: "Write", toolName: "Write", toolId: "toolu_w", toolDetail: { output: "created", isError: true } });
    expect(store.getToolDetail(id, "toolu_w")).toEqual({ input: { content: "qqqq" }, output: "created", isError: true });
  });

  it("stores nothing for a call that was never cut", () => {
    const id = runningSession("full-4");
    const writer = partial.createPartialStreamWriter(id, "full-4");
    writer.persist({ type: "tool_use", content: "Bash", toolName: "Bash", toolId: "toolu_n", toolDetail: { input: { command: "ls" } } });
    writer.persist({ type: "tool_result", content: "Bash", toolName: "Bash", toolId: "toolu_n", toolDetail: { output: "a" } });
    expect(store.getToolDetail(id, "toolu_n")).toBeUndefined();
  });
});
