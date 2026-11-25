import type { ChatBlockEnvelope, LiveStreamBlock, StreamDelta } from "../shared/types.js";
import { extractActivityReceiptId } from "../shared/activity-receipts.js";
import { blockFallbackText, validateBlockEnvelope } from "../shared/blocks.js";
import { logger } from "../shared/logger.js";
import {
  applyBlockEnvelope,
  insertPartialMessage,
  settlePartialToolMessage,
  updatePartialMessage,
  updatePartialToolDetail,
} from "./registry.js";
import { saveToolDetail } from "./tool-details.js";

function scopeBlockEnvelopeForTurn(
  envelope: ChatBlockEnvelope,
  turnStartedAt: number,
): ChatBlockEnvelope {
  const suffix = `t${turnStartedAt.toString(36)}`;
  if (envelope.block.id.endsWith(`:${suffix}`)) return envelope;
  const maxBaseLength = Math.max(1, 96 - suffix.length - 1);
  const baseId = envelope.block.id.slice(0, maxBaseLength);
  return {
    ...envelope,
    block: {
      ...envelope.block,
      id: `${baseId}:${suffix}`,
    },
  };
}

export function normalizeBlockDeltaForTurn(
  delta: StreamDelta,
  turnStartedAt: number,
): { ok: true; delta: StreamDelta } | { ok: false; error: string } {
  if (delta.type !== "block") return { ok: true, delta };
  const initial = validateBlockEnvelope(delta.block);
  if (!initial.ok) return initial;
  const scoped = scopeBlockEnvelopeForTurn(initial.envelope, turnStartedAt);
  const validated = validateBlockEnvelope(scoped);
  if (!validated.ok) return validated;
  return {
    ok: true,
    delta: {
      ...delta,
      content: delta.content || blockFallbackText(validated.envelope.block),
      block: validated.envelope,
    },
  };
}

/**
 * Fold a streamed text/text_snapshot delta into the accumulated partial text.
 * Incremental text appends; an authoritative snapshot always replaces.
 */
export function foldPartialText(curText: string, delta: StreamDelta): string {
  if (delta.type === "text_snapshot") {
    return typeof delta.content === "string" ? delta.content : curText;
  }
  if (delta.type === "text") {
    return curText + (typeof delta.content === "string" ? delta.content : "");
  }
  return curText;
}

/** The most one thinking row keeps: the head, then a marker. A model can think for a long time, and the row is
 *  part of every read of the session. */
export const THINKING_ROW_MAX = 20_000;
const THINKING_CUT_MARKER = "…";

export interface PartialStreamWriter {
  /** Persist the delta and return it as it should go out: a text delta carries
   *  its block and offset, and a delta that ends a block carries that block.
   *  Thinking past its cap is dropped (`null`): it goes nowhere. */
  persist(delta: StreamDelta & { type: "thinking" }): StreamDelta | null;
  persist(delta: StreamDelta): StreamDelta;
  finish(): void;
}

// Block ids rise across every writer in this process, so a view can tell an older
// block from a newer one without knowing which turn either came from.
let lastStreamBlock = 0;

// The writer of each session's running turn, while its engine runs. A read of the
// session takes the block being streamed from here rather than from the stored row,
// which trails the stream by up to one flush interval.
const liveWriters = new Map<string, { attemptToken: string; live(): LiveStreamBlock }>();

/**
 * The text block the session's turn is streaming, or null between engine runs. Only
 * the writer of the attempt the session is on now answers, so a stray delta from a
 * finished turn cannot pass that turn's text off as the current one's.
 */
export function getLiveStreamBlock(sessionId: string, attemptToken: string | null | undefined): LiveStreamBlock | null {
  const writer = liveWriters.get(sessionId);
  return writer && attemptToken && writer.attemptToken === attemptToken ? writer.live() : null;
}

/** Persist one engine turn's live stream as coalesced partial transcript rows. */
export function createPartialStreamWriter(sessionId: string, attemptToken = ""): PartialStreamWriter {
  let partialSeq = 0;
  let curTextId: string | null = null;
  let curText = "";
  /** What the open block holds: the answer's text, or the model's thinking (its own row, role "thinking"). */
  let curRole: "assistant" | "thinking" = "assistant";
  /** The open thinking block hit `THINKING_ROW_MAX`: what follows is dropped. */
  let thinkingCut = false;
  let curBlock = ++lastStreamBlock;
  const registration = {
    attemptToken,
    live: (): LiveStreamBlock => ({ block: curBlock, text: curText, messageId: curTextId }),
  };
  const startBlock = () => {
    curTextId = null;
    curText = "";
    curRole = "assistant";
    thinkingCut = false;
    curBlock = ++lastStreamBlock;
  };
  // Where the delta sits in the block, read before it is folded in.
  const positioned = (delta: StreamDelta): StreamDelta => {
    if (delta.type === "text") return { ...delta, streamBlock: curBlock, offset: curText.length };
    if (delta.type === "text_snapshot") return { ...delta, streamBlock: curBlock, offset: 0 };
    if ((delta.type === "tool_use" && delta.sidechain !== true) || (delta.type === "block" && delta.block)) {
      return { ...delta, streamBlock: curBlock };
    }
    return delta;
  };
  /** Calls whose card was cut, so the store holds their input and their output has to join it. */
  const fullTools = new Set<string>();
  const openPartialTools: Array<{
    messageId: string;
    toolName: string;
    toolId?: string;
  }> = [];
  let partialFlushTimer: ReturnType<typeof setTimeout> | null = null;

  const clearScheduledFlush = () => {
    if (!partialFlushTimer) return;
    clearTimeout(partialFlushTimer);
    partialFlushTimer = null;
  };
  const flushPartialText = () => {
    partialFlushTimer = null;
    if (!curText.trim()) return;
    if (curTextId) updatePartialMessage(curTextId, curText);
    else curTextId = insertPartialMessage(sessionId, curRole, curText, partialSeq++);
  };
  /** Close the open text or thinking block, so what comes next opens its own row. */
  const endRun = () => {
    clearScheduledFlush();
    flushPartialText();
    startBlock();
  };
  const keepFull = (toolId: string | undefined, toolFull: StreamDelta["toolFull"]) => {
    if (!toolId || !toolFull) return;
    try {
      saveToolDetail(sessionId, toolId, toolFull);
      fullTools.add(toolId);
    } catch (err) {
      logger.warn(`Failed to keep the full detail of a tool call for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  /** One chunk of thinking: kept to the row's cap, which ends the block's growth with a marker. */
  const foldThinking = (delta: StreamDelta): StreamDelta | null => {
    const chunk = typeof delta.content === "string" ? delta.content : "";
    if (!chunk || thinkingCut) return null;
    const room = THINKING_ROW_MAX - curText.length;
    const kept = chunk.length > room ? chunk.slice(0, room) + THINKING_CUT_MARKER : chunk;
    if (chunk.length > room) thinkingCut = true;
    const out: StreamDelta = { ...delta, content: kept, streamBlock: curBlock, offset: curText.length };
    curText += kept;
    if (!partialFlushTimer) partialFlushTimer = setTimeout(flushPartialText, 600);
    return out;
  };

  return {
    persist: ((received: StreamDelta): StreamDelta | null => {
      liveWriters.set(sessionId, registration);
      // The whole of a call's detail belongs to the store, not to the stream.
      const { toolFull, ...delta } = received;
      // Thinking and the answer's text are separate rows: a change from one to the other closes the open block.
      if (delta.type === "thinking") {
        if (curRole !== "thinking") {
          endRun();
          curRole = "thinking";
        }
        return foldThinking(delta);
      }
      if ((delta.type === "text" || delta.type === "text_snapshot") && curRole === "thinking") endRun();
      const outgoing = positioned(delta);
      if (delta.type === "text" || delta.type === "text_snapshot") {
        if (typeof delta.content !== "string") return delta;
        curText = foldPartialText(curText, delta);
        if (delta.type === "text_snapshot") {
          clearScheduledFlush();
          flushPartialText();
        } else if (!partialFlushTimer) {
          partialFlushTimer = setTimeout(flushPartialText, 600);
        }
        return outgoing;
      }

      if (delta.type === "tool_use") {
        // A sub-agent's call arrives out of band (from its hook), not in order
        // with the main agent's text, so it must not end that text's block:
        // splitting the answer around it leaves its fragments as interim prose
        // beside the canonical final row, and the answer reads twice.
        const sidechain = delta.sidechain === true;
        if (!sidechain) {
          clearScheduledFlush();
          flushPartialText();
        }
        const tool = delta.toolName || String(delta.content ?? "");
        const messageId = insertPartialMessage(
          sessionId,
          "assistant",
          `Using ${tool}`,
          partialSeq++,
          tool,
          delta.toolId,
          {
            ...(sidechain ? { sidechain: true } : {}),
            ...(delta.toolDetail ? { tool: delta.toolDetail } : {}),
          },
        );
        keepFull(delta.toolId, toolFull);
        openPartialTools.push({
          messageId,
          toolName: tool,
          ...(delta.toolId ? { toolId: delta.toolId } : {}),
        });
        if (!sidechain) startBlock();
        return outgoing;
      }

      if (delta.type === "tool_update") {
        // The input of a call already announced: it joins that call's row and card.
        const match = delta.toolId ? openPartialTools.find((entry) => entry.toolId === delta.toolId) : undefined;
        if (match && delta.toolDetail) updatePartialToolDetail(match.messageId, delta.toolDetail);
        if (match) keepFull(delta.toolId, toolFull);
        return outgoing;
      }

      if (delta.type === "tool_result") {
        const matchIndex = delta.toolId
          ? openPartialTools.findIndex((entry) => entry.toolId === delta.toolId)
          : (() => {
              if (!delta.toolName) return -1;
              for (let index = openPartialTools.length - 1; index >= 0; index--) {
                if (openPartialTools[index]?.toolName === delta.toolName) return index;
              }
              return -1;
            })();
        if (matchIndex < 0) return outgoing;
        const [match] = openPartialTools.splice(matchIndex, 1);
        if (!match) return outgoing;
        const activityReceiptId = extractActivityReceiptId({
          activityReceiptId: delta.activityReceiptId,
        });
        settlePartialToolMessage(
          match.messageId,
          `Used ${match.toolName}`,
          activityReceiptId,
          delta.agentId,
          delta.toolDetail,
        );
        // A call whose input was cut but whose output was not: the store still gets the output, so a
        // card that loads the call's detail finds all of it.
        keepFull(
          delta.toolId,
          toolFull ?? (delta.toolId && fullTools.has(delta.toolId) && delta.toolDetail
            ? { ...(delta.toolDetail.output !== undefined ? { output: delta.toolDetail.output } : {}), ...(delta.toolDetail.isError ? { isError: true } : {}) }
            : undefined),
        );
        return outgoing;
      }

      if (delta.type === "block" && delta.block) {
        clearScheduledFlush();
        flushPartialText();
        applyBlockEnvelope(sessionId, delta.block, delta.content, {
          partial: true,
          seq: partialSeq++,
        });
        startBlock();
      }
      return outgoing;
    }) as PartialStreamWriter["persist"],
    finish() {
      clearScheduledFlush();
      flushPartialText();
      if (liveWriters.get(sessionId) === registration) liveWriters.delete(sessionId);
    },
  };
}
