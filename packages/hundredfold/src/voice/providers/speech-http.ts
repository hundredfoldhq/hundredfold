/** Streams a `POST .../audio/speech` response as PCM16LE chunks, shared by the OpenAI and OpenAI-compatible providers. */
import { redact } from "./audio.js";

export interface SpeechRequest {
  url: string;
  key: string | undefined;
  body: Record<string, unknown>;
  signal: AbortSignal;
  /** Names the provider in an error message. */
  who: string;
}

export class SpeechHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Open the request; throws `SpeechHttpError` for a non-2xx status without echoing a credential. */
export async function postSpeech(request: SpeechRequest): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (request.key) headers.Authorization = `Bearer ${request.key}`;
  const response = await fetch(request.url, { method: "POST", headers, body: JSON.stringify(request.body), signal: request.signal }).catch((error: unknown) => {
    if (request.signal.aborted) throw error;
    throw new Error(`${request.who} could not be reached: ${redact(unreachableReason(error), [request.key])}`);
  });
  if (response.ok) return response;
  throw new SpeechHttpError(await failureMessage(request, response), response.status);
}

/** Node's fetch failures carry the cause (refused, not found, bad certificate) in `cause`; the URL is left out of what is reported. */
export function unreachableReason(error: unknown): string {
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  const source = cause instanceof Error ? cause : error;
  const code = (source as { code?: string }).code;
  return code ?? (source instanceof Error ? source.message.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>") : "network error");
}

async function failureMessage(request: SpeechRequest, response: Response): Promise<string> {
  if (response.status === 401 || response.status === 403) return `${request.who} rejected the credentials (HTTP ${response.status})`;
  let detail = "";
  try {
    const parsed = JSON.parse(await response.text()) as { error?: { message?: string } | string };
    detail = typeof parsed.error === "string" ? parsed.error : (parsed.error?.message ?? "");
  } catch {
    // not JSON: the status is enough
  }
  const safe = redact(detail, [request.key]).slice(0, 200);
  return `${request.who} failed (HTTP ${response.status})${safe ? `: ${safe}` : ""}`;
}

/** The response body as chunks with an even number of bytes (a sample is never split across two). */
export async function* pcmChunks(response: Response): AsyncGenerator<Buffer> {
  if (!response.body) return;
  let carry: Buffer = Buffer.alloc(0);
  for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
    const data: Buffer = carry.length ? Buffer.concat([carry, part]) : Buffer.from(part);
    const even = data.length - (data.length % 2);
    carry = data.subarray(even);
    if (even > 0) yield data.subarray(0, even);
  }
}

/** One request, 24 kHz PCM out: the OpenAI shape, `response_format: "pcm"`. */
export async function* streamSpeech(request: SpeechRequest): AsyncGenerator<Buffer> {
  yield* pcmChunks(await postSpeech(request));
}
