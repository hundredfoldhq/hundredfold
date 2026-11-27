import type { JsonObject, JsonValue } from "./types.js";
import { redactJson, redactLargeText, redactText } from "./redact.js";

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
  /** The gateway kept the call's whole input and output (see `ToolFull`): the card can offer to load them. */
  full?: true;
};

/**
 * A call's whole input and output, redacted but not cut to a card's size, kept by the
 * gateway when the card's detail was cut. It travels beside `ToolDetail` on a stream
 * delta, goes to the tool-details store and never reaches a client in a stream event.
 * Past the caps below the head is kept and the original length recorded.
 */
export interface ToolFull {
  input?: JsonObject;
  /** The input's serialised length before it was cut to `TOOL_FULL_INPUT_MAX`; absent when it all fit. */
  inputChars?: number;
  output?: string;
  /** The output's length before it was cut to `TOOL_FULL_OUTPUT_MAX`; absent when it all fit. */
  outputChars?: number;
  isError?: boolean;
}

/** What the gateway keeps of a call's input, serialised, and of its output, in characters. */
export const TOOL_FULL_INPUT_MAX = 256 * 1024;
export const TOOL_FULL_OUTPUT_MAX = 1_000_000;

/** Longest string kept inside a call's input (a command, a file body, an edit's old text). */
export const TOOL_INPUT_STRING_MAX = 1_200;
/** What the whole input may serialise to, once every string is cut. */
export const TOOL_INPUT_TOTAL_MAX = 4_000;
export const TOOL_OUTPUT_MAX = 3_000;
/** What is handed to the redactor: enough to hold anything a cut can reach, so one huge result costs bounded work. */
const REDACT_INPUT_MAX = 200_000;
const TOOL_INPUT_DEPTH_MAX = 4;
const TOOL_FULL_DEPTH_MAX = 12;
/** Successive limits tried until the input fits its budget: arrays shrink first, then strings. */
const STRING_LIMITS = [TOOL_INPUT_STRING_MAX, 600, 300, 120];
const ARRAY_LIMITS = [20, 8, 4, 3, 2, 1];

function clip(text: string, max: number): { text: string; cut: boolean } {
  return text.length > max ? { text: `${text.slice(0, max)}…`, cut: true } : { text, cut: false };
}

/** Redact before cutting, so a secret straddling the cut is still caught. */
function redactBounded(text: string): string {
  return redactText(text.length > REDACT_INPUT_MAX ? text.slice(0, REDACT_INPUT_MAX) : text);
}

interface Budget {
  cut: boolean;
  stringMax: number;
  arrayMax: number;
  redacted: Map<string, string>;
  /** Redacts one string: its head for a card, the whole of it for the kept copy. */
  redact: (text: string) => string;
  /** A string longer than this was only partly redacted, and so is cut. */
  redactMax: number;
  depthMax: number;
}

function boundString(value: string, budget: Budget): string {
  let safe = budget.redacted.get(value);
  if (safe === undefined) {
    safe = budget.redact(value);
    budget.redacted.set(value, safe);
  }
  if (value.length > budget.redactMax) budget.cut = true;
  const { text, cut } = clip(safe, budget.stringMax);
  if (cut) budget.cut = true;
  return text;
}

function boundList(value: unknown[], depth: number, budget: Budget): JsonValue[] {
  if (value.length > budget.arrayMax) budget.cut = true;
  return value.slice(0, budget.arrayMax).map((item) => boundValue(item, depth + 1, budget));
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
  if (depth >= budget.depthMax) {
    budget.cut = true;
    return "…";
  }
  return Array.isArray(value) ? boundList(value, depth, budget) : boundFields(value as Record<string, unknown>, depth, budget);
}

/** Leading top-level fields, kept whole while they fit; a field too big for what is left is skipped, not the end of the input. */
function leadingFields(bounded: JsonObject, max: number = TOOL_INPUT_TOTAL_MAX): JsonObject {
  const kept: JsonObject = {};
  let used = 2;
  for (const [key, value] of Object.entries(bounded)) {
    const cost = key.length + JSON.stringify(value).length + 4;
    if (used + cost > max) continue;
    kept[key] = value;
    used += cost;
  }
  return kept;
}

interface Redaction {
  redact: (text: string) => string;
  redactMax: number;
  depthMax: number;
  cache: Map<string, string>;
}

const cardRedaction = (): Redaction => ({ redact: redactBounded, redactMax: REDACT_INPUT_MAX, depthMax: TOOL_INPUT_DEPTH_MAX, cache: new Map() });
const fullRedaction = (): Redaction => ({ redact: redactLargeText, redactMax: Infinity, depthMax: TOOL_FULL_DEPTH_MAX, cache: new Map() });

function boundWith(redacted: unknown, stringMax: number, arrayMax: number, how: Redaction): { bounded: JsonObject; cut: boolean } {
  const budget: Budget = { cut: false, stringMax, arrayMax, redacted: how.cache, redact: how.redact, redactMax: how.redactMax, depthMax: how.depthMax };
  return { bounded: boundValue(redacted, 0, budget) as JsonObject, cut: budget.cut };
}

/**
 * A tool call's input, safe to show: secret-looking keys and token shapes
 * redacted, every string cut, and the whole kept under a budget. An input over
 * the budget shrinks inside its biggest fields (fewer list items, shorter
 * strings) so a MultiEdit still shows its leading edits.
 */
export function boundToolInput(input: unknown): { input: JsonObject; truncated: boolean } | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length === 0) return undefined;
  const redacted = redactJson(input);
  const how = cardRedaction();
  let last = boundWith(redacted, STRING_LIMITS[0], ARRAY_LIMITS[0], how);
  for (const stringMax of STRING_LIMITS) {
    for (const arrayMax of ARRAY_LIMITS) {
      last = boundWith(redacted, stringMax, arrayMax, how);
      if (JSON.stringify(last.bounded).length <= TOOL_INPUT_TOTAL_MAX) {
        return { input: last.bounded, truncated: last.cut || stringMax !== STRING_LIMITS[0] || arrayMax !== ARRAY_LIMITS[0] };
      }
    }
  }
  return { input: leadingFields(last.bounded), truncated: true };
}

/** Successive limits tried until the kept input fits: arrays and strings shrink together, never past a card's own. */
const FULL_STRING_LIMITS = [TOOL_FULL_INPUT_MAX, 128 * 1024, 64 * 1024, 32 * 1024, 16 * 1024, 8 * 1024, 4 * 1024, TOOL_INPUT_STRING_MAX];
const FULL_ARRAY_LIMITS = [5_000, 500, 100, 20, 8];

/**
 * A tool call's whole input, redacted, for the store: nothing is cut unless the serialised
 * input passes `TOOL_FULL_INPUT_MAX`, and then its strings (and lists) shrink until it fits and
 * `chars` says how long it was.
 */
export function boundToolInputFull(input: unknown): { input: JsonObject; chars?: number } | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length === 0) return undefined;
  const redacted = redactJson(input);
  const how = fullRedaction();
  let last = boundWith(redacted, FULL_STRING_LIMITS[0], FULL_ARRAY_LIMITS[0], how);
  let serialised = JSON.stringify(last.bounded).length;
  if (!last.cut && serialised <= TOOL_FULL_INPUT_MAX) return { input: last.bounded };
  const original = JSON.stringify(redacted).length;
  for (const stringMax of FULL_STRING_LIMITS) {
    for (const arrayMax of FULL_ARRAY_LIMITS) {
      last = boundWith(redacted, stringMax, arrayMax, how);
      serialised = JSON.stringify(last.bounded).length;
      if (serialised <= TOOL_FULL_INPUT_MAX) return { input: last.bounded, chars: original };
    }
  }
  return { input: leadingFields(last.bounded, TOOL_FULL_INPUT_MAX), chars: original };
}

function textBlocks(blocks: unknown[]): string {
  return blocks
    .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
      ? (part as { text: string }).text
      : typeof part === "string" ? part : ""))
    .filter(Boolean)
    .join("\n");
}

/** A shell's answer: stdout, then stderr; empty when the command printed nothing. */
function shellText(record: Record<string, unknown>): string {
  return [record.stdout, record.stderr].filter((part): part is string => typeof part === "string" && part !== "").join("\n");
}

/** The stream a person reads of a structured result: a shell's output, or the first text field. */
function streamText(record: Record<string, unknown>): string | undefined {
  if ("stdout" in record || "stderr" in record) return shellText(record);
  for (const key of ["output", "text", "result", "content"]) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
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

/** One hunk of a structured patch as unified diff text: its `@@` header, then its lines. */
function hunkText(hunk: unknown): string[] {
  const h = hunk && typeof hunk === "object" ? (hunk as Record<string, unknown>) : undefined;
  if (!h || typeof h.oldStart !== "number" || typeof h.newStart !== "number" || !Array.isArray(h.lines)) return [];
  const count = (value: unknown) => (typeof value === "number" ? value : 0);
  const lines = h.lines.filter((line): line is string => typeof line === "string");
  return [`@@ -${h.oldStart},${count(h.oldLines)} +${h.newStart},${count(h.newLines)} @@`, ...lines];
}

/** A structured patch's hunks as unified diff text, numbered as the file is; empty when it has none. */
function structuredPatchText(patch: unknown): string {
  return Array.isArray(patch) ? patch.flatMap(hunkText).join("\n") : "";
}

/**
 * A unified diff from its first hunk: the `Index:` and `---`/`+++` lines above it name the
 * file's path, which the card already shows. Undefined when the text holds no hunk.
 */
export function patchHunks(patch: unknown): string | undefined {
  if (typeof patch !== "string") return undefined;
  const start = patch.search(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m);
  return start === -1 ? undefined : patch.slice(start).replace(/\n+$/, "");
}

function objectText(record: Record<string, unknown>): string {
  if (Array.isArray(record.content)) return textBlocks(record.content);
  // An Edit answers with the file's old and new bodies and the change as hunks: the hunks are kept,
  // numbered as the file is. A Write carries its body as `content` too, which its card draws from the input.
  if ("structuredPatch" in record || "originalFile" in record) {
    return typeof record.content === "string" ? "" : structuredPatchText(record.structuredPatch);
  }
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
  const redacted = redactBounded(raw);
  const { text, cut } = clip(redacted, TOOL_OUTPUT_MAX);
  const chars = raw.length > REDACT_INPUT_MAX ? raw.length : redacted.length;
  return { output: text, ...(cut || raw.length > REDACT_INPUT_MAX ? { chars } : {}) };
}

/** A tool result, redacted whole and cut only past `TOOL_FULL_OUTPUT_MAX`; `chars` is its length before that cut. */
export function boundToolOutputFull(output: unknown): { output: string; chars?: number } | undefined {
  const raw = toolOutputText(output);
  if (!raw) return undefined;
  const kept = raw.length > TOOL_FULL_OUTPUT_MAX ? raw.slice(0, TOOL_FULL_OUTPUT_MAX) : raw;
  return { output: redactLargeText(kept), ...(raw.length > TOOL_FULL_OUTPUT_MAX ? { chars: raw.length } : {}) };
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

/** What a stream delta carries for a call: the card's detail, and the whole of it when the card's was cut. */
export interface ToolParts {
  toolDetail?: ToolDetail;
  toolFull?: ToolFull;
}

/** The parts of one call's start. */
export function toolStartParts(input: unknown): ToolParts {
  const toolDetail = toolStartDetail(input);
  if (!toolDetail?.inputTruncated) return toolDetail ? { toolDetail } : {};
  const full = boundToolInputFull(input);
  return { toolDetail: { ...toolDetail, full: true }, ...(full ? { toolFull: { input: full.input, ...(full.chars !== undefined ? { inputChars: full.chars } : {}) } } : {}) };
}

/** The parts of one call's end. The whole of the input and output are kept together, so a card that loads them has both. */
export function toolEndParts(parts: { input?: unknown; output?: unknown; isError?: boolean }): ToolParts {
  const toolDetail = toolEndDetail(parts);
  if (!toolDetail || (!toolDetail.inputTruncated && toolDetail.outputChars === undefined)) return toolDetail ? { toolDetail } : {};
  const input = boundToolInputFull(parts.input);
  const output = boundToolOutputFull(parts.output);
  const toolFull: ToolFull = {
    ...(input ? { input: input.input, ...(input.chars !== undefined ? { inputChars: input.chars } : {}) } : {}),
    ...(output ? { output: output.output, ...(output.chars !== undefined ? { outputChars: output.chars } : {}) } : {}),
    ...(parts.isError ? { isError: true } : {}),
  };
  return { toolDetail: { ...toolDetail, full: true }, toolFull };
}
