import { describe, expect, it } from "vitest";
import {
  boundToolInput,
  boundToolOutput,
  mergeToolDetail,
  toolEndDetail,
  toolOutputText,
  toolStartDetail,
  TOOL_INPUT_STRING_MAX,
  TOOL_INPUT_TOTAL_MAX,
  TOOL_OUTPUT_MAX,
} from "../tool-detail.js";

describe("boundToolInput", () => {
  it("keeps a small input as it is", () => {
    expect(boundToolInput({ command: "ls", description: "list" })).toEqual({ input: { command: "ls", description: "list" }, truncated: false });
  });

  it("has nothing to show for an empty or non-object input", () => {
    expect(boundToolInput({})).toBeUndefined();
    expect(boundToolInput(undefined)).toBeUndefined();
    expect(boundToolInput("ls")).toBeUndefined();
    expect(boundToolInput(["a"])).toBeUndefined();
  });

  it("redacts secret keys and token shapes, then reports nothing was cut", () => {
    const bounded = boundToolInput({ api_key: "hunter2", command: "export GH_TOKEN=ghp_abcdefghij123456 && run" });
    expect(JSON.stringify(bounded)).not.toContain("hunter2");
    expect(JSON.stringify(bounded)).not.toContain("ghp_abcdefghij123456");
    expect(bounded?.input.api_key).toBe("[REDACTED]");
  });

  it("cuts a long string and says so", () => {
    const bounded = boundToolInput({ content: "x".repeat(TOOL_INPUT_STRING_MAX * 3) });
    expect((bounded?.input.content as string).length).toBe(TOOL_INPUT_STRING_MAX + 1);
    expect(bounded?.truncated).toBe(true);
  });

  it("keeps a many-field input under the total budget, leading fields first", () => {
    const wide = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`field${i}`, "y".repeat(500)]));
    const bounded = boundToolInput(wide)!;
    expect(JSON.stringify(bounded.input).length).toBeLessThanOrEqual(TOOL_INPUT_TOTAL_MAX);
    expect(Object.keys(bounded.input)[0]).toBe("field0");
    expect(bounded.truncated).toBe(true);
  });

  it("bounds depth and array length", () => {
    const bounded = boundToolInput({ list: Array.from({ length: 50 }, (_, i) => i), deep: { a: { b: { c: { d: { e: 1 } } } } } })!;
    expect((bounded.input.list as number[]).length).toBe(20);
    expect(bounded.truncated).toBe(true);
    expect(JSON.stringify(bounded.input.deep)).toContain("…");
  });
});

describe("boundToolInput over budget", () => {
  const edit = (n: number) => ({ old_string: `old${n} ${"o".repeat(500)}`, new_string: `new${n} ${"n".repeat(500)}` });

  it("keeps the leading edits of a MultiEdit and says the rest were cut", () => {
    const bounded = boundToolInput({ file_path: "/a.ts", edits: Array.from({ length: 6 }, (_, n) => edit(n)) })!;
    const edits = bounded.input.edits as Array<{ old_string: string }>;
    expect(bounded.input.file_path).toBe("/a.ts");
    expect(edits.length).toBeGreaterThanOrEqual(2);
    expect(edits.length).toBeLessThan(6);
    expect(edits[0].old_string.startsWith("old0")).toBe(true);
    expect(bounded.truncated).toBe(true);
    expect(JSON.stringify(bounded.input).length).toBeLessThanOrEqual(TOOL_INPUT_TOTAL_MAX);
  });

  it("keeps a small field after a big one", () => {
    const bounded = boundToolInput({ edits: Array.from({ length: 6 }, (_, n) => edit(n)), description: "tidy up" })!;
    expect(bounded.input.description).toBe("tidy up");
    expect(bounded.input.edits).toBeDefined();
  });

  it("falls back to whole leading fields when nothing inside shrinks enough", () => {
    const wide = Object.fromEntries(Array.from({ length: 80 }, (_, n) => [`field${n}`, "v".repeat(100)]));
    const bounded = boundToolInput(wide)!;
    expect(Object.keys(bounded.input)[0]).toBe("field0");
    expect(bounded.truncated).toBe(true);
    expect(JSON.stringify(bounded.input).length).toBeLessThanOrEqual(TOOL_INPUT_TOTAL_MAX);
  });
});

describe("toolOutputText", () => {
  it("reads a string, a list of text blocks and an MCP content wrapper", () => {
    expect(toolOutputText("plain")).toBe("plain");
    expect(toolOutputText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }])).toBe("a\nb");
    expect(toolOutputText({ content: [{ type: "text", text: "mcp" }] })).toBe("mcp");
  });

  it("reads Claude's structured built-in results by the part a person reads", () => {
    expect(toolOutputText({ stdout: "out", stderr: "err" })).toBe("out\nerr");
    expect(toolOutputText({ type: "text", file: { filePath: "/a", content: "body" } })).toBe("body");
    expect(toolOutputText({ mode: "files_with_matches", filenames: ["a.ts", "b.ts"] })).toBe("a.ts\nb.ts");
  });

  it("reads a silent or stderr-only shell as what it printed, never as its JSON", () => {
    const silent = { stdout: "", stderr: "", interrupted: false, isImage: false };
    expect(toolOutputText(silent)).toBe("");
    expect(toolEndDetail({ output: silent })).toBeUndefined();
    expect(toolOutputText({ ...silent, stderr: "From origin" })).toBe("From origin");
    expect(toolOutputText({ ...silent, stdout: "done" })).toBe("done");
  });

  it("still falls back to the object for a shape it does not know", () => {
    expect(toolOutputText({ matches: 3 })).toBe('{"matches":3}');
  });

  it("leaves an edit's old and new file bodies out: the card draws the change from the input", () => {
    expect(toolOutputText({ filePath: "/a", originalFile: "old", structuredPatch: [] })).toBe("");
  });
});

describe("boundToolOutput", () => {
  it("cuts a long output and reports its full length", () => {
    const bounded = boundToolOutput("z".repeat(TOOL_OUTPUT_MAX + 500))!;
    expect(bounded.output.length).toBe(TOOL_OUTPUT_MAX + 1);
    expect(bounded.chars).toBe(TOOL_OUTPUT_MAX + 500);
  });

  it("redacts before it cuts, so a secret straddling the cut cannot survive", () => {
    const bounded = boundToolOutput(`${"a".repeat(TOOL_OUTPUT_MAX - 10)} API_KEY=sk-abcdef123456789`)!;
    expect(bounded.output).not.toContain("sk-abcdef");
  });

  it("has nothing for an empty output", () => {
    expect(boundToolOutput("")).toBeUndefined();
  });
});

describe("work on huge text", () => {
  it("a result of tens of thousands of blank lines is handled in well under a second", () => {
    const text = `${"\n".repeat(60_000)}x`;
    const started = Date.now();
    const bounded = boundToolOutput(text)!;
    const input = boundToolInput({ content: text })!;
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(bounded.chars).toBe(text.length);
    expect(input.truncated).toBe(true);
  });

  it("a megabyte of output is cut and still reports its full length", () => {
    const bounded = boundToolOutput("y".repeat(1_000_000))!;
    expect(bounded.output.length).toBe(TOOL_OUTPUT_MAX + 1);
    expect(bounded.chars).toBe(1_000_000);
  });
});

describe("tool detail", () => {
  it("a call's end repeats the input the start never had, and carries the failure", () => {
    expect(toolEndDetail({ input: { file_path: "/x" }, output: "boom", isError: true })).toEqual({
      input: { file_path: "/x" },
      output: "boom",
      isError: true,
    });
    expect(toolEndDetail({})).toBeUndefined();
  });

  it("the end refines the start: the output joins the input already stored", () => {
    expect(mergeToolDetail(toolStartDetail({ command: "ls" }), { output: "a" })).toEqual({ input: { command: "ls" }, output: "a" });
    expect(mergeToolDetail(undefined, { output: "a" })).toEqual({ output: "a" });
    expect(mergeToolDetail({ input: { command: "ls" } }, undefined)).toEqual({ input: { command: "ls" } });
  });
});
