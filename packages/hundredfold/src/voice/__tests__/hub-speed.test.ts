import { describe, expect, it } from "vitest";
import { baseConfig, createHarness } from "./hub-harness.js";

const withSpeed = (speed: number) => baseConfig({ tts: { ...baseConfig().tts, speed } });

describe("the speaking rate (tts.speed)", () => {
  it("speaks at the configured speed, and at the speed 1 when none is set", async () => {
    const fast = createHarness({ config: withSpeed(1.5) });
    fast.connect();
    await fast.reply("Speak this at the faster pace.");
    expect(fast.tts.speeds).toEqual([1.5]);

    const normal = createHarness();
    normal.connect();
    await normal.reply("Speak this at the natural pace.");
    expect(normal.tts.speeds).toEqual([1]);
  });

  it("a change to the config applies to the next reply of the open conversation, with no new connection", async () => {
    const h = createHarness({ config: withSpeed(1) });
    const { socket } = h.connect();
    await h.reply("First reply at the natural pace.");
    h.state.config = withSpeed(1.75);
    await h.reply("Second reply at the quicker pace.");
    h.state.config = withSpeed(0.8);
    await h.reply("Third reply at the slower pace.");
    expect(h.tts.speeds).toEqual([1, 1.75, 0.8]);
    expect(socket.closed).toBeNull();
  });

  it("keeps the speed it had if the config disappears while the conversation winds down", async () => {
    const h = createHarness({ config: withSpeed(1.25) });
    h.connect();
    h.state.config = null;
    await h.reply("Spoken as the conversation ends.");
    expect(h.tts.speeds).toEqual([1.25]);
  });
});
