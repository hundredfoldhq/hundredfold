import type { JsonObject, JsonValue } from "./types.js";
import { redactJson, redactText } from "./redact.js";

/**
 * What the chat card of a tool call shows beyond its name: the input it was called
 * with, the output it returned and whether it failed. It rides a stream delta
 * and is stored on the tool row's `meta.tool`, so a reload draws the same card
 * the live view did. Every part is redacted and bounded here, once, because both
 * the live stream and the transcript read it: a long session carries one of these
 * per call, and a call's input or output can be a whole file.
 */
export type ToolDetail = JsonObject & {
  input?: JsonObject;
  output?: string;
  isError?: boolean;
  /** Part of the input was cut: a long string, or fields past the budget. */
  inputTruncated?: boolean;
  /** How long the output was before it was cut; absent when it all fit. */
  outputChars?: number;
};

/** Longest string kept inside a call's input (a command, a file body, an edit's old text). */
export const TOOL_INPUT_STRING_MAX = 1_200;
/** What the whole input may serialise to, once every string is cut. */
export const TOOL_INPUT_TOTAL_MAX = 4_000;
export const TOOL_OUTPUT_MAX = 3_000;
const TOOL_INPUT_ARRAY_MAX = 20;
const TOOL_INPUT_DEPTH_MAX = 4;

function clip(text: string, max: number): { text: string; cut: boolean } {
  return text.length > max ? { text: `${text.slice(0, max)}…`, cut: true } : { text, cut: false };
}

interface Budget {
  cut: boolean;
}

function boundString(value: string, budget: Budget): string {
  const { text, cut } = clip(redactText(value), TOOL_INPUT_STRING_MAX);
  if (cut) budget.cut = true;
  return text;
}

function boundList(value: unknown[], depth: number, budget: Budget): JsonValue[] {
  if (value.length > TOOL_INPUT_ARRAY_MAX) budget.cut = true;
  return value.slice(0, TOOL_INPUT_ARRAY_MAX).map((item) => boundValue(item, depth + 1, budget));
}

function boundFields(value: Record<string, unknown>, depth: number, budget: Budget): JsonObject {
  const out: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = boundValue(item, depth + 1, budget);
  }
  return out;
}

function boundValue(value: unknown, depth: number, budget: Budget): JsonValue {
  if (typeof value === "string") return boundString(value, budget);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (value === undefined) return null;
  if (typeof value !== "object") return String(value);
  if (depth >= TOOL_INPUT_DEPTH_MAX) {
    budget.cut = true;
    return "…";
  }
  return Array.isArray(value) ? boundList(value, depth, budget) : boundFields(value as Record<string, unknown>, depth, budget);
}

/**
 * A tool call's input, safe to show: secret-looking keys and token shapes
 * redacted, every string cut, and the whole kept under a budget.
 */
export function boundToolInput(input: unknown): { input: JsonObject; truncated: boolean } | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length === 0) return undefined;
  const budget: Budget = { cut: false };
  const bounded = boundValue(redactJson(input), 0, budget) as JsonObject;
  const size = JSON.stringify(bounded).length;
  if (size <= TOOL_INPUT_TOTAL_MAX) return { input: bounded, truncated: budget.cut };
  // Many mid-sized fields: keep leading fields whole until the budget is spent.
  const kept: JsonObject = {};
  let used = 2;
  for (const [key, value] of Object.entries(bounded)) {
    const cost = key.length + JSON.stringify(value).length + 4;
    if (used + cost > TOOL_INPUT_TOTAL_MAX) break;
    kept[key] = value;
    used += cost;
  }
  return { input: kept, truncated: true };
}

function textBlocks(blocks: unknown[]): string {
  return blocks
    .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
      ? (part as { text: string }).text
      : typeof part === "string" ? part : ""))
    .filter(Boolean)
    .join("\n");
}

/** The stream a person reads of a structured result: stdout (with stderr after it), or the first text field. */
function streamText(record: Record<string, unknown>): string | undefined {
  for (const key of ["stdout", "output", "text", "result", "content"]) {
    const value = record[key];
    if (typeof value !== "string" || !value) continue;
    const stderr = key === "stdout" && typeof record.stderr === "string" && record.stderr ? `\n${record.stderr}` : "";
    return `${value}${stderr}`;
  }
  return undefined;
}

/** Claude's built-in tools answer with a structured object; the part worth keeping is what a person reads. */
function structuredText(record: Record<string, unknown>): string | undefined {
  const stream = streamText(record);
  if (stream !== undefined) return stream;
  const fileContent = (record.file as { content?: unknown } | undefined)?.content;
  if (typeof fileContent === "string") return fileContent;
  return Array.isArray(record.filenames) ? record.filenames.filter((name) => typeof name === "string").join("\n") : undefined;
}

function objectText(record: Record<string, unknown>): string {
  if (Array.isArray(record.content)) return textBlocks(record.content);
  // An Edit or Write answers with the file's old and new bodies: the card draws the change from the input.
  if ("structuredPatch" in record || "originalFile" in record) return "";
  const text = structuredText(record);
  if (text !== undefined) return text;
  try {
    return JSON.stringify(redactJson(record));
  } catch {
    return "";
  }
}

/** The text of a tool result: a string, or the text blocks of a list, or the object as JSON. */
export function toolOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return textBlocks(output);
  if (output && typeof output === "object") return objectText(output as Record<string, unknown>);
  return output === undefined || output === null ? "" : String(output);
}

/** A tool result, redacted and cut; `chars` is the length before the cut, when there was one. */
export function boundToolOutput(output: unknown): { output: string; chars?: number } | undefined {
  const raw = toolOutputText(output);
  if (!raw) return undefined;
  const redacted = redactText(raw);
  const { text, cut } = clip(redacted, TOOL_OUTPUT_MAX);
  return { output: text, ...(cut ? { chars: redacted.length } : {}) };
}

/** The detail of one call's start: its input, when the engine has it yet. */
export function toolStartDetail(input: unknown): ToolDetail | undefined {
  const bounded = boundToolInput(input);
  return bounded ? { input: bounded.input, ...(bounded.truncated ? { inputTruncated: true } : {}) } : undefined;
}

/** The detail of one call's end: its output and failure, and the input again when the start never had it. */
export function toolEndDetail(parts: { input?: unknown; output?: unknown; isError?: boolean }): ToolDetail | undefined {
  const start = toolStartDetail(parts.input);
  const bounded = boundToolOutput(parts.output);
  const detail: ToolDetail = {
    ...(start ?? {}),
    ...(bounded ? { output: bounded.output, ...(bounded.chars !== undefined ? { outputChars: bounded.chars } : {}) } : {}),
    ...(parts.isError ? { isError: true } : {}),
  };
  return Object.keys(detail).length > 0 ? detail : undefined;
}

/** `later` laid over `earlier`: a result's detail refines what the start already stored. */
export function mergeToolDetail(earlier: ToolDetail | undefined, later: ToolDetail | undefined): ToolDetail | undefined {
  if (!earlier) return later;
  if (!later) return earlier;
  return { ...earlier, ...later };
}
