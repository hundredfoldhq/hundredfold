import { describe, expect, it } from "vitest"
import { formatTtfa, splitUnheard, voiceMeta } from "../message-meta"

describe("voiceMeta", () => {
  it("reads the voice facts and ignores malformed fields", () => {
    expect(voiceMeta({ voice: { utteranceId: "u1", sttProvider: "local", audioMs: 1200, spokenText: "hi", interrupted: true, ttfaMs: 800, junk: 1 } }))
      .toEqual({ utteranceId: "u1", sttProvider: "local", audioMs: 1200, spokenText: "hi", interrupted: true, ttfaMs: 800 })
    expect(voiceMeta({ voice: { utteranceId: 5, ttfaMs: -1, interrupted: "yes" } })).toBeNull()
  })

  it("is null for a typed message", () => {
    expect(voiceMeta(undefined)).toBeNull()
    expect(voiceMeta({})).toBeNull()
    expect(voiceMeta({ voice: [] })).toBeNull()
    expect(voiceMeta({ voice: "x" })).toBeNull()
  })
})

describe("formatTtfa", () => {
  it("reads in milliseconds under a second and seconds above", () => {
    expect(formatTtfa(820)).toBe("820 ms")
    expect(formatTtfa(1500)).toBe("1.5 s")
  })
})

const REPLY = "I found the bug. It is in the config loader. I fixed it and ran the tests. All of them pass."

describe("splitUnheard", () => {
  it("splits after the last spoken sentence", () => {
    const split = splitUnheard(REPLY, "I found the bug. It is in the config loader.")
    expect(split).toEqual({
      heard: "I found the bug. It is in the config loader.",
      unheard: "I fixed it and ran the tests. All of them pass.",
    })
  })

  it("everything is unheard when nothing was spoken", () => {
    expect(splitUnheard(REPLY, "")).toEqual({ heard: "", unheard: REPLY })
  })

  it("nothing is set apart when the whole reply was heard", () => {
    expect(splitUnheard(REPLY, REPLY)).toBeNull()
  })

  it("matches speech that left out code, paths, tables and links", () => {
    const content = [
      "I changed the loader.",
      "```ts",
      "const loader = load(path)",
      "```",
      "The details are in `src/loader.ts` and https://example.test/notes.",
      "| a | b |",
      "Now I will run the suite. Then I will report back.",
    ].join("\n")
    const split = splitUnheard(content, "I changed the loader. The details are in. Now I will run the suite.")
    expect(split?.unheard).toBe("Then I will report back.")
    expect(split?.heard.endsWith("Now I will run the suite.")).toBe(true)
  })

  it("keeps a closing punctuation mark and emphasis marker with the heard part", () => {
    const split = splitUnheard("Take the **left door**. Then wait.", "Take the left door")
    expect(split?.heard).toBe("Take the **left door**.")
    expect(split?.unheard).toBe("Then wait.")
  })

  it("never cuts inside a fenced code block", () => {
    const content = "Here is the fix:\n```js\nfoo()\nbar()\n```\nThat is all."
    const split = splitUnheard(content, "Here is the fix")
    expect(split?.heard).toBe("Here is the fix:\n```js\nfoo()\nbar()\n```")
    expect(split?.unheard).toBe("That is all.")
  })

  it("does not trust a match that finds too little of the spoken words", () => {
    expect(splitUnheard(REPLY, "completely different words that never appear in the reply at all")).toBeNull()
  })

  it("tolerates a few reworded words", () => {
    const split = splitUnheard(REPLY, "I found the bug. It is in the configuration loader.")
    expect(split?.unheard).toBe("I fixed it and ran the tests. All of them pass.")
  })

  it("is case and apostrophe insensitive", () => {
    const split = splitUnheard("It’s done. Next step follows.", "it's done")
    expect(split?.unheard).toBe("Next step follows.")
  })
})
