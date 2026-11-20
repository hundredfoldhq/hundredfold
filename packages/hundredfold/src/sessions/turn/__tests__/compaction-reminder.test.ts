import { beforeEach, describe, expect, it } from "vitest";
import { BOARD_REMINDER_LABEL, DEFAULT_BOARD_REMINDER } from "../board-reminder.js";
import { compactionHookOutput, rememberCompactionReminder, resetCompactionRemindersForTests } from "../compaction-reminder.js";

const compact = { hook_event_name: "SessionStart", source: "compact" };

beforeEach(resetCompactionRemindersForTests);

describe("the reminder a compacted Claude session is given back", () => {
  it("answers the SessionStart that follows a compaction with the labelled reminder the turn carried", () => {
    rememberCompactionReminder("s1", DEFAULT_BOARD_REMINDER);
    expect(compactionHookOutput("s1", compact)).toEqual({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: `${BOARD_REMINDER_LABEL} ${DEFAULT_BOARD_REMINDER}` },
    });
  });

  it("says it again after every compaction, not only the first", () => {
    rememberCompactionReminder("s1", "Board: one.");
    expect(compactionHookOutput("s1", compact)).toBeDefined();
    expect(compactionHookOutput("s1", compact)).toBeDefined();
  });

  it.each(["startup", "resume", "clear", undefined])("says nothing to a SessionStart whose source is %s", (source) => {
    rememberCompactionReminder("s1", "Board: one.");
    expect(compactionHookOutput("s1", { hook_event_name: "SessionStart", ...(source ? { source } : {}) })).toBeUndefined();
  });

  it.each(["Stop", "PostCompact", "PreToolUse"])("says nothing to a %s hook, whatever its source", (name) => {
    rememberCompactionReminder("s1", "Board: one.");
    expect(compactionHookOutput("s1", { hook_event_name: name, source: "compact" })).toBeUndefined();
  });

  it("says nothing for a session that never ran a turn, or whose turn carried no reminder", () => {
    expect(compactionHookOutput("unknown", compact)).toBeUndefined();
    rememberCompactionReminder("s1", "Board: one.");
    rememberCompactionReminder("s1", undefined);
    expect(compactionHookOutput("s1", compact)).toBeUndefined();
  });

  it("keeps each session's own reminder, and the newest turn's for a session", () => {
    rememberCompactionReminder("s1", "Board: one.");
    rememberCompactionReminder("s2", "Board: two.");
    rememberCompactionReminder("s1", "Board: three.");
    expect(compactionHookOutput("s1", compact)?.hookSpecificOutput.additionalContext).toBe(`${BOARD_REMINDER_LABEL} Board: three.`);
    expect(compactionHookOutput("s2", compact)?.hookSpecificOutput.additionalContext).toBe(`${BOARD_REMINDER_LABEL} Board: two.`);
  });

  it("forgets the longest-idle sessions rather than growing without bound", () => {
    for (let i = 0; i < 2100; i++) rememberCompactionReminder(`s${i}`, "Board.");
    expect(compactionHookOutput("s0", compact)).toBeUndefined();
    expect(compactionHookOutput("s2099", compact)).toBeDefined();
  });
});
