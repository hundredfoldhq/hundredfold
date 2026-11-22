import { describe, expect, it } from "vitest";
import { RESUME_WINDOW_MS } from "../hub.js";
import { createHarness } from "./hub-harness.js";

/** A voice conversation that ends on a session made for a spoken start, before any message: the hub discards it. */
function harness() {
  const h = createHarness();
  const discarded: string[] = [];
  h.deps.discardIfEmptySpokenStart = (id) => { discarded.push(id); };
  return { h, discarded };
}

describe("a conversation that ends hands its session to the discard port", () => {
  it("bye", () => {
    const { h, discarded } = harness();
    const { attachment } = h.connect();
    attachment.onText(h.json({ type: "bye" }));
    expect(discarded).toEqual(["s1"]);
  });

  it("a clean close", () => {
    const { h, discarded } = harness();
    const { attachment, socket } = h.connect();
    h.hub.socketClosed(attachment, socket, 1000);
    expect(discarded).toEqual(["s1"]);
  });

  it("a vanished client only after the resume window runs out", () => {
    const { h, discarded } = harness();
    const { attachment, socket } = h.connect();
    h.hub.socketClosed(attachment, socket, 1006);
    expect(discarded).toEqual([]);
    h.clock.advance(RESUME_WINDOW_MS);
    expect(discarded).toEqual(["s1"]);
  });

  it("a server detach (voice turned off)", () => {
    const { h, discarded } = harness();
    h.connect();
    h.state.config = null;
    h.hub.checkConfig();
    expect(discarded).toEqual(["s1"]);
  });

  it("not on a takeover by the same principal: the conversation goes on in the new socket", () => {
    const { h, discarded } = harness();
    h.connect();
    const second = h.connect();
    expect(discarded).toEqual([]);
    second.attachment.onText(h.json({ type: "bye" }));
    expect(discarded).toEqual(["s1"]);
  });

  it("a discard that throws is logged and does not break the hub", () => {
    const { h } = harness();
    h.deps.discardIfEmptySpokenStart = () => { throw new Error("disk full"); };
    const { attachment } = h.connect();
    expect(() => attachment.onText(h.json({ type: "bye" }))).not.toThrow();
    expect(h.warnings.join(" ")).toContain("could not discard empty session s1");
    expect(h.hub.size()).toBe(0);
  });
});
