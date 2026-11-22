import type { Message } from '@/lib/conversations'

export function reconcileCompletedTurnMessages(args: {
  messages: Message[]
  turnStart: number
  finalMessage: Message
  exactResult?: string
}): Message[] {
  const turnStart = args.turnStart >= 0
    ? Math.min(args.turnStart, args.messages.length)
    : args.messages.length
  const exactResult = args.exactResult?.trim() ?? ''
  const turnRows = args.messages.slice(turnStart)
  const streamedTail = streamedTailIndex(turnRows, exactResult)
  const preserved = turnRows
    .filter((_, index) => index !== streamedTail)
    .filter((message) =>
      message.role === 'user'
      || Boolean(message.media?.length)
      || Boolean(message.toolCall)
      || message.role === 'notification'
      || hasDurableBlocks(message)
      || hasInterimProse(message, exactResult))
    .map((message) => {
      if (message.toolCall && !message.content.startsWith('Used ')) return { ...message, content: `Used ${message.toolCall}` }
      if (message.role === 'assistant' && !message.toolCall && !message.blocks?.length && !message.media?.length) {
        return { ...message, partial: undefined, meta: { assistantPhase: 'commentary', ...message.meta } }
      }
      return message
    })

  return [
    ...args.messages.slice(0, turnStart),
    ...preserved,
    { ...args.finalMessage, meta: { ...args.finalMessage.meta, assistantPhase: 'final' } },
  ]
}

/**
 * The stored copy of the answer still being streamed, when a re-read of the chat landed mid-turn.
 * It is the last partial prose row with nothing after it (no tool call, block or later prose), and
 * the final reply is that text grown to its end, so it was only ever a prefix of the reply: the
 * gateway drops it when the turn settles, and so must the live view. Prose that a tool call
 * followed is interim evidence and is kept.
 */
function streamedTailIndex(rows: Message[], exactResult: string): number {
  const last = rows.length - 1
  const row = rows[last]
  return exactResult && row && isPlainPartialProse(row) && exactResult.startsWith(row.content.trim()) && row.content.trim() ? last : -1
}

function isPlainPartialProse(row: Message): boolean {
  return row.role === 'assistant' && row.partial === true && !row.toolCall && !row.blocks?.length && !row.media?.length
}

function hasDurableBlocks(message: Message): boolean {
  return Boolean(message.blocks?.some((block) => block.type === 'delegation' || block.type === 'dispatch' || block.payload.kind === 'native-agents'))
}

function hasInterimProse(message: Message, exactResult: string): boolean {
  return message.role === 'assistant' && !message.blocks?.length
    && Boolean(message.content.trim()) && (!exactResult || message.content.trim() !== exactResult)
}
