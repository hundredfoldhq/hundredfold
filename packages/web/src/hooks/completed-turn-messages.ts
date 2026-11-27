import type { Message } from '@/lib/conversations'

export function reconcileCompletedTurnMessages(args: {
  messages: Message[]
  turnStart: number
  finalMessage: Message
  exactResult?: string
  /** The id of the stored copy of the text still streaming when a re-read landed mid-turn. */
  streamedCopyId?: string | null
}): Message[] {
  const turnStart = args.turnStart >= 0
    ? Math.min(args.turnStart, args.messages.length)
    : args.messages.length
  const exactResult = args.exactResult?.trim() ?? ''
  const turnRows = args.messages.slice(turnStart)
  const preserved = turnRows
    .filter((message) => !isGrownStreamedCopy(message, args.streamedCopyId, exactResult))
    .filter((message) => survivesCompletion(message, exactResult))
    .map(settleRow)

  return [
    ...args.messages.slice(0, turnStart),
    ...preserved,
    { ...args.finalMessage, meta: { ...args.finalMessage.meta, assistantPhase: 'final' } },
  ]
}

/**
 * The stored copy of the text block still being streamed, in a chat read that landed mid-turn:
 * the last partial prose row, with nothing after it that ends the block (a main-thread tool call,
 * a block, later prose). A sub-agent's tool call does not end the main text block, so sidechain
 * tool rows after the prose are skipped. The live stream goes on to extend this row, which the
 * gateway grows in place, so the live view must not keep it beside the text it became: a view
 * that already holds the streamed text drops the row when it flushes, and a view opened with no
 * streamed text yet takes the row's text in front of the first live tail.
 */
export function findStreamedCopy(rows: Message[]): Message | null {
  let last = rows.length - 1
  while (last >= 0 && isSidechainToolRow(rows[last])) last -= 1
  const row = rows[last]
  return row && row.content.trim() && isPlainPartialProse(row) ? row : null
}

/**
 * Whether a row is the stored copy that the text now in hand (the flushed stream, or the final
 * reply) grew from. Text that does not start with it was rewritten, and the gateway keeps it then.
 */
export function isGrownStreamedCopy(row: Message, copyId: string | null | undefined, text: string): boolean {
  if (!copyId || row.id !== copyId || !isPlainPartialProse(row)) return false
  const stored = row.content.trim()
  return Boolean(stored) && text.trim().startsWith(stored)
}

function isSidechainToolRow(row: Message): boolean {
  return Boolean(row.toolCall) && row.meta?.sidechain === true
}

function isPlainPartialProse(row: Message): boolean {
  return row.partial === true && isPlainProse(row)
}

/** A row the turn leaves behind, with what was still in flight on it settled. */
function settleRow(message: Message): Message {
  if (message.role === 'thinking') return message.partial ? { ...message, partial: undefined } : message
  if (message.toolCall && !message.content.startsWith('Used ')) return { ...message, content: `Used ${message.toolCall}` }
  if (isPlainProse(message)) {
    return { ...message, partial: undefined, meta: { assistantPhase: 'commentary', ...message.meta } }
  }
  return message
}

function isPlainProse(message: Message): boolean {
  return message.role === 'assistant' && !message.toolCall && !message.blocks?.length && !message.media?.length
}

/** What the turn leaves behind besides its final answer. Reasoning is evidence like interim prose: it stays, in order. */
function survivesCompletion(message: Message, exactResult: string): boolean {
  return message.role === 'user'
    || message.role === 'notification'
    || message.role === 'thinking'
    || Boolean(message.media?.length)
    || Boolean(message.toolCall)
    || hasDurableBlocks(message)
    || hasInterimProse(message, exactResult)
}

function hasDurableBlocks(message: Message): boolean {
  return Boolean(message.blocks?.some((block) => block.type === 'delegation' || block.type === 'dispatch' || block.payload.kind === 'native-agents'))
}

function hasInterimProse(message: Message, exactResult: string): boolean {
  return message.role === 'assistant' && !message.blocks?.length
    && Boolean(message.content.trim()) && (!exactResult || message.content.trim() !== exactResult)
}
