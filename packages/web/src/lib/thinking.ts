import type { Message } from '@/lib/conversations'

/**
 * Thinking rows: the model's reasoning, kept in the transcript as `role: 'thinking'`
 * beside its prose and tool rows, in stream order.
 *
 * The gateway streams a block as chunks that share a `streamBlock`; a new id is a new block.
 * The id is stamped on the live row's `meta`, so the row itself says which block it is
 * growing, wherever the view lives (a cached snapshot, a re-read that swapped the row for
 * its stored copy). Nothing outside the transcript has to remember it.
 */

const BLOCK_KEY = 'thinkingBlock'
const SKIP_KEY = 'thinkingSkip'

export function isThinkingRow(message: Message | undefined): boolean {
  return message?.role === 'thinking'
}

/** A thinking row with nothing to read: some providers stream reasoning as an empty or redacted block. */
export function isBlankThinkingRow(message: Message): boolean {
  return message.role === 'thinking' && !message.content.trim()
}

function blockOf(message: Message): string | null {
  const block = message.meta?.[BLOCK_KEY]
  return typeof block === 'string' ? block : null
}

function withMeta(message: Message, patch: Record<string, unknown>): Message {
  const meta = { ...message.meta }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete meta[key]
    else meta[key] = value
  }
  return { ...message, meta: Object.keys(meta).length ? meta : undefined }
}

/** Where the current turn starts: just after its last user row. */
function turnStartOf(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'user') return index + 1
  }
  return 0
}

/** The newest row of the turn that is not a sub-agent's tool call: the only one a stream can still extend. */
function newestRowIndex(messages: Message[]): number {
  const start = turnStartOf(messages)
  for (let index = messages.length - 1; index >= start; index--) {
    const row = messages[index]
    if (row.toolCall && row.meta?.sidechain === true) continue
    return index
  }
  return -1
}

function growingRowIndex(messages: Message[]): number {
  const index = newestRowIndex(messages)
  return index >= 0 && messages[index].role === 'thinking' ? index : -1
}

/** Whether a chunk of this block opens a new row, rather than extending the one the turn ends with. */
export function startsThinkingBlock(messages: Message[], blockId: string): boolean {
  const index = growingRowIndex(messages)
  return index < 0 || blockOf(messages[index]) !== blockId
}

/**
 * A thinking chunk arrives: it extends the row of its block when that row is the newest thing in
 * the turn, and otherwise starts a row of its own after everything already there.
 *
 * `thinkingSkip` on the row is the text a re-read already put there ahead of the stream (see
 * `carryLiveThinking`): chunks that repeat it are dropped instead of appended twice.
 */
export function applyThinkingChunk(
  messages: Message[],
  blockId: string,
  chunk: string,
  now: number,
  newId: () => string,
): Message[] {
  if (!chunk) return messages
  if (startsThinkingBlock(messages, blockId)) {
    return [
      ...messages,
      { id: newId(), role: 'thinking', content: chunk, timestamp: now, meta: { [BLOCK_KEY]: blockId } },
    ]
  }
  const index = growingRowIndex(messages)
  const row = messages[index]
  const { add, remaining } = takeSkipped(typeof row.meta?.[SKIP_KEY] === 'string' ? row.meta[SKIP_KEY] : '', chunk)
  const next = [...messages]
  next[index] = withMeta(add ? { ...row, content: row.content + add } : row, { [SKIP_KEY]: remaining || undefined })
  return next
}

/**
 * What of a chunk is new, given the text a re-read already put in the row ahead of the stream.
 * A chunk that matches neither the start of that text nor runs on past it is not the stored text
 * coming round again: it is new, and the skip is dropped.
 */
function takeSkipped(skip: string, chunk: string): { add: string; remaining: string } {
  if (skip && skip.startsWith(chunk)) return { add: '', remaining: skip.slice(chunk.length) }
  if (skip && chunk.startsWith(skip)) return { add: chunk.slice(skip.length), remaining: '' }
  return { add: chunk, remaining: '' }
}

/**
 * A read of a running chat lands, holding its stored copy of the thinking block the stream is
 * extending under another id.
 *
 * The view's row keeps its id (a new key would remount it under the reader) and the longer of
 * the two texts: the stored row may lag the stream by a few chunks, or run ahead of a view that
 * missed some. When it runs ahead, the stream is about to repeat that tail, so the tail is
 * recorded to be skipped. A read that holds no copy of the block at all (it was answered before
 * the gateway stored it) leaves the view's row where it was, as the newest of the turn.
 */
export function carryLiveThinking(current: Message[], merged: Message[]): Message[] {
  const liveIndex = growingRowIndex(current)
  if (liveIndex < 0) return merged
  const live = current[liveIndex]
  const block = blockOf(live)
  if (!block) return merged

  // The read's row matched the view's by text and took its id, or is the stored copy of it.
  const sameId = merged.findIndex((row) => row.id === live.id)
  const storedIndex = sameId >= 0 ? sameId : storedCopyIndex(current, liveIndex, merged)
  if (storedIndex < 0) return [...merged, live]
  return replaceRow(merged, storedIndex, (row) => {
    const { content, skip } = growth(live, row.content)
    return withMeta({ ...row, id: live.id, timestamp: live.timestamp, content }, { [BLOCK_KEY]: block, [SKIP_KEY]: skip || undefined })
  })
}

function skipOf(row: Message): string {
  const skip = row.meta?.[SKIP_KEY]
  return typeof skip === 'string' ? skip : ''
}

/**
 * The text the row holds once a stored copy is taken in, and the tail the stream has still to
 * repeat. The stream has delivered the row's text less the skip it already owes; whatever the
 * stored copy holds past that is the new skip. A copy that lags the row changes nothing.
 */
function growth(live: Message, stored: string): { content: string; skip: string } {
  if (stored.length >= live.content.length && stored.startsWith(live.content)) {
    const streamed = live.content.length - skipOf(live).length
    return { content: stored, skip: stored.slice(streamed) }
  }
  return { content: live.content, skip: skipOf(live) }
}

function replaceRow(messages: Message[], index: number, change: (row: Message) => Message): Message[] {
  const next = [...messages]
  next[index] = change(messages[index])
  return next
}

/** The row before this one in its turn, leaving out sub-agent tool calls (they arrive out of band). */
function anchorOf(messages: Message[], index: number): Message | null {
  const start = turnStartOf(messages)
  for (let at = index - 1; at >= start; at--) {
    const row = messages[at]
    if (row.toolCall && row.meta?.sidechain === true) continue
    return row
  }
  return null
}

function sameRow(a: Message | null, b: Message | null): boolean {
  if (!a || !b) return a === b
  return a.id === b.id || (a.role === b.role && a.toolCall === b.toolCall && a.content === b.content)
}

/**
 * The row of a read that is the stored copy of the live row: a thinking row holding the same text,
 * or a longer or shorter run of it, that sits where the live row does. An earlier block of the
 * turn can start with the same words ("Let me", "Okay."), so the text alone never decides it:
 * the copy must follow the same row the live one follows.
 */
function storedCopyIndex(current: Message[], liveIndex: number, merged: Message[]): number {
  const anchor = anchorOf(current, liveIndex)
  for (let index = merged.length - 1; index >= turnStartOf(merged); index--) {
    const row = merged[index]
    if (row.role !== 'thinking' || !row.content.trim()) continue
    const live = current[liveIndex].content
    const related = row.content.startsWith(live) || live.startsWith(row.content)
    if (related && sameRow(anchorOf(merged, index), anchor)) return index
  }
  return -1
}
