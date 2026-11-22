# Data Model: Voice Mode

Nothing here adds a table. Attachments, utterances and segments live in the gateway's
memory for the life of a socket. The only durable facts are on the existing
`messages.meta` JSON column (`G/sessions/registry.ts:2356`).

## VoiceAttachment (in memory, one per session at most)

| Field | Type | Notes |
|---|---|---|
| `id` | string | minted at upgrade |
| `sessionId` | string | |
| `principal` | `{kind: "operator"} \| {kind: "member", userId, userSessionId}` | who opened it; re-checked on the member sweep |
| `mode` | `"hands-free" \| "push-to-talk"` | from `hello`, default from config |
| `client` | `"web" \| "native"` | from `hello`; native clients skip nothing, it is for logs and metrics |
| `state` | `listening \| hearing \| thinking \| working \| speaking` | drives `turn` frames |
| `openedAt` | epoch ms | |
| `promptSent` | boolean | whether the full voice prompt went on a turn since attach, compaction or engine switch |
| `currentUtterance` | `Utterance \| null` | |
| `playback` | `PlaybackQueue` | segments synthesised or queued for the current reply |
| `interrupted` | `{messageId, heardText} \| null` | set by a barge-in, consumed by the next final |

**Transitions**: `listening → hearing` (VAD speech start, or `ptt_down`);
`hearing → thinking` (a final transcript with words is dispatched); `hearing →
listening` (a final with no words); `thinking → working` (tool_use delta);
`thinking|working → speaking` (first segment sent); `speaking → listening` (last
segment played and the turn completed); `speaking → hearing` (barge-in).

**Ends** on: `bye`, socket close, take-over by the same principal (`detached
{taken_over}`), session deleted or stopped, voice disabled by config reload, member
access lost, gateway shutdown.

**Rules**: one per session. The same principal takes over; a different principal is
refused (`4409`). The attachment count is capped at `limits.maxConcurrentAttachments`.

## Utterance (in memory)

| Field | Type | Notes |
|---|---|---|
| `id` | string | gateway-minted, sent in `transcript` frames |
| `startedAt` / `endedAt` | epoch ms | VAD boundaries (or PTT) |
| `audioMs` | number | capped at `limits.maxUtteranceSeconds` |
| `partial` | string | latest partial |
| `final` | string \| null | |
| `sttMs` | number | `endedAt` → final |
| `bargeIn` | boolean | started while the assistant was speaking |

A final with words becomes a user message. A final with none resumes playback if
`bargeIn`, otherwise it is dropped.

## Segment (in memory)

| Field | Type | Notes |
|---|---|---|
| `id` | u32 | monotonic per attachment |
| `messageId` | string \| null | the assistant message the sentence belongs to |
| `text` | string | speakable text |
| `state` | `queued \| synthesising \| sent \| played \| cut` | `cut` = barge-in landed mid-segment |
| `playedMs` | number | from `played` or `barge_in` |

## Message meta: `voice` key

Written with `insertMessage(..., meta)` on creation, and merged later with a new
`mergeMessageMeta(messageId, patch)` that merges into the stored JSON without replacing
other keys.

| On | Field | Type | Set when |
|---|---|---|---|
| user message | `voice.utteranceId` | string | dispatch |
| user message | `voice.sttProvider` | string | dispatch |
| user message | `voice.audioMs` | number | dispatch |
| assistant message | `voice.spokenText` | string | barge-in (what was heard), or the reply's end (all of it) |
| assistant message | `voice.interrupted` | boolean | barge-in |
| assistant message | `voice.ttfaMs` | number | the first audio byte of the reply |
| assistant message | `externalTurn` (top level, not under `voice`) | `true` | stored by the transcript sync for a reply the engine wrote outside a gateway turn (a background-work report, a reply typed in the terminal); voice speaks these rows. Written whether voice is on or off |

Validation: strings capped at the message length cap; `audioMs` and `ttfaMs` are
non-negative integers. The web reads `voice` to draw the spoken mark, the unheard tail
and the TTFA readout. Absent `voice` means a typed message, exactly as today.

## BackgroundedWork (reported, not stored)

| Field | Type | Notes |
|---|---|---|
| `taskId` | string | the engine's id (Claude's background task id) |
| `description` | string \| null | command or tool description |
| `startedAt` | epoch ms | |

Sent as a `background` frame and shown as a chip on the chat. Completion arrives through
the engine's existing wake-up (Claude's task notification), and its reply is spoken like
any other.

## Provider (configured, resolved at load)

`ResolvedVoiceConfig` (see [contracts/voice-config.md](contracts/voice-config.md)) holds
every default filled. Keys are resolved from `${VAR}` only at provider construction and
are never put on a resolved object that is serialised.
