/**
 * One-line, key=value diagnostics for the voice and speech pipeline.
 *
 * Every line reads `[voice] event=<name> key=value ...` so a whole spoken turn can be followed with one grep
 * (`grep '\[voice\]' gateway.log`) and a single conversation with `grep 'att=<id>'`. Values are lengths, ids,
 * counts and milliseconds: never the words that were said or spoken, and never a credential.
 *
 * Levels: `info` is the lifecycle and a summary per segment, utterance and request, so the default level is
 * enough to diagnose a cut-off or garbled reply; `debug` adds every frame and chunk.
 */
export type TraceValue = string | number | boolean | null | undefined;
export type TraceFields = Record<string, TraceValue>;

/** The little of the gateway logger the pipeline needs. */
export interface TraceSink {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

/** A trace point bound to one conversation: its fields are prefixed to every line. */
export interface Tracer {
  info(event: string, fields?: TraceFields): void;
  warn(event: string, fields?: TraceFields): void;
  debug(event: string, fields?: TraceFields): void;
}

const BARE = /^[A-Za-z0-9_.:/@+-]*$/;

function formatValue(value: Exclude<TraceValue, undefined>): string {
  if (value === null) return "null";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
  if (typeof value === "boolean") return value ? "true" : "false";
  const flat = value.replace(/[\r\n\t]+/g, " ");
  const shown = flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
  return BARE.test(shown) && shown !== "" ? shown : JSON.stringify(shown);
}

/** `[voice] event=name a=1 b=text` with undefined fields left out. */
export function traceLine(event: string, fields: TraceFields = {}): string {
  const parts = [`[voice] event=${event}`];
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) parts.push(`${key}=${formatValue(value)}`);
  }
  return parts.join(" ");
}

/** A tracer that writes to `sink`, every line starting with `base` (for example the attachment and session ids). */
export function createTracer(sink: Pick<TraceSink, "info" | "warn"> & Partial<Pick<TraceSink, "debug">>, base: TraceFields = {}): Tracer {
  const write = (level: "info" | "warn" | "debug", event: string, fields?: TraceFields): void => {
    const emit = level === "debug" ? (sink.debug ?? undefined) : sink[level];
    if (!emit) return;
    emit.call(sink, traceLine(event, { ...base, ...fields }));
  };
  return {
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    debug: (event, fields) => write("debug", event, fields),
  };
}

/** A tracer that writes nothing, for code built without a log. */
export const silentTracer: Tracer = { info: () => undefined, warn: () => undefined, debug: () => undefined };

/** The message of an error, short and free of addresses, for the `error=` field. */
export function errorField(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>").slice(0, 160);
}
