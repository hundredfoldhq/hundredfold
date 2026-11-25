# Thinking and full tool detail in the chat

What the gateway keeps and serves so the chat can show a model's reasoning and a tool call's whole input and result.

## Thinking rows

A model's reasoning is a `thinking` stream delta while it arrives (`{type: "thinking", content, streamBlock, offset}`) and a stored row with `role: "thinking"` afterwards, in stream order, written and settled the same way as assistant text. One row holds at most 20,000 characters (the head, then `…`).

- **Claude (local sessions):** read from the SSE proxy's `thinking_delta` events. Claude Code asks the API to omit the thinking text unless `showThinkingSummaries` is on, so the gateway turns it on in the per-session `--settings` file. Set `engines.claude.thinkingSummaries: false` to stop that; a session then streams no readable thinking. The setting is merged with whatever else the session's settings carry.
- **Claude (remote hosts):** there is no SSE proxy, so there is no thinking, and the setting is not written.
- **opencode:** the server's `reasoning` parts (v1) and `session.reasoning.*` events (v2).

`GET /api/sessions/:id?thinking=0` leaves thinking rows out; `read_session` uses it. Search, previews and "last answer" detection ignore thinking rows.

## Full tool detail

The card's `meta.tool` stays bounded. When the gateway also holds the whole redacted input and result it sets `meta.tool.full = true`, and the web app fetches them on demand:

`GET /api/sessions/:id/tool-details/:toolId` → `200 {input?, output?, isError?, outputChars?, inputChars?}`, or `404`. It has the same auth and visibility as `GET /api/sessions/:id`. There is no MCP tool for it.

- Stored in the `tool_details` table (`session_id`, `tool_id`), removed with the session and pruned when a turn's partial rows are dropped.
- Caps: 256 KB of serialised input, 1,000,000 characters of output. `outputChars` and `inputChars` are the original lengths, present only when that part was cut.
- Everything is redacted before it is stored, the whole text and not only the first part.
- Tool hooks (`POST /api/internal/hook`) accept bodies up to 8 MB, so a large result reaches the gateway; the limit applies to that route only.
- Sub-agent cards are not covered.
