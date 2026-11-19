import { authFetch } from "@/lib/auth"
import { getPageContext } from "../context/page-context-store"
import { safeSpokenText } from "../context/spoken-text"
import { params, str, type TalkTool, type ToolResult } from "./tool-spec"

const QUERY_CHAR_LIMIT = 512
const MATCH_LIMIT = 6
const EXCERPT_CHAR_LIMIT = 240

interface SearchHit {
  role?: unknown
  snippet?: unknown
  timestamp?: unknown
  sessionId?: unknown
}

function currentChatId(): string | null {
  const selection = getPageContext().selection
  return selection?.kind === "chat session" && selection.id.trim() ? selection.id.trim() : null
}

function relativeTime(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "earlier"
  const age = Math.max(0, Date.now() - value)
  if (age < 60_000) return "just now"
  if (age < 3_600_000) return `${Math.floor(age / 60_000)} minutes ago`
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)} hours ago`
  if (age < 172_800_000) return "yesterday"
  return `${Math.floor(age / 86_400_000)} days ago`
}

function projectHits(value: unknown, sessionId: string): Array<{ timestamp: number; match: Record<string, unknown> }> {
  if (!value || typeof value !== "object") return []
  const results = (value as { results?: unknown }).results
  if (!Array.isArray(results)) return []
  return results.flatMap((raw): Array<{ timestamp: number; match: Record<string, unknown> }> => {
    if (!raw || typeof raw !== "object") return []
    const hit = raw as SearchHit
    if (hit.role !== "user" && hit.role !== "assistant") return []
    if (hit.sessionId !== sessionId) return []
    const excerpt = safeSpokenText(hit.snippet, EXCERPT_CHAR_LIMIT)
    if (!excerpt) return []
    const timestamp = typeof hit.timestamp === "number" && Number.isFinite(hit.timestamp) ? hit.timestamp : 0
    return [{ timestamp, match: { role: hit.role, excerpt, when: relativeTime(hit.timestamp) } }]
  })
}

function queryProblem(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return "Say what to search for in this chat."
  return value.trim().length > QUERY_CHAR_LIMIT
    ? `Keep the chat search to ${QUERY_CHAR_LIMIT} characters or fewer.`
    : null
}

/** One role's search. Asked per role because the index also returns relayed messages and child replies
 *  (role "notification"), which are not part of what Talk speaks and would use up the limit before the
 *  client could drop them. */
async function searchRole(query: string, sessionId: string, role: "user" | "assistant"): Promise<unknown> {
  const path = `/api/search/messages?q=${encodeURIComponent(query)}&sessionId=${encodeURIComponent(sessionId)}&role=${role}&limit=${MATCH_LIMIT}`
  const response = await authFetch(path, { method: "GET" })
  if (!response.ok) throw new Error("search failed")
  return await response.json() as unknown
}

async function searchCurrentChat(query: string, sessionId: string): Promise<ToolResult> {
  try {
    const bodies = await Promise.all([searchRole(query, sessionId, "user"), searchRole(query, sessionId, "assistant")])
    if (currentChatId() !== sessionId) {
      return { ok: false, error: "The chat changed while history was being searched, so those excerpts were discarded." }
    }
    const matches = bodies
      .flatMap((body) => projectHits(body, sessionId))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, MATCH_LIMIT)
      .map((hit) => hit.match)
    return { ok: true, data: { matches } }
  } catch {
    return { ok: false, error: "The current chat history could not be searched." }
  }
}

export const CHAT_MESSAGE_SEARCH_TOOL: TalkTool = {
  name: "talk_search_chat_messages",
  description: "Search earlier messages in the chat currently on screen. Returns matching excerpts only, with speaker and relative time.",
  parameters: params({ query: str(`All words to match in this chat, at most ${QUERY_CHAR_LIMIT} characters.`) }, ["query"]),
  execute: (args) => {
    const problem = queryProblem(args.query)
    if (problem) return { ok: false, error: problem }
    const sessionId = currentChatId()
    if (!sessionId) return { ok: false, error: "Open a chat before searching its earlier messages." }
    return searchCurrentChat(String(args.query).trim(), sessionId)
  },
}
