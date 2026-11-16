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
  it("keeps a length only on a copy cut at the cap that says it is longer", () => {
    const atCap = "x".repeat(STRUCTURED_MESSAGE_BODY_MAX_CHARS);
    expect(readFullMessageMeta({ fullMessage: atCap, fullMessageChars: STRUCTURED_MESSAGE_BODY_MAX_CHARS })).toEqual({ fullMessage: atCap });
    expect(readFullMessageMeta({ fullMessage: atCap, fullMessageChars: "20000" })).toEqual({ fullMessage: atCap });
    expect(readFullMessageMeta({ fullMessage: atCap, fullMessageChars: 20000.5 })).toEqual({ fullMessage: atCap });
    expect(readFullMessageMeta({ fullMessage: atCap, fullMessageChars: 20000 })).toEqual({ fullMessage: atCap, fullMessageChars: 20000 });
    // A short body cannot be a clipped copy, whatever its meta says.
    expect(readFullMessageMeta({ fullMessage: "abc", fullMessageChars: 9 })).toEqual({ fullMessage: "abc" });
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

  it("reads an operator relay as relayed via the operator, as the engine read it", () => {
    const bare = { role: "notification", content: "📨 From ops: …", meta: { kind: "agent-relay", fromLabel: "ops", viaOperator: true, fullMessage: body } };
    expect(agentReadableContent(bare)).toBe(`📨 Message relayed from ops via the operator:\n\n${body}`);
    const sourced = { ...bare, meta: { ...bare.meta, fromSessionId: "s-2" } };
    expect(agentReadableContent(sourced)).toBe(`📨 Message relayed from session s-2 (ops) via the operator:\n\n${body}`);
    const unflagged = { ...bare, meta: { kind: "agent-relay", fromLabel: "ops", fullMessage: body } };
    expect(agentReadableContent(unflagged)).toBe(`📨 Message from ops:\n\n${body}`);
  });

  it("reads a child reply as the banner's first line, the child session and the whole body", () => {
    const message = {
      role: "notification",
      content: "📩 Worker replied\nFirst line of a long answer. Second…",
      meta: { kind: "child-reply", employee: "worker", childSessionId: "c-9", fullMessage: body },
    };
    expect(agentReadableContent(message)).toBe(`📩 Worker replied (child session c-9)\n\n${body}`);
  });

  const atCap = "z".repeat(STRUCTURED_MESSAGE_BODY_MAX_CHARS);

  it("says plainly when a relay's stored body is a clipped copy, without claiming it was delivered", () => {
    const message = {
      role: "notification",
      content: "📨 From lead: …",
      meta: { kind: "agent-relay", fromLabel: "lead", fullMessage: atCap, fullMessageChars: 20_500 },
    };
    expect(agentReadableContent(message)).toBe(
      `📨 Message from lead:\n\n${atCap}\n\n[This stored copy holds the first 16,000 of 20,500 characters. `
      + "The whole message goes to the receiving session's engine; only this copy is kept to read back.]",
    );
  });

  it.each(["child-reply", "child-error"])("points a clipped %s at the child session for the full text", (kind) => {
    const message = {
      role: "notification",
      content: "📩 Worker replied\nzzz…",
      meta: { kind, employee: "worker", childSessionId: "c-9", fullMessage: atCap, fullMessageChars: 200_000 },
    };
    expect(agentReadableContent(message)).toBe(
      `📩 Worker replied (child session c-9)\n\n${atCap}\n\n[This stored copy holds the first 16,000 of 200,000 characters. `
      + `The full text is in child session c-9: read_session { sessionId: "c-9" }.]`,
    );
  });

  it("says a copy stored before lengths were kept may be clipped when it fills the cap", () => {
    const relay = { role: "notification", content: "📨 From lead: …", meta: { kind: "agent-relay", fromLabel: "lead", fullMessage: atCap } };
    expect(agentReadableContent(relay)).toBe(
      `📨 Message from lead:\n\n${atCap}\n\n[This stored copy holds the first 16,000 characters and may have been clipped. `
      + "The whole message goes to the receiving session's engine; only this copy is kept to read back.]",
    );
    const justUnder = { ...relay, meta: { ...relay.meta, fullMessage: atCap.slice(1) } };
    expect(agentReadableContent(justUnder)).toBe(`📨 Message from lead:\n\n${atCap.slice(1)}`);
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
