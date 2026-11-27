/**
 * Per-message read-aloud TTS: `POST/GET /api/tts`, synthesized by the Kokoro sidecar.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HundredfoldConfig } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { randomUUID } from "node:crypto";
import { streamTtsSentences, ttsStatus, validateTtsText } from "../tts/tts-stream.js";
import { errorField, traceDebug, traceLine } from "../voice/trace.js";
import { readJsonBody } from "./http-helpers.js";
import { json } from "./route-helpers.js";

type TtsRequest = Parameters<typeof readJsonBody>[0];

type KokoroOptions = NonNullable<HundredfoldConfig["talk"]>["kokoro"];

/**
 * Stream one length-prefixed WAV frame per sentence as each is synthesized, so
 * the client plays sentence 1 while 2..N are still being synthesized
 * (time-to-first-audio is one sentence, not the whole message). Frame = 4-byte
 * big-endian length + WAV bytes.
 */
async function streamFrames(
  req: IncomingMessage,
  res: ServerResponse,
  text: string,
  kokoroOpts: KokoroOptions,
): Promise<void> {
  const requestId = randomUUID().slice(0, 8);
  const startedAt = Date.now();
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no", // don't let a proxy buffer the stream
  });
  // A client abort (pause / navigate) closes the request → stop synthesizing the
  // rest of the message instead of wasting Kokoro on audio nobody hears.
  let cancelled = false;
  let frames = 0;
  let bytes = 0;
  req.on("close", () => {
    cancelled = true;
    // The request's own close fires once its body is read, so the socket state says whether the client really left.
    logger.info(traceLine("tts_request_close", { req: requestId, frames, since_start_ms: Date.now() - startedAt, socket_destroyed: req.socket?.destroyed, response_ended: res.writableEnded }));
  });
  res.on("close", () => {
    logger.info(traceLine("tts_response_close", { req: requestId, frames, bytes, since_start_ms: Date.now() - startedAt, completed: res.writableFinished }));
  });
  try {
    await streamTtsSentences(
      text,
      kokoroOpts,
      (wav) => {
        const header = Buffer.allocUnsafe(4);
        header.writeUInt32BE(wav.length, 0);
        // Both writes always happen: the length prefix and its frame are one unit, whatever the socket buffer says.
        const headerFlushed = res.write(header);
        const wavFlushed = res.write(wav);
        const flushed = headerFlushed && wavFlushed;
        frames += 1;
        bytes += header.length + wav.length;
        if (!flushed) traceDebug("tts_backpressure", () => ({ req: requestId, frames, buffered: res.writableLength }));
      },
      () => cancelled || res.writableEnded,
      requestId,
    );
  } catch (err) {
    logger.warn(`TTS stream failed: ${err instanceof Error ? err.message : String(err)}`);
    logger.warn(traceLine("tts_stream_failed", { req: requestId, frames, error: errorField(err), since_start_ms: Date.now() - startedAt }));
  }
  if (!res.writableEnded) res.end();
}

/** Over-long text is cut at a sentence boundary; say so, since the rest of the message is never read aloud. */
function warnIfCut(raw: unknown, kept: string): void {
  if (typeof raw !== "string" || kept.length >= raw.trim().length) return;
  logger.warn(traceLine("tts_text_truncated", { route: "/api/tts", received_chars: raw.trim().length, kept_chars: kept.length }));
}

/**
 * Handle `/api/tts`, returning false for anything else so the caller falls
 * through to the rest of the router.
 *
 * GET reports engine readiness so the client can pick Kokoro over the browser's
 * Web Speech fallback WITHOUT a failed POST. POST 503s `{available:false}` when
 * Kokoro cannot run, at which point the client falls back to Web Speech.
 */
export async function handleTtsApi(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  config: HundredfoldConfig,
): Promise<boolean> {
  if (pathname !== "/api/tts") return false;
  const method = req.method ?? "GET";
  const kokoroOpts = config.talk?.kokoro;

  if (method === "GET") {
    const { available, voice } = ttsStatus(kokoroOpts);
    json(res, { available, voice });
    return true;
  }
  if (method !== "POST") return false;
  if (!ttsStatus(kokoroOpts).available) {
    logger.warn(traceLine("tts_unavailable", { route: "/api/tts" }));
    json(res, { available: false }, 503);
    return true;
  }
  const parsed = await readJsonBody(req as TtsRequest, res);
  if (!parsed.ok) return true;
  const raw = (parsed.body as { text?: unknown } | null)?.text;
  const valid = validateTtsText(raw);
  if (!valid.ok) {
    logger.warn(traceLine("tts_rejected", { route: "/api/tts", error: valid.error }));
    json(res, { error: valid.error }, 400);
    return true;
  }
  warnIfCut(raw, valid.text);
  await streamFrames(req, res, valid.text, kokoroOpts);
  return true;
}
