import { describe, expect, it } from "vitest";
import { SpeakableSplitter, speakableSentence } from "../speakable-splitter.js";

/** Feed a reply in pieces of `size` characters and collect everything spoken. */
function speak(text: string, size: number): string[] {
  const splitter = new SpeakableSplitter();
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(...splitter.push(text.slice(i, i + size)));
  out.push(...splitter.flush());
  return out;
}

describe("SpeakableSplitter", () => {
  it("hands on a sentence as soon as its end is certain, not before", () => {
    const splitter = new SpeakableSplitter();
    expect(splitter.push("The first sentence is done.")).toEqual([]);
    expect(splitter.push(" The second is")).toEqual(["The first sentence is done."]);
    expect(splitter.push(" still going")).toEqual([]);
    expect(splitter.flush()).toEqual(["The second is still going"]);
  });

  it("gives the same sentences however the reply is cut into deltas", () => {
    const reply = "Short answer first. Then a second one!\n\nA paragraph break follows. Does that work? Yes.";
    const whole = speak(reply, reply.length);
    expect(whole).toEqual(["Short answer first.", "Then a second one!", "A paragraph break follows.", "Does that work?", "Yes."]);
    for (const size of [1, 2, 3, 5, 7, 13]) expect(speak(reply, size)).toEqual(whole);
  });

  it("never speaks fenced code, however the fence is split across deltas", () => {
    const reply = "Here is the fix.\n```ts\nconst secret = 1;\nfoo();\n```\nIt is applied.";
    for (const size of [1, 4, 9, reply.length]) {
      const spoken = speak(reply, size).join(" ");
      expect(spoken).toBe("Here is the fix. It is applied.");
      expect(spoken).not.toContain("secret");
    }
  });

  it("never speaks table rows, paths, links or ids, and says the link is on screen", () => {
    const reply = [
      "I changed it in /opt/example/src/main.ts and ./lib/util.ts today.",
      "| name | value |",
      "|------|-------|",
      "| a | 1 |",
      "See https://example.com/a/b for more, or commit 3f2a9c4d8e1b7a60.",
    ].join("\n");
    const spoken = speak(reply, 6).join(" ");
    expect(spoken).not.toMatch(/opt|main\.ts|util\.ts|name|value|\|/);
    expect(spoken).toContain("the link on screen");
    expect(spoken).not.toContain("3f2a9c4d8e1b7a60");
    expect(spoken).toContain("I changed it in");
  });

  it("reads list items and headings as sentences without their marks", () => {
    expect(speak("# Plan\n- first step\n- second step\n1. numbered step\n", 5)).toEqual(["Plan", "first step", "second step", "numbered step"]);
  });

  it("drops what has nothing to say once cleaned", () => {
    expect(speak("```\ncode only\n```\n", 3)).toEqual([]);
    expect(speakableSentence("**")).toBe("");
    expect(speakableSentence("a1b2c3d4e5f6a7b8")).toBe("");
  });

  it("cuts a long run with no terminator at a comma or space so speech can start", () => {
    const run = `${"word ".repeat(30)}and, ${"more ".repeat(60)}end`;
    const pieces = speak(run, 40);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((p) => p.length <= 300)).toBe(true);
    expect(pieces.join(" ").replace(/\s+/g, " ")).toContain("end");
  });

  it("forgets what it held when reset", () => {
    const splitter = new SpeakableSplitter();
    splitter.push("Half a sent");
    splitter.reset();
    expect(splitter.flush()).toEqual([]);
  });
});
