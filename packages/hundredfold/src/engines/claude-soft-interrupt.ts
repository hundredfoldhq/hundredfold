import type { HookPayload } from "../gateway/hook-registry.js";
import type { BackgroundedWork, ForegroundWork } from "../shared/types.js";

/**
 * Ending a Claude Code turn without ending its process, and without ending the
 * work the turn started. Verified against Claude Code 2.1.330 in a PTY:
 *
 * - Esc alone ends the turn and SIGTERMs a foreground Bash. The process stays,
 *   but the command is gone and nothing ever wakes the session.
 * - Ctrl+B moves the running Bash to a background task (its PostToolUse reports
 *   `backgroundTaskId` and `backgroundedByUser`). Esc after it ends the turn;
 *   the command runs on, and a `<task-notification>` wakes the session when it
 *   ends. `CLAUDE_AUTO_BACKGROUND_TASKS` changes none of this: it only arms the
 *   timer that backgrounds a command after 120 s.
 * - Ctrl+B is ignored until the command has been running for about four seconds (checked at
 *   one, three and four seconds after its PreToolUse). Pressing it again every 700 ms until the
 *   task id arrives is harmless: five presses moved one command once.
 * - Esc fires no Stop hook, so the engine has to settle the turn itself.
 * - When the model has produced nothing yet, Esc puts the turn's prompt back in
 *   the composer, and the next paste then lands behind it.
 */

/** Ctrl+B: Claude Code moves the running foreground command to the background. */
export const BACKGROUND_KEY = "\x02";
/** Esc: Claude Code ends the running turn. */
export const INTERRUPT_KEY = "\x1b";

/** How long Ctrl+B is given to show up as a PostToolUse carrying the task id. Claude Code ignores
 *  Ctrl+B until the command has run for about four seconds, so this has to outlast that. */
export const BACKGROUND_ACK_MS = 6_000;
/** How often Ctrl+B is pressed again while no task id has come. A press that took effect, or one pressed
 *  with nothing in the foreground, does nothing, so a repeat costs nothing. */
export const BACKGROUND_RETRY_MS = 700;
/** How long, after Esc, the TUI is given to stop showing a running turn. */
export const INTERRUPT_SETTLE_MS = 3_000;
/** How often the screen and the hook stream are looked at while waiting. */
export const SOFT_INTERRUPT_POLL_MS = 50;

/** Tools Ctrl+B moves to the background and that keep running there (verified for Bash). */
const BACKGROUNDABLE_TOOLS = new Set(["Bash"]);

const DESCRIPTION_MAX = 200;

interface ForegroundCall extends ForegroundWork {
  toolUseId: string;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, DESCRIPTION_MAX) : null;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** What a tool call is doing, in a few words: its description, else its command. */
function describeCall(h: HookPayload): string | null {
  const input = recordOf((h as Record<string, unknown>).tool_input);
  return text(input?.description) ?? text(input?.command);
}

/**
 * The tool calls a turn has running in the foreground: a PreToolUse seen and no
 * PostToolUse yet. A call a sub-agent makes (its hooks carry `agent_id`) is not
 * the turn's own.
 */
export class ForegroundCalls {
  private readonly calls = new Map<string, ForegroundCall>();
  private anonymous = 0;

  /** Feed one hook of the turn this tracks. */
  onHook(h: HookPayload, now: number = Date.now()): void {
    if (typeof h.agent_id === "string") return;
    if (h.hook_event_name === "PreToolUse") this.started(h, now);
    else if (h.hook_event_name === "PostToolUse") this.ended(h);
  }

  private started(h: HookPayload, now: number): void {
    const key = typeof h.tool_use_id === "string" ? h.tool_use_id : `anonymous-${this.anonymous++}`;
    this.calls.set(key, {
      toolUseId: key,
      tool: typeof h.tool_name === "string" ? h.tool_name : "unknown",
      startedAt: now,
      description: describeCall(h),
    });
  }

  private ended(h: HookPayload): void {
    if (typeof h.tool_use_id === "string") this.calls.delete(h.tool_use_id);
    else this.dropOldestOf(typeof h.tool_name === "string" ? h.tool_name : undefined);
  }

  /** The call that has run longest, as the contract reports it. */
  oldest(): ForegroundWork | null {
    let oldest: ForegroundCall | undefined;
    for (const call of this.calls.values()) {
      if (!oldest || call.startedAt < oldest.startedAt) oldest = call;
    }
    return oldest ? { tool: oldest.tool, startedAt: oldest.startedAt, description: oldest.description } : null;
  }

  /** Ids of the running calls Ctrl+B moves to the background. */
  backgroundable(): string[] {
    return [...this.calls.values()].filter((c) => BACKGROUNDABLE_TOOLS.has(c.tool)).map((c) => c.toolUseId);
  }

  clear(): void {
    this.calls.clear();
  }

  private dropOldestOf(tool: string | undefined): void {
    for (const [key, call] of this.calls) {
      if (key.startsWith("anonymous-") && (tool === undefined || call.tool === tool)) {
        this.calls.delete(key);
        return;
      }
    }
  }
}

/** The task a backgrounded call's PostToolUse reports, or null for any other hook. */
export function backgroundedByPostToolUse(h: HookPayload): (BackgroundedWork & { toolUseId: string | null }) | null {
  if (h.hook_event_name !== "PostToolUse" || typeof h.agent_id === "string") return null;
  const taskId = recordOf((h as Record<string, unknown>).tool_response)?.backgroundTaskId;
  if (typeof taskId !== "string" || !taskId) return null;
  return { taskId, description: describeCall(h), toolUseId: typeof h.tool_use_id === "string" ? h.tool_use_id : null };
}

/** Claude Code shows "esc to interrupt" in its footer for exactly as long as a turn runs. */
export function viewportShowsTurnRunning(viewport: readonly string[]): boolean {
  return viewport.some((row) => /esc to interrupt/i.test(row));
}

/** What the composer needs to be emptied of a turn's prompt put back there: Ctrl+U per line, twice over. */
export function composerClearKeys(promptLines: number): string {
  return "\x15".repeat(2 * Math.max(1, promptLines));
}
