import { describe, it, expect } from "vitest";
import { TurnResolver } from "../claude-interactive.js";
import type { HookPayload } from "../../gateway/hook-registry.js";

/**
 * A call that fails fires PostToolUseFailure and no PostToolUse, so wherever the resolver reads a
 * tool boundary out of PostToolUse (a re-run folding our queued prompt in, hooks of a re-run ahead
 * of our prompt, our own turn beginning to run) the failure is the same boundary.
 */
const NOTIFICATION = "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>";
const bgPrompt = (): HookPayload => ({ hook_event_name: "UserPromptSubmit", prompt: NOTIFICATION });
const prompt = (text: string): HookPayload => ({ hook_event_name: "UserPromptSubmit", prompt: text });
const stop = (text: string): HookPayload => ({ hook_event_name: "Stop", session_id: "sid", last_assistant_message: text });
const pre: HookPayload = { hook_event_name: "PreToolUse", tool_name: "Bash" };

describe.each(["PostToolUse", "PostToolUseFailure"])("TurnResolver — a tool call that ends with %s", (endEvent) => {
  const end: HookPayload = { hook_event_name: endEvent, tool_name: "Bash" };
  const settled = (r: TurnResolver) => { let v: { result?: string } | undefined; void r.promise.then((x) => { v = x; }); return () => v; };

  it("is the boundary at which a re-run folds our queued prompt in: its one Stop is ours", async () => {
    const r = new TurnResolver({ fallbackSessionId: "sid", assumeStarted: true });
    const get = settled(r);
    expect(r.onHook(bgPrompt())).toBe("foreign");
    expect(r.onHook(prompt("mine"))).toBe("own");
    expect(r.awaitingBackgroundRerun).toBe(true);
    r.onHook(pre);
    r.onHook(end);
    expect(r.awaitingBackgroundRerun).toBe(false);
    expect(r.onHook(stop("BGDONE"))).toBe("own");
    await Promise.resolve();
    expect(get()?.result).toBe("BGDONE");
  });

  it("belongs to the re-run while our prompt has not been submitted", () => {
    const r = new TurnResolver({ fallbackSessionId: "sid", assumeStarted: true, backgroundRerunInProgress: true });
    expect(r.onHook(pre)).toBe("foreign");
    expect(r.onHook(end)).toBe("foreign");
    expect(r.awaitingBackgroundRerun).toBe(true);
  });

  it("shows our own turn running, so a notification folded into it keeps its Stop ours", async () => {
    // Our prompt queued behind a re-run that then ended: nothing marked our turn running until its first tool boundary.
    const r = new TurnResolver({ fallbackSessionId: "sid", assumeStarted: true });
    const get = settled(r);
    r.onHook(bgPrompt());
    r.onHook(prompt("mine"));
    r.onHook(stop("BG1"));
    expect(r.awaitingBackgroundRerun).toBe(false);
    // The end of a call whose PreToolUse this turn did not see (it fired before the turn registered).
    r.onHook(end);
    // A task finishing now is folded into our running turn.
    expect(r.onHook(bgPrompt())).toBe("own");
    expect(r.onHook(stop("TURNDONE\n\nBGSEEN"))).toBe("own");
    await Promise.resolve();
    expect(get()?.result).toBe("TURNDONE\n\nBGSEEN");
  });
});
