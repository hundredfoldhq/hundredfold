/**
 * OpenCode 2's server events and stored messages, read as the lines
 * `OpencodeTurn` already understands.
 *
 * OpenCode 2 (`/api/*`) reports a turn as a stream of fine-grained session
 * events rather than 1.x's `message.part.updated` Part objects: a step starts,
 * text streams and ends, a tool is called and succeeds or fails, a step ends
 * with its cost and tokens. What a turn MEANS (the answer, tool calls,
 * accounting, errors, rate-limit classification) is still decided by the one
 * parser both 1.x transports feed, so this module turns each v2 event into the
 * `opencode run --format json` line 1.x would have printed for it:
 *
 * | v2 event                      | line         |
 * |-------------------------------|--------------|
 * | session.text.ended            | text         |
 * | session.reasoning.ended       | reasoning    |
 * | session.tool.called           | tool_use (running) |
 * | session.tool.success / failed | tool_use     |
 * | session.step.ended            | step_finish  |
 * | session.step.failed           | error        |
 * | session.execution.failed      | error        |
 *
 * Verified against 2.0.29's real event stream and message store.
 */

import type { ForegroundWork } from "../shared/types.js";

/** One event from `GET /api/event`. */
export interface V2Event {
  type: string;
  created?: number;
  data?: Record<string, unknown>;
}

/** One item of `GET /api/session/:id/message`: a user prompt, an assistant
 *  reply, an `idle` marking the end of an execution, a compaction, … */
export type V2Message = Record<string, unknown>;

export function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** The text of a tool result's content blocks. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.map(record).filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c!.text as string).join("\n");
}

/** A v2 error (`{type, message, status?}`) in the shape the 1.x parser reads:
 *  its type as the name, so `provider.rate-limit` still reads as a rate limit. */
export function v2ErrorLine(sessionId: string, error: Record<string, unknown>): string {
  const status = typeof error.status === "number" ? ` (HTTP ${error.status})` : "";
  const message = `${str(error.message) ?? "no message"}${status}`;
  return JSON.stringify({ type: "error", sessionID: sessionId, error: { name: str(error.type) ?? "error", data: { message } } });
}

/** An error that is a stop, not a failure: the turn's own interrupt. */
export function isAbortError(error: Record<string, unknown> | undefined): boolean {
  return str(error?.type) === "aborted";
}

function textLine(sessionId: string, messageId: string, ordinal: unknown, text: string, end: number): string {
  return JSON.stringify({
    type: "text",
    sessionID: sessionId,
    part: { id: `${messageId}#${String(ordinal ?? 0)}`, messageID: messageId, type: "text", text, time: { end } },
  });
}

/** A tool call as the turn reports it: running with its input, or finished with its output too. */
interface ToolReport {
  callId: string;
  messageId: string;
  name: string | undefined;
  input: unknown;
  status: "running" | "completed" | "error";
  output?: string;
  /** The change an edit made, as a unified diff, in the place a 1.x edit reports it. */
  diff?: string;
}

type ToolResult = ToolReport & { status: "completed" | "error"; output: string };

function toolLine(sessionId: string, tool: ToolReport): string {
  return JSON.stringify({
    type: "tool_use",
    sessionID: sessionId,
    part: {
      id: tool.callId,
      callID: tool.callId,
      messageID: tool.messageId,
      type: "tool",
      ...(tool.name ? { tool: tool.name } : {}),
      state: {
        status: tool.status,
        input: record(tool.input) ?? {},
        ...(tool.output !== undefined ? { output: tool.output } : {}),
        ...(tool.diff ? { metadata: { diff: tool.diff } } : {}),
      },
    },
  });
}

function reasoningLine(sessionId: string, messageId: string, ordinal: unknown, text: string, end: number): string {
  return JSON.stringify({
    type: "reasoning",
    sessionID: sessionId,
    part: { id: `${messageId}#reasoning${String(ordinal ?? 0)}`, messageID: messageId, type: "reasoning", text, time: { end } },
  });
}

function stepFinishLine(sessionId: string, data: Record<string, unknown>): string {
  return JSON.stringify({
    type: "step_finish",
    sessionID: sessionId,
    part: { type: "step-finish", cost: data.cost, tokens: data.tokens, reason: data.finish },
  });
}

/**
 * The translation for one turn. Stateful only because a tool's name and input
 * arrive on earlier events than its result, and 1.x reports a tool once, with
 * all three.
 */
export class V2RunLines {
  private readonly toolNames = new Map<string, string>();
  private readonly toolInputs = new Map<string, unknown>();
  /** Reasoning streamed so far, by block, for a block that ends without carrying its text. */
  private readonly reasoning = new Map<string, string>();
  /** Text streamed so far in a block that has not ended, by block. */
  private readonly openText = new Map<string, { messageId: string; ordinal: unknown; text: string }>();
  /** Blocks whose text was reported ahead of a call, so their end reports nothing more. */
  private readonly reportedText = new Set<string>();

  constructor(private readonly sessionId: string) {}

  /** What each event the translation reads turns into. */
  private readonly readers: Record<string, (data: Record<string, unknown>, event: V2Event) => string | undefined> = {
    "session.tool.input.started": (data) => {
      if (str(data.id) && str(data.name)) this.toolNames.set(data.id as string, data.name as string);
      return undefined;
    },
    // The call starts running: report it with its input, as 1.x does once a tool part runs.
    "session.tool.called": (data) => this.toolCalled(data),
    "session.tool.success": (data) => this.toolResult(true, data),
    "session.tool.failed": (data) => this.toolResult(false, data),
    "session.text.delta": (data) => {
      const chunk = str(data.delta);
      if (!chunk) return undefined;
      const key = textKey(data);
      const open = this.openText.get(key) ?? { messageId: str(data.assistantMessageID) ?? "", ordinal: data.ordinal, text: "" };
      this.openText.set(key, { ...open, text: open.text + chunk });
      return undefined;
    },
    "session.text.ended": (data, event) => {
      const key = textKey(data);
      this.openText.delete(key);
      if (this.reportedText.delete(key)) return undefined;
      return typeof data.text === "string" && data.text
        ? textLine(this.sessionId, str(data.assistantMessageID) ?? "", data.ordinal, data.text, numberOr(event.created, Date.now()))
        : undefined;
    },
    "session.reasoning.delta": (data) => {
      const key = reasoningKey(data);
      const chunk = str(data.delta) ?? str(data.text);
      if (chunk) this.reasoning.set(key, (this.reasoning.get(key) ?? "") + chunk);
      return undefined;
    },
    "session.reasoning.ended": (data, event) => this.reasoningEnded(data, event),
    "session.step.ended": (data) => stepFinishLine(this.sessionId, data),
    "session.step.failed": (data) => this.errorLine(data),
    "session.execution.failed": (data) => this.errorLine(data),
  };

  /**
   * The lines for one of the turn's own events, in order; none when `run` would print nothing
   * for it. A call starts before the text that introduced it has ended, so the text streamed so
   * far is reported first, as a 1.x stream would have it, and that text's end reports nothing.
   */
  linesFor(event: V2Event): string[] {
    const data = event.data ?? {};
    const lead = event.type === "session.tool.called" ? this.textAheadOfCall(event) : [];
    const line = this.readers[event.type]?.(data, event);
    return line === undefined ? lead : [...lead, line];
  }

  private textAheadOfCall(event: V2Event): string[] {
    const lines: string[] = [];
    for (const [key, open] of this.openText) {
      this.openText.delete(key);
      if (!open.text) continue;
      this.reportedText.add(key);
      lines.push(textLine(this.sessionId, open.messageId, open.ordinal, open.text, numberOr(event.created, Date.now())));
    }
    return lines;
  }

  private toolCalled(data: Record<string, unknown>): string | undefined {
    const callId = str(data.id);
    if (!callId) return undefined;
    this.toolInputs.set(callId, data.input);
    return toolLine(this.sessionId, {
      callId,
      messageId: str(data.assistantMessageID) ?? "",
      name: this.toolNames.get(callId),
      input: data.input,
      status: "running",
    });
  }

  private reasoningEnded(data: Record<string, unknown>, event: V2Event): string | undefined {
    const key = reasoningKey(data);
    const text = (str(data.text) ?? this.reasoning.get(key) ?? "").trim();
    this.reasoning.delete(key);
    return text ? reasoningLine(this.sessionId, str(data.assistantMessageID) ?? "", data.ordinal, text, numberOr(event.created, Date.now())) : undefined;
  }

  private errorLine(data: Record<string, unknown>): string | undefined {
    const error = record(data.error);
    return error && !isAbortError(error) ? v2ErrorLine(this.sessionId, error) : undefined;
  }

  private toolResult(ok: boolean, data: Record<string, unknown>): string | undefined {
    const callId = str(data.id);
    if (!callId) return undefined;
    const error = record(data.error);
    return toolLine(this.sessionId, {
      callId,
      messageId: str(data.assistantMessageID) ?? "",
      name: this.toolNames.get(callId),
      input: this.toolInputs.get(callId),
      status: ok ? "completed" : "error",
      output: ok ? contentText(data.content) : str(error?.message) ?? "the tool failed",
      ...(ok ? filePatch(data.metadata) : {}),
    });
  }
}

function textKey(data: Record<string, unknown>): string {
  return `${str(data.assistantMessageID) ?? ""}#${String(data.ordinal ?? 0)}`;
}

function reasoningKey(data: Record<string, unknown>): string {
  return `${str(data.assistantMessageID) ?? ""}#${String(data.ordinal ?? str(data.id) ?? 0)}`;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * The lines for an assistant message as the store keeps it: the recovery path
 * when the stream did not carry a reply. Its content holds the same text and
 * tool results the stream reported, finished.
 */
export function runLinesFromStoredReply(sessionId: string, message: V2Message): string[] {
  const messageId = str(message.id) ?? "";
  const completed = numberOr(record(message.time)?.completed, 0);
  const content = Array.isArray(message.content) ? message.content : [];
  const lines = content.flatMap((item, ordinal) => storedBlockLines(sessionId, messageId, record(item) ?? {}, { ordinal, completed }));
  if (completed && message.tokens) lines.push(stepFinishLine(sessionId, message));
  const error = record(message.error);
  if (error && !isAbortError(error)) lines.push(v2ErrorLine(sessionId, error));
  return lines;
}

/** The line for one content block of a stored reply: its text, or a tool
 *  that has its result. */
function storedBlockLines(
  sessionId: string,
  messageId: string,
  block: Record<string, unknown>,
  at: { ordinal: number; completed: number },
): string[] {
  if (block.type === "text") {
    return typeof block.text === "string" && block.text ? [textLine(sessionId, messageId, at.ordinal, block.text, at.completed)] : [];
  }
  if (block.type === "reasoning") {
    const text = typeof block.text === "string" ? block.text.trim() : "";
    return text ? [reasoningLine(sessionId, messageId, at.ordinal, text, at.completed)] : [];
  }
  const tool = block.type === "tool" ? storedToolResult(messageId, block) : undefined;
  return tool ? [toolLine(sessionId, tool)] : [];
}

/** A stored tool block that has its result, as the stream reports one. */
function storedToolResult(messageId: string, block: Record<string, unknown>): ToolResult | undefined {
  const state = record(block.state) ?? {};
  const status = str(state.status);
  const callId = str(block.id);
  if (!callId || (status !== "completed" && status !== "error")) return undefined;
  const output = status === "completed" ? contentText(state.content) : str(record(state.error)?.message) ?? "the tool failed";
  return { callId, messageId, name: str(block.name), input: state.input, status, output, ...(status === "completed" ? filePatch(state.metadata) : {}) };
}

/** A 2.x edit's change: the patch of the one file it touched. A change across several files is left out. */
function filePatch(metadata: unknown): { diff?: string } {
  const files = record(metadata)?.files;
  if (!Array.isArray(files) || files.length !== 1) return {};
  const patch = str(record(files[0])?.patch);
  return patch ? { diff: patch } : {};
}

/** Whether a stored reply ends its turn: completed, and finished for a reason
 *  other than a tool round trip or an error (1.x's `replyIsDone`). */
export function v2ReplyIsDone(message: V2Message): boolean {
  const finish = str(message.finish);
  return Boolean(record(message.time)?.completed) && Boolean(finish) && finish !== "tool-calls" && finish !== "unknown" && finish !== "error";
}

const DESCRIPTION_MAX = 200;

function clipped(value: unknown): string | null {
  const text = str(value)?.trim();
  return text ? text.slice(0, DESCRIPTION_MAX) : null;
}

/**
 * The tool calls a turn's own steps have running: from `session.tool.called`, when the tool starts
 * executing (its input has been streamed by then, and that is the model talking, not work), to
 * `session.tool.success` or `session.tool.failed`. A tool a step never finished (the step failed or
 * was aborted) is dropped with the step. Feeds the voice hub's long-work check.
 */
export class V2ForegroundTools {
  private readonly names = new Map<string, string>();
  private readonly running = new Map<string, Omit<ForegroundWork, "backgroundable">>();
  private readonly readers: Record<string, (id: string, data: Record<string, unknown>, now: number) => void> = {
    "session.tool.input.started": (id, data) => {
      const name = str(data.name);
      if (name) this.names.set(id, name);
    },
    "session.tool.called": (id, data, now) => {
      const input = record(data.input);
      this.running.set(id, {
        tool: this.names.get(id) ?? "tool",
        startedAt: now,
        description: clipped(input?.description) ?? clipped(input?.command),
      });
    },
    "session.tool.success": (id) => { this.running.delete(id); },
    "session.tool.failed": (id) => { this.running.delete(id); },
  };

  /** One event of the turn's own steps. */
  onEvent(event: V2Event, now: number = Date.now()): void {
    const data = event.data ?? {};
    const id = str(data.id);
    if (id) this.readers[event.type]?.(id, data, now);
  }

  /** The call that has run longest. */
  oldest(): ForegroundWork | null {
    let oldest: Omit<ForegroundWork, "backgroundable"> | null = null;
    for (const call of this.running.values()) {
      if (!oldest || call.startedAt < oldest.startedAt) oldest = call;
    }
    // No soft interrupt here: nothing is backgrounded, so nothing is backgroundable.
    return oldest ? { ...oldest, backgroundable: false } : null;
  }

  /** A step ended, failed or was aborted: no call of it is running any more. */
  clear(): void {
    this.running.clear();
  }
}
