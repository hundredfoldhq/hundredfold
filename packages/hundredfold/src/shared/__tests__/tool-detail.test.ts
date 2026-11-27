import { describe, expect, it } from "vitest";
import {
  boundToolInput,
  patchHunks,
  boundToolInputFull,
  boundToolOutput,
  boundToolOutputFull,
  toolEndParts,
  toolStartParts,
  TOOL_FULL_INPUT_MAX,
  TOOL_FULL_OUTPUT_MAX,
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

  it("keeps an edit's change as numbered hunks, from the patch its result carries", () => {
    const response = {
      filePath: "/a.ts",
      oldString: "gamma",
      newString: "GAMMA",
      originalFile: "alpha\nbeta\ngamma\ndelta\n",
      structuredPatch: [
        { oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, lines: [" alpha", " beta", "-gamma", "+GAMMA", " delta"] },
        { oldStart: 40, oldLines: 1, newStart: 40, newLines: 2, lines: [" x", "+y"] },
      ],
    };
    expect(toolOutputText(response)).toBe("@@ -1,4 +1,4 @@\n alpha\n beta\n-gamma\n+GAMMA\n delta\n@@ -40,1 +40,2 @@\n x\n+y");
  });

  it("leaves a write's patch out: its card draws the file it wrote from the input", () => {
    const response = {
      type: "update",
      filePath: "/a.ts",
      content: "new body",
      originalFile: "old body",
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old body", "+new body"] }],
    };
    expect(toolOutputText(response)).toBe("");
  });

  it("skips a malformed hunk and keeps the rest", () => {
    const response = { originalFile: "", structuredPatch: [{ lines: ["-a"] }, { oldStart: 3, newStart: 3, lines: ["+b", 7] }] };
    expect(toolOutputText(response)).toBe("@@ -3,0 +3,0 @@\n+b");
  });
});

describe("patchHunks", () => {
  it("keeps a unified diff from its first hunk, without the file headers that name its path", () => {
    const patch = "Index: /work/f.txt\n===================================================================\n--- /work/f.txt\n+++ /work/f.txt\n@@ -1,3 +1,3 @@\n alpha\n-gamma\n+GAMMA\n";
    expect(patchHunks(patch)).toBe("@@ -1,3 +1,3 @@\n alpha\n-gamma\n+GAMMA");
  });

  it("has nothing for text with no hunk, or no text", () => {
    expect(patchHunks("--- a\n+++ b\n")).toBeUndefined();
    expect(patchHunks(undefined)).toBeUndefined();
    expect(patchHunks({ diff: "@@ -1 +1 @@" })).toBeUndefined();
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

  it("a megabyte of dotted or dashed words is redacted in well under a second, card and store both", () => {
    const uuids = Array.from({ length: 28_000 }, (_, i) => `${String(i).padStart(8, "0")}-aaaa-bbbb-cccc-dddddddddddd`).join("-");
    for (const output of ["a.".repeat(500_000), uuids]) {
      const started = Date.now();
      const parts = toolEndParts({ input: { command: output.slice(0, 200_000) }, output });
      expect(Date.now() - started).toBeLessThan(1_500);
      expect(parts.toolFull?.output?.length).toBe(Math.min(output.length, 1_000_000));
    }
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

describe("the whole of a call, kept when its card was cut", () => {
  it("keeps an input whole where the card cut it, and redacts all of it", () => {
    const command = `${"echo hello && ".repeat(400)}export GH_TOKEN=ghp_abcdefghij123456`;
    const full = boundToolInputFull({ command, description: "run" })!;
    expect(full.chars).toBeUndefined();
    expect((full.input.command as string).startsWith("echo hello && ")).toBe(true);
    expect((full.input.command as string).length).toBeGreaterThan(TOOL_INPUT_STRING_MAX * 4);
    expect(JSON.stringify(full)).not.toContain("ghp_abcdefghij123456");
    expect(full.input.description).toBe("run");
  });

  it("redacts a secret past the 200,000 characters a card's redaction reads", () => {
    const output = `${"line of output\n".repeat(20_000)}API_TOKEN=late-secret-value\n`;
    expect(output.length).toBeGreaterThan(200_000);
    const full = boundToolOutputFull(output)!;
    expect(full.output).not.toContain("late-secret-value");
    expect(full.output).toContain("API_TOKEN=[REDACTED]");
    expect(full.chars).toBeUndefined();
  });

  it("caps an output at a million characters and says how long it was", () => {
    const full = boundToolOutputFull("y".repeat(1_500_000))!;
    expect(full.output.length).toBe(TOOL_FULL_OUTPUT_MAX);
    expect(full.chars).toBe(1_500_000);
    expect(boundToolOutputFull("")).toBeUndefined();
  });

  it("caps an input at 256 KB serialised, keeping the head of its strings, and says how long it was", () => {
    const body = "z".repeat(600_000);
    const full = boundToolInputFull({ file_path: "/a", content: body })!;
    expect(JSON.stringify(full.input).length).toBeLessThanOrEqual(TOOL_FULL_INPUT_MAX);
    expect(full.input.file_path).toBe("/a");
    expect((full.input.content as string).startsWith("zzzz")).toBe(true);
    expect(full.chars).toBeGreaterThan(600_000);
  });

  it("keeps a MultiEdit's every edit where the card kept the first few", () => {
    const edits = Array.from({ length: 30 }, (_, i) => ({ old_string: `old ${i} ${"a".repeat(800)}`, new_string: `new ${i}` }));
    const full = boundToolInputFull({ file_path: "/x", edits })!;
    expect((full.input.edits as unknown[]).length).toBe(30);
    expect(full.chars).toBeUndefined();
  });

  it("marks the card `full` and carries the whole text only when something was cut", () => {
    const short = toolEndParts({ input: { command: "ls" }, output: "a\nb" });
    expect(short.toolDetail).toEqual({ input: { command: "ls" }, output: "a\nb" });
    expect(short.toolFull).toBeUndefined();
    expect(toolStartParts({ command: "ls" })).toEqual({ toolDetail: { input: { command: "ls" } } });

    const longOutput = toolEndParts({ input: { command: "seq 1 5000" }, output: "1234567890\n".repeat(2_000), isError: true });
    expect(longOutput.toolDetail).toMatchObject({ full: true, isError: true, outputChars: 22_000 });
    expect(longOutput.toolFull).toMatchObject({ input: { command: "seq 1 5000" }, isError: true });
    expect(longOutput.toolFull?.output?.length).toBe(22_000);
    expect(longOutput.toolFull?.outputChars).toBeUndefined();

    const longInput = toolStartParts({ content: "q".repeat(5_000) });
    expect(longInput.toolDetail).toMatchObject({ full: true, inputTruncated: true });
    expect((longInput.toolFull?.input?.content as string).length).toBe(5_000);
  });

  it("does not mark the sub-agent card paths: `toolStartDetail` and `toolEndDetail` stay as they were", () => {
    expect(toolStartDetail({ content: "q".repeat(5_000) })).not.toHaveProperty("full");
    expect(toolEndDetail({ output: "q".repeat(5_000) })).not.toHaveProperty("full");
  });
});
