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
