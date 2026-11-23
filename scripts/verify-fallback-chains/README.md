# Fallback chains: fake-provider verification

`scripts/verify-fallback-chains.sh` brings up a throwaway gateway against fake providers and
drives the fallback chain scenarios through its real HTTP API. Testing a chain must never
spend real usage or quota, so only the upstream providers are fake: the gateway, config
loader, runner and web are the real ones.

```sh
scripts/verify-fallback-chains.sh                    # build, then every scenario in opencode run mode and server mode
scripts/verify-fallback-chains.sh --skip-build       # reuse the existing build
scripts/verify-fallback-chains.sh --only a,f         # some scenarios
scripts/verify-fallback-chains.sh --mode server      # one opencode mode
```

Put the pinned Node first on `PATH` (or set `HUNDREDFOLD_VERIFY_NODE_BIN`), as for the other verify
scripts. Exit status is 0 unless a scenario that is not pending fails.

## What is real and what is fake

| | |
|---|---|
| Real | the gateway build, its config loader and `PUT /api/config`, the interactive Claude engine (PTY, `--settings` hooks, transcripts), the opencode adapter in `run` and `server` mode, the chain runtime, the web app |
| Fake | `claude` (`scripts/fake-providers/fake-claude.mjs`) and `opencode` (`packages/hundredfold/src/engines/__tests__/fixtures/fake-opencode.mjs`), both steered by one scenario file and both appending to one ledger |

The instance runs under `env -i` with a temporary `HUNDREDFOLD_HOME`, `HOME` and XDG directories, two
fake Claude profile directories (`profile-a`, `profile-b`) declared under
`engines.claude.accounts`, the stubs as absolute `engines.<engine>.bin`, no codex, grok or
hermes, and the browser MCP server switched off (it is an `npx` fetch). `npx` and `npm` are
stubs that do nothing, and `HUNDREDFOLD_CLAUDE_USAGE_API=off` stops the usage lookup that would send
a token to the real service. A guard preloaded into every Node process refuses, and logs to
`network-refusals.jsonl`, any connection that is not loopback; a scenario fails if the log is
not empty.

Where a scenario restarts the gateway in the middle of an opencode conversation (`ot`), it asks the fake `opencode` to keep the
ids of the sessions it creates in a file (`h.keepOpencodeSessions()`, `FAKE_OPENCODE_SESSIONS_FILE`), as opencode keeps its
sessions in its data directory, so a restarted server still finds the session a turn resumes. Every other scenario starts each
server with no sessions, as before.
A remote employee runs on a "host" that is this machine, reached through a stand-in `ssh` (see
[Remote employees](#remote-employees-and-the-stand-in-ssh)): there is no sshd, no key and no network.

The script refuses to start when the port is below 8060 or one of the live gateway ports, or
when any path (instance home, host home, profile directory) is outside its temporary root or
inside an operator home. It tears everything down on exit.

## Scenarios

`scenario-defs.mjs`, each printing `PASS`, `FAIL` or `PENDING`:

| id | |
|---|---|
| a | claude/A/opus → claude/B/sonnet → opencode/X → opencode/Y walks hop by hop; each hop's profile directory and model, the recorded hops and `servedBy` |
| b | every link limited: each target tried once, then the session waits on its own target |
| c | loop guard: legacy entries that form a cycle never retry a target |
| d | an employee chain overrides the engine default |
| e | a legacy string-only config behaves as on main |
| f | `PUT /api/config` refuses a duplicate target (and a link equal to its own target) with the clear sentence |
| g | a profile hop starts a fresh run carrying the conversation, with no `--resume` of A's session id under B; a model hop on the same thread resumes it |
| h | an opencode provider hop X → Y within one opencode session |
| i | the own target serves again from the first turn after its limit reopens (a real wall-clock reset a few seconds out), and not before |
| j | an own target still limited at the reset is probed once; the next turns, inside the new window, do not probe it again |
| k | a stand-in held by a window an hour out returns to its own target at the next turn once `hundredfold limits --clear` clears that target |
| l | a session whose chain ran out on its stand-in, waiting for the stand-in's reset, hands back to its own target within a minute of that target being cleared |
| m | a message from another session (sent as `send_to_session` sends it) whose turn hits a limit on A reaches B, which starts fresh, in full |
| n | a Monitor armed on the own account when a limit moves the session is named in the stand-in's first prompt (the ledger keeps the note as `gatewayNote`), with no separate nudge turn, and is not owed afterwards |
| o | a Monitor armed on the stand-in is named in the prompt of the turn that goes back to the own account once its target is cleared |

### Account groups

`group-scenarios.mjs` drives a chain whose first entry is a group of the two fake accounts
(`{ group: [A, B] }`, then an opencode link) on the employee that runs as A. Usage is seeded the way
the gateway reads it: `h.seedUsage(accountKey, usedPercent)` writes one fresh sample to that account's
usage history file under the instance's engine-limits directory (`h.useGroup()` puts the chain in place
and returns the accounts' store keys). No provider is called. Each scenario reads `fallback.chain.pick`
(with each candidate's `weight` and `sharePercent`) and the ledger's profile per turn, and asserts
the two agree.

| id | |
|---|---|
| p | distribution: headroom 60/40 splits 20 spaced sessions 12/8, 90/10 splits 18/2, a member with no headroom gets none of 10; each count within ±1 of what is stated |
| q | burst: ten sessions started at once (`Promise.all`) across two equally fresh accounts split 5/5 ±1, never all on one |
| r | group hop then rest: a limit on the own account moves the turn to the other member, a limit there moves it to opencode; hops in order |
| s | the same walk from the other side: a session the pick put on B moves to A, then opencode |
| t | stickiness: a session pinned to A takes five turns and a turn after a gateway restart while B's usage drops below A's; every turn on A, no hop, the pick unchanged |
| u | return: pinned to B, moved to A by B's limit; once B is cleared the next turn is back on B |
| v | start paths: new chat (with and without `engine: "claude"`), spawn, delegate and Todo dispatch each get a pick; `engine: "claude:A"` gets none; a board walk tick is driven too |

The board walk starts a Todo through the same dispatcher call the button uses (the Todo dispatch case);
what it decides is a model turn, and the fake model calls none of the walk's tools, so `v` checks that a
tick runs its turn and starts nothing by itself. `h.restartGateway()` stops and starts the instance
through the sandbox helper (`--helper`, `--instance`, which the script passes).

p, q, s, t, u and v assert the pick a session records at creation, which the start paths pin.
Every scenario runs and counts: the default `--pending` list is empty.

### opencode account groups

`opencode-group-scenarios.mjs` runs the counterparts of p to v for a group of two opencode accounts
(`{ group: [{ engine: opencode, profile: oc-a }, { engine: opencode, profile: oc-b }] }`, then an opencode link as the
rest of the chain). An opencode account is a provider id, so the two accounts are two fake providers that the fake
`opencode models` lists with one model key: account A is the opencode employee's own provider
(`own-provider/model-own`) and B is `group-b-provider/model-own`. `h.useOpencodeGroup()` declares them under
`engines.opencode.accounts` and puts the group at the head of `engines.opencode.fallback`, or, with `{ on: "employee" }`,
of the opencode employee's own `fallback`; `reset` takes both away. Headroom is seeded the way the gateway reads it: one
sample in the history keyed `opencode/<provider>` (`h.seedUsage("opencode/group-b-provider", 40)`).

Every scenario asserts that three things agree for each session it starts: the pick (`transportMeta.accountPick`, also
`fallback.chain.pick`), the session row's `model` (`<picked provider>/<model key>`, which is the pin) and the model the
fake opencode ran each turn on (the ledger's `model`). They run in both opencode modes like every other scenario.

| id | |
|---|---|
| op | distribution: headroom 60/40 splits 20 spaced sessions 12/8, 90/10 splits 18/2, an account with no headroom gets none of 10; each count within ±1 of what is stated |
| oq | burst: ten sessions started at once across two equally fresh accounts split 5/5 ±1, never all on one |
| or | group hop then rest: a limit on the picked account (A) moves the turn to B's model, a limit there moves it to the chain's next link; the stand-in runs on the member's model |
| os | the same walk from the other side: a session the pick put on B moves to A, then to the next link |
| ot | stickiness: a session pinned to A, and one pinned to B, each take five turns and a turn after a gateway restart while the other account's usage drops below it; every turn on the pinned model, no hop, the pick unchanged |
| ou | return: pinned to B, moved to A by B's limit; once B is cleared the next turn is back on B's model |
| ov | start paths: new chat (no engine, `engine: "opencode"`, no employee, the employee's own model), spawn, delegate and a Todo wake each get a pick; a model named on the other account's provider gets none; the Todo Dispatcher (the instance's default engine) none; a board walk tick runs |

### Remote employees and the stand-in ssh

`remote-group-scenarios.mjs` runs the remote counterparts of p, r, t and u on the instance itself, where part G's tests
answered ssh with a local shell inside a SessionManager. The remote employee (`dev-remote`) has the target
`harness@127.0.0.1` and runs as remote account A (its `remoteClaudeConfigDir`); the scenarios declare two remote accounts
(`remote-a`, `remote-b`, directories under the remote home) and put them in a group as its chain.
The real gateway stages the host, opens its tunnel and runs the fake `claude` there; a pick of A is the employee's own login
and writes no pin, a pick of B is recorded in `transportMeta.remoteAccountPin` (`{ account, configDir }`), and each turn's
`CLAUDE_CONFIG_DIR` is what the host ran with, read back from the ledger's profile directory.

| id | |
|---|---|
| rp | distribution: headroom 60/40 splits ten spaced sessions 6/4, an account with no headroom gets none of four; the pin, the pick and the directory the host ran each session with agree |
| rr | group hop: a limit on the own login moves the turn to the other account's directory; a limit on a pinned account moves it to the own login; the pin does not move |
| rt | stickiness: a session pinned to the second account keeps its directory over five turns and a gateway restart while the other account's usage drops below it, pin and pick unchanged |
| ru | return: pinned to the second account and moved by its limit, the next turn after it is cleared runs with the pinned account's directory again |

What the stand-in `ssh` is (`ssh-shim.mjs`, installed as `ssh` first on the instance's PATH by `seed.mjs`):

- It accepts only `user@127.0.0.1` and the options the gateway passes (`-T`/`-tt`, `-o`, `-R`, `-L`). Anything else exits 255
  and is written to `ssh-shim-refusals.jsonl`; a scenario fails if that file is not empty, as it does for the network guard's
  log. It never runs the real `ssh`, and the scenarios fail if the shim answered nothing.
- It runs the command words in a local `sh -c`, as sshd would, with exactly a host's environment and nothing of the gateway's:
  `HOME` is a temporary remote home inside the verification root (`remote-<mode>/`, holding the staging directory, two signed-in
  fake Claude profile directories, a work directory and a `bin/` with the fake `claude` and a `hundredfold` that runs the build under
  test), the network guard is preloaded into its Node processes, and the fakes read the same scenario and ledger files.
- `-R port:127.0.0.1:port` is a loopback forwarder from the tunnel port to the gateway's port for as long as the command runs,
  which is what carries the hook relay's calls.
- The gateway's own home is the host's `mount` (the host is this machine, so the sentinel read comes back the same).

The gateway's host readiness probe reads the system-wide Claude policy directories (`/etc/claude-code`, and the macOS
equivalent) for a bypass-permissions consent. A real host's are its own, so the shim points those two paths at (empty)
directories inside the remote home: the run reads nothing outside the verification root and writes nothing outside it.
The only things it executes from outside are the system tools a shell needs (`sh`, `ps`, `git`, `node`).

`--pending a,b` marks scenarios that wait on runtime work not yet merged: a pending scenario is
reported, never failed; one that passes is reported as "pending but passing", and `--strict` fails the
run on it. Put an id in `DEFAULT_PENDING` in `verify-fallback-chains.sh` for work that is not merged yet,
and drop it when the work lands.

To check the gateway of another checkout against this harness's fakes and scenarios (for
instance `main`, to confirm scenario e passes there too), set `HUNDREDFOLD_VERIFY_GATEWAY_REPO`.

## The ledger proves who served each hop

Every turn a fake takes is a line in the ledger (`$VERIFY_ROOT/ledger.jsonl`; `--retain DIR`
copies it out): time, engine, profile directory and label, model, the `--resume` id it was
given, the conversation id it ran in, the start of the prompt, the message marks it carried,
the outcome and the scenario key that gave it. Scenarios read it back by the tag their prompts
carry (`fc-tag-…`), so the walk is checked against what the providers actually ran, not
against what the gateway says it did.

## Scenario file

`FAKE_PROVIDER_SCENARIO=<path>` maps invocations to outcomes (the driver rewrites it per
scenario; the fakes read it on every invocation):

```json
{
  "claude":   { "profile-a|opus": ["rate-limit", "ok"], "profile-b|*": "ok", "*": { "outcome": "rate-limit", "resetsAt": 4102444800 } },
  "opencode": { "x-provider/model-x": "rate-limit", "*": "ok" }
}
```

Claude keys are `<profile>|<model>`: the base name of `CLAUDE_CONFIG_DIR` (`default` for the
gateway's own profile) and `--model`. Opencode keys are `provider/model`, from `-m` on a run
turn or the model in the prompt body on a server turn. The exact key wins, then
`<profile>|*`, `*|<model>`, `*`. A list is a sequence: the nth invocation of a key takes the nth
item and the last repeats.

| outcome | claude | opencode |
|---|---|---|
| `ok` | answers, naming profile and model | answers, naming model and mode |
| `rate-limit` | statusline with the reset (`resetsAt`, epoch seconds, default one hour), then `StopFailure` with `error: "rate_limit"` | the 1.x limit error (`"form": "v2"` for 2.x's); in server mode the provider's retries, then the error |
| `retry-abandon` | | a retry an hour off, which server mode abandons after about 15 s as a rate limit |
| `hang` | never stops | never answers |
| `fail` | `StopFailure` (`max_output_tokens`, or `"error"`) | an error that is not a limit |

A claude outcome may add `"armMonitor": "<task id>"`: its turn arms a background Monitor of that id (a `PostToolUse` for the Monitor tool), and the ledger keeps the gateway's note about background tasks a prompt carries, as `gatewayNote`.
| `signed-out` | `StopFailure` `authentication_failed` | as `fail` |

While a scenario file is set, a prompt's own words steer nothing, so the older `HANG`,
`FAIL`, `PROVIDER…` directives in the opencode fixture stay available to the engine tests and
are off here.

The fake Claude files its transcripts under the profile's `projects/` directory, refuses to
resume a conversation another profile owns, and checks the profile's `.credentials.json`.
Its credentials hold no token, so nothing can use them.

## Keeping the instance up for screenshots

```sh
scripts/verify-fallback-chains.sh --skip-build --mode run --only a --keep --retain ./evidence > run.log 2>&1
```

`--keep` leaves the last instance running and prints its URL, home (the token is
`gateway.json` there) and the teardown command; redirect its output to a file, as above, or a
caller waiting on the pipe waits on the gateway. Drive a browser at it (headless Firefox, or
Chromium), then:

```sh
scripts/verify-fallback-chains.sh --teardown <verification root>
```

`--retain DIR` collects the ledger, the network log, each mode's results JSON and the gateway
logs.

## Adding a scenario

1. Append `{ id, title, run }` to `SCENARIOS` in `scenario-defs.mjs`. `run(h)` gets the harness
   (`lib.mjs`): `h.putConfig(...)` writes config through the real API, `h.writeScenario(...)`
   scripts the fakes, `h.startSession({ employee, tag })` and `h.settled(id)` drive a session,
   `h.rowsFor(tag)` reads the ledger, and `expectEqual` / `expectTrue` assert. The seeded
   employees and models are in `seed.mjs` (`h.layout`).
2. Reset is automatic before each scenario (sessions, engine health, chains, scenario file).
3. If it needs runtime work that is not merged, add its id to `--pending` in the script's
   default.
4. A new outcome or key shape goes in `scripts/fake-providers/scenario.mjs` and is covered by
   `packages/hundredfold/src/engines/__tests__/fake-providers.test.ts`.
