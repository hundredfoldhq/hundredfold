import { describe, expect, it } from "vitest";
import { looksUnfinished } from "../unfinished-speech.js";

describe("looksUnfinished", () => {
  it.each([
    "I would like to book a table and",
    "so what I was thinking is that",
    "Can you check the, um",
    "First, we need to look at the logs,",
    "Well...",
    "send it to the",
    "I'm",
  ])("%j reads as the middle of a thought", (text) => expect(looksUnfinished(text)).toBe(true));

  it.each([
    "",
    "   ",
    "Book me a table.",
    "What time is it?",
    "Stop!",
    "He said \"go.\"",
    "turn the lights off",
    "remind me tomorrow",
  ])("%j reads as finished", (text) => expect(looksUnfinished(text)).toBe(false));
});
