# T037: does Esc background a running Bash on Claude Code?

Claude Code 2.1.330, the real CLI in a PTY, a model-driven turn running one foreground
`Bash` command (a Node script that writes a heartbeat line every second and a marker file
when it ends; a plain `sleep N && ...` is refused by the CLI in the foreground). Hooks
relayed to a log. Keys written straight to the PTY. Each row is one run.

| # | Keys | Command | Hook stream and transcript | Verdict |
|---|---|---|---|---|
| 1 | Esc while the command runs | heartbeat, then `SIGTERM` | `PreToolUse`, then no `PostToolUse`, no `Stop`. Tool result: "The user doesn't want to proceed with this tool use", then "[Request interrupted by user for tool use]". PTY alive. No notification | Esc kills the command |
| 2 | Same, with `CLAUDE_AUTO_BACKGROUND_TASKS=1` | `SIGTERM` | Identical to 1 | The flag changes nothing |
| 3 | Ctrl+B, then Esc 2.5 s later (command running >4 s) | ran to its end, marker written | `PostToolUse` with `tool_response.backgroundTaskId`, `backgroundedByUser: true`; tool result "Command was manually backgrounded by user"; "[Request interrupted by user]"; no `Stop`. At the command's end `UserPromptSubmit` with `<task-notification>` (status completed), then `Stop` | Works: survives, process stays, notification wakes the session |
| 4 | Ctrl+B and Esc in the same tick | ran to its end | No `PostToolUse` (tool result reads as rejected); the task id arrives only in the later `<task-notification>` | Survives, but no id from the hook stream |
| 5 | One Ctrl+B at 1.2 s, and one at 3 s after `PreToolUse` | `SIGTERM` at the later Esc | No `PostToolUse` | Ctrl+B is ignored early |
| 6 | Ctrl+B every 700 ms from `PreToolUse` | ran to its end | `PostToolUse` with the task id after about four seconds; the other presses did nothing | Retrying is harmless |
| 7 | Ctrl+B then Esc, no tool running (an essay turn) | | Nothing happens; PTY stays | Harmless |
| 8 | Paste a message plus CR while the command runs (steer) | ran to its end | `UserPromptSubmit` at once (queued); delivered only when the command ended, about 40 s later; never backgrounded | Steer does not cut in on long work |
| 9 | Esc before any output, then paste a new prompt | | The next `UserPromptSubmit` carries the interrupted prompt followed by the new one | Esc restores the prompt to the composer; clear it |

`backgroundedByTurnAbort` and `backgroundedToDeliverMessage` appear in the binary but never
showed in these runs; the schema describes the first as "a plugin's turn abort". No
environment flag is needed for Ctrl+B.

The gated live test `claude-interactive-soft-interrupt-live.test.ts` repeats rows 3 and 9
through the engine's `softInterrupt` (both pass): the command is moved to a background task
whose id comes from the hook stream, the turn settles as interrupted, the PTY is the same
object throughout, the marker file is written, and the notification wakes the session; and
after a pre-output soft interrupt the next turn arrives with only its own prompt.
