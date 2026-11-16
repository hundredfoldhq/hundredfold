import { describe, it, expect } from "vitest";
import { agentReadableContent, fullMessageMeta, readFullMessageMeta } from "../full-message.js";
import { STRUCTURED_MESSAGE_BODY_MAX_CHARS } from "../types.js";

describe("fullMessageMeta", () => {
  it("keeps a body within the cap as it is, with no length", () => {
    expect(fullMessageMeta("short body")).toEqual({ fullMessage: "short body" });
    const atCap = "x".repeat(STRUCTURED_MESSAGE_BODY_MAX_CHARS);
    expect(fullMessageMeta(atCap)).toEqual({ fullMessage: atCap });
  });

  it("clips a body past the cap and records its real length", () => {
    const body = "x".repeat(STRUCTURED_MESSAGE_BODY_MAX_CHARS + 1);
    expect(fullMessageMeta(body)).toEqual({ fullMessage: body.slice(0, STRUCTURED_MESSAGE_BODY_MAX_CHARS), fullMessageChars: body.length });
  });
});

describe("readFullMessageMeta", () => {
  it("drops a length that does not say the copy is clipped", () => {
    expect(readFullMessageMeta({ fullMessage: "abc", fullMessageChars: 3 })).toEqual({ fullMessage: "abc" });
    expect(readFullMessageMeta({ fullMessage: "abc", fullMessageChars: 2 })).toEqual({ fullMessage: "abc" });
    expect(readFullMessageMeta({ fullMessage: "abc", fullMessageChars: "9" })).toEqual({ fullMessage: "abc" });
    expect(readFullMessageMeta({ fullMessage: "abc", fullMessageChars: 4.5 })).toEqual({ fullMessage: "abc" });
    expect(readFullMessageMeta({ fullMessage: "abc", fullMessageChars: 9 })).toEqual({ fullMessage: "abc", fullMessageChars: 9 });
  });

  it("caps an over-long body and ignores meta with no body", () => {
    const long = "y".repeat(STRUCTURED_MESSAGE_BODY_MAX_CHARS + 10);
    expect(readFullMessageMeta({ fullMessage: long })?.fullMessage).toHaveLength(STRUCTURED_MESSAGE_BODY_MAX_CHARS);
    expect(readFullMessageMeta({ kind: "agent-relay" })).toBeUndefined();
  });
});

describe("agentReadableContent", () => {
  const body = "First line of a long answer.\n\nSecond paragraph that the banner never shows.";

  it("reads a relay as its sender heading and the whole body", () => {
    const message = {
      role: "notification",
      content: "📨 From lead: First line of a long answer. Second…",
      meta: { kind: "agent-relay", fromSessionId: "s-1", fromLabel: "lead", hops: 1, maxHops: 12, fullMessage: body },
    };
    expect(agentReadableContent(message)).toBe(`📨 Message from session s-1 (lead):\n\n${body}`);
  });

  it("reads an operator relay with no source session by its label", () => {
    const message = { role: "notification", content: "📨 From ops: …", meta: { kind: "agent-relay", fromLabel: "ops", fullMessage: body } };
    expect(agentReadableContent(message)).toBe(`📨 Message from ops:\n\n${body}`);
  });

  it("reads a child reply as the banner's first line, the child session and the whole body", () => {
    const message = {
      role: "notification",
      content: "📩 Worker replied\nFirst line of a long answer. Second…",
      meta: { kind: "child-reply", employee: "worker", childSessionId: "c-9", fullMessage: body },
    };
    expect(agentReadableContent(message)).toBe(`📩 Worker replied (child session c-9)\n\n${body}`);
  });

  it("says plainly when the stored body is a clipped copy", () => {
    const message = {
      role: "notification",
      content: "📨 From lead: …",
      meta: { kind: "agent-relay", fromLabel: "lead", fullMessage: "abc", fullMessageChars: 20_500 },
    };
    expect(agentReadableContent(message)).toBe(
      "📨 Message from lead:\n\nabc\n\n[This stored copy holds the first 3 of 20,500 characters. "
      + "The receiving session was handed the whole message when it was delivered.]",
    );
  });

  it("leaves everything else as stored", () => {
    expect(agentReadableContent({ role: "assistant", content: "hello", meta: { fullMessage: "other" } })).toBe("hello");
    expect(agentReadableContent({ role: "user", content: "typed" })).toBe("typed");
    expect(agentReadableContent({ role: "notification", content: "banner only" })).toBe("banner only");
    expect(agentReadableContent({ role: "notification", content: "banner", meta: { fullMessage: "   " } })).toBe("banner");
    expect(agentReadableContent({ role: "notification", content: "banner", meta: ["fullMessage"] })).toBe("banner");
    expect(agentReadableContent({ role: "notification", content: undefined })).toBe("");
  });
});
