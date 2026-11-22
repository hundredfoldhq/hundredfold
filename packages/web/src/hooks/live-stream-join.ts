/**
 * Lining the streamed text up against the gateway's text block.
 *
 * The gateway numbers each text block a turn streams and stamps every text delta
 * with its block and its offset in it; a read of a running session reports the
 * block being streamed with its whole text so far. With both, a view opened in the
 * middle of a block shows the block once and whole: the read supplies the head the
 * view never received, and the offsets drop what the read already holds.
 */

/** The block a running session is streaming, as a read reports it. */
export interface LiveStreamBlock {
  block: number
  text: string
  /** The stored row holding the same block, if the gateway has written one yet. */
  messageId: string | null
}

/**
 * Where the streaming text sits in its block: it covers [start, start + length).
 * `missing` is the head [0, missing) this view neither received nor shows, which
 * a read must supply. When nothing is missing, text before `start` is in a row the
 * view already flushed; while something is, `start` equals `missing`.
 */
export interface StreamPosition {
  block: number
  start: number
  missing: number
}

/** A text delta's place in its block, or null for a delta the gateway did not stamp. */
export function deltaPlace(payload: Record<string, unknown>): { block: number; offset: number } | null {
  const { streamBlock, offset } = payload
  if (typeof streamBlock !== 'number' || typeof offset !== 'number') return null
  if (!Number.isFinite(streamBlock) || !Number.isInteger(offset) || offset < 0) return null
  return { block: streamBlock, offset }
}

/** The block a frame that ends one (a main tool call, a block) names, if stamped. */
export function endedBlock(payload: Record<string, unknown>): number | null {
  const { streamBlock } = payload
  return typeof streamBlock === 'number' && Number.isFinite(streamBlock) ? streamBlock : null
}

/** The live block a read reports, or null when it reports none (or one malformed). */
export function readLiveStreamBlock(session: Record<string, unknown>): LiveStreamBlock | null {
  const live = session.liveStream
  if (!live || typeof live !== 'object') return null
  const { block, text, messageId } = live as Record<string, unknown>
  if (typeof block !== 'number' || !Number.isFinite(block) || typeof text !== 'string') return null
  return { block, text, messageId: typeof messageId === 'string' && messageId ? messageId : null }
}

/**
 * Add a stamped text delta to the streaming text. In the block already streaming,
 * the part of the chunk the text already covers is dropped. A delta of another
 * block, or one past a gap in this one (frames the view never received), starts
 * the text afresh at its offset; anything before that offset is missing until a
 * read supplies it.
 */
export function addPlacedText(
  text: string,
  pos: StreamPosition | null,
  place: { block: number; offset: number },
  chunk: string,
): { text: string; pos: StreamPosition } {
  if (pos && pos.block === place.block) {
    const end = pos.start + text.length
    if (place.offset === end) return { text: text + chunk, pos }
    if (place.offset < end) return { text: text + chunk.slice(end - place.offset), pos }
  }
  return { text: chunk, pos: { block: place.block, start: place.offset, missing: place.offset } }
}

/**
 * Join the read's text of the block to the streaming text of the same block. The
 * streaming text then starts where the view's own rows end, and runs to whichever
 * reaches further, the deltas or the read. Null when the read does not reach the
 * head the view is missing: the read is older than the gap, and joining would
 * glue the text across it.
 */
export function joinLiveRead(
  text: string,
  pos: StreamPosition,
  live: LiveStreamBlock,
): { text: string; pos: StreamPosition } | null {
  if (live.text.length < pos.missing) return null
  const end = pos.start + text.length
  const head = live.text.slice(0, pos.missing)
  const tail = live.text.length > end ? live.text.slice(end) : ''
  return { text: head + text + tail, pos: { block: pos.block, start: pos.missing > 0 ? 0 : pos.start, missing: 0 } }
}
