import { describe, it, expect } from "vitest";

import { OpencodeTurn } from "../opencode-turn.js";
import { v2ErrorLine } from "../opencode-v2-events.js";
import { detectRateLimit } from "../../shared/rateLimit.js";

/**
 * What an `error` line makes of a turn, whichever opencode printed it.
 *
 * 1.x prints `{name, data: {message}}`. OpenCode 2's `opencode run --format
 * json` prints `{type, message, status?}` — the shape its server events carry,
 * passed through unconverted, since a plain run does not go through
 * `v2ErrorLine`. A turn reading only the 1.x shape reported every OpenCode 2
 * failure as "no message".
 */

const SES = "ses_test0001";

function errorOf(...lines: unknown[]): string | undefined {
  const turn = new OpencodeTurn("");
  for (const line of lines) turn.readLine(typeof line === "string" ? line : JSON.stringify(line), null);
  return turn.result({ code: 1, terminationReason: null, stderr: "" }).error;
}

describe("OpencodeTurn — an `error` line", () => {
  it("reads OpenCode 2's plain-run error: its type and message", () => {
    // Printed verbatim by `opencode run --format json` on 2.0.32 for a model
    // the host cannot route to.
    const line = '{"type":"error","timestamp":1792322049258,"sessionID":"ses_test0001",'
      + '"error":{"type":"provider.no-route","message":"Model unavailable: opencode-go/deepseek-v4.1-flash"}}';

    expect(errorOf(line)).toBe("provider.no-route: Model unavailable: opencode-go/deepseek-v4.1-flash");
  });

  it("reads an interrupted OpenCode 2 step as the interrupt it was", () => {
    // The error both failed turns stored in opencode's own message store.
    expect(errorOf({ type: "error", sessionID: SES, error: { type: "aborted", message: "Step interrupted" } }))
      .toBe("aborted: Step interrupted");
  });

  it("says the same about an OpenCode 2 error on a plain run as on a server turn", () => {
    expect(errorOf({ type: "error", sessionID: SES, error: { type: "provider.server", message: "Upstream unavailable", status: 502 } }))
      .toBe("provider.server: Upstream unavailable (HTTP 502)");
  });

  it.each([
    ["type, message and status", { type: "provider.server", message: "Upstream unavailable", status: 502 }],
    ["type only", { type: "provider.server" }],
    ["message only", { message: "Upstream unavailable" }],
    ["status without a message", { type: "provider.server", status: 503 }],
  ])("reads an OpenCode 2 error with %s the way a server turn does", (_shape, error) => {
    // The server path converts each v2 error with v2ErrorLine; a plain run
    // prints it raw. One failure must not read two ways.
    expect(errorOf({ type: "error", sessionID: SES, error })).toBe(errorOf(v2ErrorLine(SES, error)));
  });

  it("marks an OpenCode 2 rate limit on a plain run as one", () => {
    const turn = new OpencodeTurn("");
    turn.readLine(JSON.stringify({
      type: "error",
      sessionID: SES,
      error: { type: "provider.rate-limit", message: "Too many requests", status: 429 },
    }), null);

    expect(detectRateLimit(turn.result({ code: 1, terminationReason: null, stderr: "" })).limited).toBe(true);
  });

  it("keeps reading 1.x's shape", () => {
    expect(errorOf({ type: "error", sessionID: SES, error: { name: "APIError", data: { message: "Bad Request" } } }))
      .toBe("APIError: Bad Request");
  });

  it("reads an error that is only a string", () => {
    expect(errorOf({ type: "error", sessionID: SES, error: "socket hang up" })).toBe("socket hang up");
  });

  it("carries the raw error when it has no name and no message", () => {
    const error = errorOf({ type: "error", sessionID: SES, error: { code: "E_GONE", detail: { retryable: false } } });

    expect(error).not.toBe("opencode reported an error with no message");
    expect(error).toBe('opencode reported an error with no message: {"code":"E_GONE","detail":{"retryable":false}}');
  });

  it("carries the rest of the event when it has no error field", () => {
    expect(errorOf({ type: "error", sessionID: SES, timestamp: 1, reason: "stream closed" }))
      .toBe('opencode reported an error with no message: {"reason":"stream closed"}');
  });

  it("says so in words when the event is only its envelope", () => {
    expect(errorOf({ type: "error", sessionID: SES, timestamp: 1 }))
      .toBe("opencode reported an error with no message and nothing else in its event");
  });

  it("does not read a 429 in the envelope's timestamp or session id as a rate limit", () => {
    // Quoting them would hand their digits to failure classification, which
    // matches a bare 429 anywhere in the text.
    const turn = new OpencodeTurn("");
    turn.readLine(JSON.stringify({ type: "error", sessionID: "ses_2b7c8f3a9ffe429", timestamp: 1792322429001 }), null);
    const result = turn.result({ code: 1, terminationReason: null, stderr: "" });

    expect(result.error).not.toContain("429");
    expect(detectRateLimit(result).limited).toBe(false);
  });

  it("caps a raw error so one huge event cannot flood the log", () => {
    const error = errorOf({ type: "error", sessionID: SES, error: { blob: "x".repeat(5000) } })!;

    expect(error.length).toBeLessThan(700);
    expect(error.endsWith("…")).toBe(true);
  });
});

describe("OpencodeTurn — a tool call's detail", () => {
  const toolLine = (state: Record<string, unknown>, extra: Record<string, unknown> = {}) => JSON.stringify({
    type: "tool_use",
    sessionID: SES,
    part: { id: "prt_1", callID: "call_1", messageID: "msg_1", type: "tool", tool: "bash", state, ...extra },
  });

  function read(...lines: string[]) {
    const turn = new OpencodeTurn("");
    const deltas: Array<Record<string, unknown>> = [];
    for (const line of lines) turn.readLine(line, (d) => deltas.push(d as unknown as Record<string, unknown>));
    return deltas;
  }

  it("carries the input and the output of a call reported once, at its end", () => {
    const deltas = read(toolLine({ status: "completed", input: { command: "ls", description: "list" }, output: "a\nb" }));
    expect(deltas.map((d) => d.type)).toEqual(["tool_use", "tool_result"]);
    expect(deltas[0]!.toolDetail).toEqual({ input: { command: "ls", description: "list" } });
    expect(deltas[1]!.toolDetail).toEqual({ input: { command: "ls", description: "list" }, output: "a\nb" });
  });

  it("announces a call once when it is reported running and again at its end", () => {
    const deltas = read(
      toolLine({ status: "running", input: { command: "sleep 5" } }),
      toolLine({ status: "completed", input: { command: "sleep 5" }, output: "" }),
    );
    expect(deltas.map((d) => d.type)).toEqual(["tool_use", "tool_result"]);
    expect(deltas[0]!.toolDetail).toEqual({ input: { command: "sleep 5" } });
  });

  it("keeps the whole input and output of a call whose card was cut, apart from the stream", () => {
    const command = `${"echo hello && ".repeat(200)}true`;
    const output = Array.from({ length: 3_000 }, (_, i) => `line ${i}`).join("\n");
    const deltas = read(toolLine({ status: "running", input: { command } }), toolLine({ status: "completed", input: { command }, output }));
    expect(deltas.map((d) => d.type)).toEqual(["tool_use", "tool_result"]);
    expect(deltas[0]).toMatchObject({ toolDetail: { inputTruncated: true, full: true }, toolFull: { input: { command } } });
    expect(deltas[1]).toMatchObject({ toolDetail: { full: true, outputChars: output.length }, toolFull: { input: { command }, output } });
    expect(JSON.stringify(deltas.map((d) => d.toolDetail))).not.toContain("line 2999");
  });

  it("has no full detail for a call that fit its card", () => {
    const deltas = read(toolLine({ status: "completed", input: { command: "ls" }, output: "a" }));
    expect(deltas.every((d) => d.toolFull === undefined)).toBe(true);
    expect(JSON.stringify(deltas)).not.toContain('"full"');
  });

  it("makes a reasoning line a thinking delta that is neither an answer nor progress", () => {
    const turn = new OpencodeTurn("");
    const deltas: Array<Record<string, unknown>> = [];
    turn.readLine(JSON.stringify({ type: "reasoning", sessionID: SES, part: { id: "prt_r", type: "reasoning", text: "Think first.", time: { end: 2 } } }), (d) => deltas.push(d as never));
    turn.readLine(JSON.stringify({ type: "reasoning", sessionID: SES, part: { type: "reasoning", text: "   " } }), (d) => deltas.push(d as never));
    expect(deltas).toEqual([{ type: "thinking", content: "Think first." }]);
    const result = turn.result({ code: 0, terminationReason: null, stderr: "" });
    expect(result.result).toBe("");
    expect(result.numTurns).toBeUndefined();
  });

  it("marks a failed call and keeps its error text as the output", () => {
    const deltas = read(toolLine({ status: "error", input: { filePath: "/nope" }, error: "File not found" }, { tool: "read" }));
    expect(deltas[1]!.toolDetail).toEqual({ input: { filePath: "/nope" }, output: "File not found", isError: true });
  });

  it("shows an edit's change as numbered hunks, from the diff its metadata carries", () => {
    const diff = "Index: /work/f.txt\n===================================================================\n--- /work/f.txt\n+++ /work/f.txt\n@@ -1,5 +1,5 @@\n alpha\n beta\n-gamma\n+GAMMA\n delta\n epsilon\n";
    const input = { filePath: "/work/f.txt", oldString: "gamma", newString: "GAMMA" };
    const deltas = read(toolLine({ status: "completed", input, output: "Edit applied successfully.", metadata: { diagnostics: {}, diff } }, { tool: "edit" }));
    expect(deltas[1]!.toolDetail).toEqual({ input, output: "@@ -1,5 +1,5 @@\n alpha\n beta\n-gamma\n+GAMMA\n delta\n epsilon" });
    expect(deltas[1]!.content).toBe("Edit applied successfully.");
  });

  it("names a 2.x run's call by its id, so its whole detail can be kept and loaded", () => {
    const line = (state: Record<string, unknown>) => JSON.stringify({
      type: "tool_use",
      sessionID: SES,
      part: { partID: "prt_2", sessionID: SES, messageID: "msg_2", type: "tool", id: "call_2", tool: "shell", state },
    });
    const output = Array.from({ length: 3_000 }, (_, i) => `line ${i}`).join("\n");
    const deltas = read(line({ status: "running", input: { command: "seq 3000" } }), line({ status: "completed", input: { command: "seq 3000" }, output }));
    expect(deltas.map((d) => [d.type, d.toolId])).toEqual([["tool_use", "call_2"], ["tool_result", "call_2"]]);
    expect(deltas[1]).toMatchObject({ toolDetail: { full: true }, toolFull: { output } });
  });

  it("does not take a 1.x part's own id for its call's", () => {
    const deltas = read(JSON.stringify({ type: "tool_use", sessionID: SES, part: { id: "prt_1", messageID: "msg_1", type: "tool", tool: "bash", state: { status: "completed", input: {}, output: "a" } } }));
    expect(deltas.every((d) => d.toolId === undefined)).toBe(true);
  });

  it("shows a 2.x run's edit as numbered hunks, from the one file's patch it reports", () => {
    const patch = "Index: g.txt\n===================================================================\n--- g.txt\n+++ g.txt\n@@ -1,4 +1,4 @@\n alpha\n beta\n-gamma\n+GAMMA\n delta\n";
    const input = { path: "/work/g.txt", oldString: "gamma", newString: "GAMMA" };
    const metadata = {
      metadata: { files: [{ file: "g.txt", patch, status: "modified", additions: 1, deletions: 1 }], truncated: false },
      content: [{ type: "text", text: "Edited g.txt (1 replacement)" }],
    };
    const deltas = read(toolLine({ status: "completed", input, output: "Edited g.txt (1 replacement)", metadata }, { tool: "edit" }));
    expect(deltas[1]!.toolDetail).toEqual({ input, output: "@@ -1,4 +1,4 @@\n alpha\n beta\n-gamma\n+GAMMA\n delta" });
    const two = { metadata: { files: [{ file: "g.txt", patch }, { file: "h.txt", patch }] } };
    const several = read(toolLine({ status: "completed", input, output: "Edited 2 files", metadata: two }, { tool: "apply_patch" }));
    expect(several[1]!.toolDetail).toMatchObject({ output: "Edited 2 files" });
  });

  it("keeps an edit's own output when it says more than that the edit applied", () => {
    const output = "Edit applied successfully.\n\nLSP errors detected in this file, please fix:\nERROR [3:1] oops";
    const deltas = read(toolLine({ status: "completed", input: { filePath: "/work/f.ts" }, output, metadata: { diff: "@@ -1 +1 @@\n-a\n+b\n" } }, { tool: "edit" }));
    expect(deltas[1]!.toolDetail).toMatchObject({ output });
  });

  it("keeps a failed edit's error, not its diff", () => {
    const deltas = read(toolLine({ status: "error", input: { filePath: "/work/f.ts" }, error: "oldString not found", metadata: { diff: "@@ -1 +1 @@\n-a\n+b\n" } }, { tool: "edit" }));
    expect(deltas[1]!.toolDetail).toMatchObject({ output: "oldString not found", isError: true });
  });

  it("does not let a secret in the input through", () => {
    const deltas = read(toolLine({ status: "completed", input: { command: "echo", password: "hunter2" }, output: "ok" }));
    expect(JSON.stringify(deltas)).not.toContain("hunter2");
  });
});
