# Fallback chains: usage-balanced account groups

Status: design, settled. Builds on [fallback chains](../fallback-chains.md).
Sections 1 to 9 shipped first (Claude accounts on the gateway); sections 10
and 11 extend the same pick to opencode accounts and to remote employees.

## Problem

A chain is a fixed order, so the first link always serves new sessions,
whatever its remaining allowance, and a sibling account is used only after a
limit hit. Giving each role its own first account (builders on account A,
reviewers on account B) drifts: one account runs out early in the week while
another ends it with allowance unused.

## What this adds

A chain entry may be a **group**: a set of Claude accounts. When a new
session starts and its own account is in the group at the head of its chain,
the gateway picks a member, spreading new sessions across the group in
proportion to each account's usage headroom, pins the session there, and makes
the group's other members its next fallback links (most headroom first), ahead
of the rest of the chain.

```yaml
# before: fixed order, account "work" always serves new sessions
fallback:
  - { engine: claude, profile: spare }
  - { engine: opencode, model: opencode-go/glm-5 }

# after: new sessions are spread across the default login, "spare" and "work"
# in proportion to their headroom; the other two are each session's next links
fallback:
  - group:
      - { engine: claude }                 # the default login
      - { engine: claude, profile: spare }
      - { engine: claude, profile: work }
  - { engine: opencode, model: opencode-go/glm-5 }
```

Opt-in: a chain with no group parses, resolves and walks exactly as before.

## Hard calls

### 1. Config shape

- A group entry is `{ group: FallbackLink[] }`. Each member is an ordinary
  object link with `engine: claude` and an optional `profile`. A member with no
  profile is the default Claude login, as for any link.
- Valid only when: at least two members; every member `engine: claude`; no
  member names a `model` (a member is an account; the model is the session's
  own, or the link rules for a hop); members distinct; every `profile` a
  declared account (local or remote); no nesting; no string members.
- A group member counts toward duplicate detection like any link: a member
  that is also a standalone link in the same chain is a duplicate (warned and
  de-duplicated at load, refused on save, as today).
- The self-link rule is relaxed for groups only: a group may list the chain's
  own account. That is how balancing is switched on.
- Allowed in employee chains, `engines.claude.fallback` and
  `engines.claude.accounts.<name>.fallback`. A group of opencode accounts is
  section 10; any other engine in a group is a load error.
- Wire: `FallbackChainEntry = string | FallbackLink | FallbackGroupEntry`,
  with `interface FallbackGroupEntry { group: FallbackLink[] }`, in
  `fallback-chain-wire.ts`, and `fallbackGroupOf(entry)` beside
  `fallbackLinkOf`. Validation sentences live there, shared by the loader and
  the Settings editor.

### 2. Resolution stays a flat list

The resolver expands a group in place into its members as ordinary
`ResolvedFallbackLink`s, so the walker, health, hop records and session view
keep working on exact single targets. Each member link gains:

```ts
group?: {
  index: number;            // the group's entry index in the written chain
  written: FallbackGroupEntry; // the group as config spells it (what an editor writes back)
  headroom?: AccountHeadroom;  // the ranking input, see 4
};
```

Members are ordered by the ranking in 4, at the time of resolution. The own
account, when it is a member, is index 0 of the effective chain (as the own
target always is) and is dropped from the group's expansion.

### 3. When balancing applies (the "home group")

The balancer picks a session's own account only when all of these hold:

- the session will start on Claude and the caller did not name a profile
  (`engine: "claude:<name>"` pins that account, no balancing). A caller that
  names `engine: "claude"` or a model is still balanced: every member is Claude,
  so the named engine and model are honoured either way;
- the session's chain (employee, else account, else engine default, as
  today) has a group as its **first entry**, and that group contains the
  account the session would otherwise run as (its employee's login: the
  default login, or the declared account whose directory is the employee's
  `claudeConfigDir`; for an employee-less session, the default login);
- the session runs on the gateway, or on a remote employee's host with the
  rules of section 11.

Anywhere else a group is a block of fallback links, ordered by headroom when
the chain is resolved.

A member that cannot serve the session (the existing skip reasons: `remote`,
`scoped`, `profile-unknown`, `not-installed`) is not a candidate. The default
login member is not a candidate for an employee whose own login is a named
profile (the session row has no way to say "default login" over an employee's
profile); it stays a fallback member.

### 4. The pick: a split weighted by headroom

The balancer does not always take the account with the most headroom. Usage
readings lag (they refresh every 15 minutes) and sessions start in bursts (a
board walk, a plan fanning out children), so "take the best" would send a whole
burst to one account. New sessions are spread across the group **in proportion
to headroom** instead.

Input per candidate: the newest usage sample of its account
(`latestAccountReading`, the per-account history the 15-minute engine-health
refresh writes) and its engine-health record.

- **Headroom** = 100 − the highest `usedPercent` across the windows that apply
  (the tightest window wins). A window whose `resetsAt` has passed counts as 0
  used. A window scoped to a model (a sample window named `7d <model name>`)
  applies only when the session's model is of that family (case-insensitive
  match of the family word, e.g. `7d Opus` for an `opus` or `claude-opus-*`
  model); `5h`, `7d` and a scoped window naming no model always apply, and so
  does every window when the session's model is unknown. Whole percent (floor).
- **Freshness**: a sample is fresh when it is at most
  `2 × ENGINE_HEALTH_REFRESH_INTERVAL_MS` (30 minutes) old, stale when older,
  unknown when there is none.
- **Weight (the curve)**, linear in headroom:

  | Candidate | Weight |
  |---|---|
  | fresh reading | headroom |
  | stale reading | headroom ÷ 2 |
  | no reading, while another candidate has one | 0 |
  | no candidate has a reading | 1 each (an even split) |
  | at its limit (health says exhausted, or its login is signed out), or headroom 0 | 0 |

  An account's share of new sessions is its weight over the sum of weights.
  So headroom 60 vs 40 splits 60/40, 90 vs 10 splits 90/10, 50 vs 50 splits
  evenly, and an exhausted account gets none. The curve is monotonic and never
  starves an account with headroom: any account above 0 gets its share.
- **Selection: smooth weighted round-robin**, deterministic. Each candidate
  set (keyed by its sorted account keys) keeps a credit per account, in
  memory. At each start every candidate's credit grows by its weight, the
  highest credit wins (ties: the group's written order), and the winner's
  credit drops by the sum of the weights. Over any run of starts the counts
  follow the weights as closely as whole numbers allow (60/40 gives
  A B A B A, repeating), and a burst inside one reading interval splits by
  construction, because each start is charged to its account at once: the
  credit is the record of starts the usage data has not seen yet. Credits
  start at 0 after a restart. No randomness, so tests assert exact counts.
- **Charged only on a real start.** The pick is computed by a pure function;
  the credit is charged by a separate `recordAccountStart` call made only
  after the session row is created. Validation-only calls (dispatch config,
  previews, `startPick`, the board walk's view) never charge it.
- **All weights 0** (every member exhausted): pin the member whose health
  record reopens first, then let the existing creation reroute
  (`rerouteAtCreation`) move the session to the first healthy link after the
  group, with the pinned account as the own target it returns to.
- The pick never calls a provider: it reads only what is on disk, in health
  and in its credit table, so creation stays synchronous and cheap.
- **Fallback order inside a group** is not weighted: when a limit moves a
  session along its chain, the group's remaining members are tried by
  headroom, highest first (stale and unknown after fresh, exhausted last,
  ties by written order), then the rest of the chain.

### 5. Pinning and stickiness

- The pick is stored where a chosen profile already is: the session's
  `claudeConfigDir` column (`sessions/primary-profile.ts`, read by
  `session-account.ts`). A pick equal to the employee's own login stores
  nothing there, so that session's row is byte-identical to today's.
- The pick is recorded in `transportMeta.accountPick` (shape in 8) for the chip
  and the API.
- The balancer runs **only** at session creation and on a deliberate switch
  that names Claude without naming a profile (`switch_session` /
  `compact_session` with `engine: claude` and no `profile`, or the selector's
  engine-only switch onto Claude). A switch that names a profile pins that
  profile and clears `accountPick`.
- Nothing else re-picks: not a turn, not a resume, not a restart, not a
  session reset, not a revert. A usage limit walks the chain (the group's other
  members next, in headroom order) and the return at the reset goes back to the
  pinned account, because it is the session's own target.

### 6. The chain of a balanced session

A balanced session keeps the chain the group came from. A session pinned to
`spare` by a group in `engines.claude.fallback` is not switched to
`engines.claude.accounts.spare.fallback`: `accountPick.source` names the
subject, and `sessionFallbackChain` uses it ahead of the account chain. Its
effective chain is `[pinned, other members by headroom, rest of the chain]`.

### 7. Walking through a group

`nextFallbackLink` treats a group block as a set: when the cursor is on a
member, or the next untried link is a member, every untried member of that
block is considered (in the resolved, headroom order) before the walk moves
past the block, wherever the member sits relative to the cursor. The run's
tried set stays the loop guard, so a re-ordering between resolutions can
neither skip a member nor revisit one. Hop records, notices and the run meta
are unchanged.

The return to the own target after a reset (engine override `originalAccount`,
held overrides, stand-in waits) uses the session's own account: the pinned
account, never the employee's login and never the group's first member. Every
place that computes the original account from the employee
(`accountForEmployee`) on a session path must read the session's own account
instead.

### 8. Wire additions

```ts
interface AccountHeadroom {
  account: string;               // account key
  label: string;
  state: "fresh" | "stale" | "unknown" | "exhausted";
  headroomPercent?: number;      // absent when unknown
  tightest?: { window: string; usedPercent: number; resetsAt?: string };
  readingAt?: string;            // ISO time of the sample
  weight: number;                // per the curve in 4
  sharePercent: number;          // weight over the sum of weights, whole percent
}

interface AccountPick {
  at: string;                    // ISO
  trigger: "start" | "switch";
  source: FallbackChainSource;   // the subject whose chain holds the group
  groupIndex: number;            // its entry index in that chain
  picked: string;                // account key
  reason: "weighted" | "only-candidate" | "no-readings" | "all-exhausted";
  candidates: AccountHeadroom[]; // with the weights at the time, by headroom, highest first
}
```

- `SessionFallbackChainView.pick?: AccountPick`, from `transportMeta.accountPick`.
- `FallbackChainSubject.startPick?: AccountPick`: for an employee or engine
  subject whose chain has a home group, what a new session would pick now.
- A department-scoped caller reading its own session gets `pick` without
  `headroomPercent`, `tightest`, `readingAt`, `weight` and `sharePercent`
  (a fresh account's weight is its headroom), matching the existing rule that
  strips `usedPercent`/`window`. It keeps each candidate's account, label and
  state, and the reason.
- `startPick` shares are over the whole home group, own account included; a
  group link's member `headroom.sharePercent` is over the members the link
  lists (the own account is index 0 of the chain, not a member there).

### 9. Out of scope

- Probing an account at pick time.
- A group mixing engines (a Claude account and an opencode account in one
  group): refused at load, "a group's members all run on one engine".
- A `profile` on a standalone opencode link: an opencode account is still
  named outside a group by its provider in the model (`opencode-go-b/glm-5`).

### 10. opencode account groups

An opencode account (`engines.opencode.accounts`, see
[opencode accounts](opencode-accounts.md)) is a provider id: account `go-b`
with `provider: opencode-go-b` serves `opencode-go-b/<model>`. All accounts
share one opencode data directory, so moving a session from
`opencode-go/glm-5` to `opencode-go-b/glm-5` is "same thread, other model" and
the conversation carries over. That decides where the pin lives.

**Spelling.** A member names an account by `profile`, as a Claude member does:

```yaml
engines:
  opencode:
    model: opencode-go/glm-5
    accounts:
      go-a: { provider: opencode-go }                  # the built-in provider, declared so a group can name it
      go-b: { provider: opencode-go-b, base: opencode-go, keyEnv: OPENCODE_GO_B_API_KEY }
    fallback:
      - group:
          - { engine: opencode, profile: go-a }
          - { engine: opencode, profile: go-b }
      - { engine: claude }
```

- Every member is `engine: opencode` with a `profile` naming a declared
  opencode account; no member names a model; at least two distinct members;
  no nesting, no strings. An opencode member with no profile is refused ("an
  opencode group member names its account with profile").
- Valid only in a chain whose own target runs on opencode: an opencode
  employee's `fallback` and `engines.opencode.fallback`. Elsewhere it is a load
  error ("an opencode group balances an opencode session's own model; put it in
  an opencode employee's chain or engines.opencode.fallback"), because a member
  has no model of its own to run.
- Validation sentences live in `fallback-chain-wire.ts`, shared with the editor,
  which is given the opencode account names beside the Claude ones.

**Own account and model key.** The session's own account is the declared
opencode account whose `provider` is the provider of its subject's own model
(the employee's `model`, else `engines.opencode.model`). The model key is that
model without its provider: `opencode-go/glm-5` gives `glm-5`. A subject whose
model's provider is not a declared account has no own account and is never
balanced (declare the built-in provider as an account to include it, as `go-a`
above).

**Expansion.** A member resolves to the link
`{ engine: opencode, model: <member provider>/<model key> }`, tagged with its
group like a Claude member. A member whose account does not serve that key
(not in the model registry as available: outside the account's `models`, a
model on another endpoint under OpenCode 1.x, a base with no clone records) is
resolved with the existing `model-not-served` skip: it is no candidate and no
fallback link for that session. The group's ranking key for a member is its
health key `opencode/<provider>`; `ResolvedFallbackLink.account` stays
`opencode`, as for every opencode link, so nothing outside the group code
changes meaning.

**When balancing applies.** As in 3, with "Claude" read as "opencode": the
session starts on opencode; its chain (employee, else
`engines.opencode.fallback`) has an opencode group as its first entry that
holds the own account; and the caller did not choose an account. Naming a
model on the own account (`opencode-go/kimi`) is still balanced, across the
members that serve `kimi`. Naming a model on any other account
(`opencode-go-b/glm-5` for a subject on `go-a`) chooses that account: no
balancing, the opencode counterpart of `engine: "claude:<name>"`. Start paths
that pass the employee's own model are therefore balanced.

**Headroom readings.** The engine-health refresh (every 15 minutes) already
computes, per opencode provider, the windows it writes to health
(`providerHealthBuckets`: OpenCode Go's own meter where the provider answered,
else the usage ledger's buckets for accounts with `usageLimits`). It now also
appends one sample per declared account to a per-account usage history keyed
`opencode/<provider>`, beside the Claude histories, with the same collapse,
retention and cap.

- Windows kept: `5h`, `7d` and `30d`. The provider's own meter and a ledger
  bucket for the provider's `*` apply to every model; a ledger bucket for one
  model is written as a scoped window `<window> <model key>` and applies only
  to a session on exactly that model key (exact match, not the Claude family
  match).
- A provider with no reading (no meter answer, no metered bucket) writes no
  sample: unknown, weight 0 while another member has a reading, an even split
  when none has.
- Freshness, the curve, the smooth weighted round-robin, the charge after a
  real start, the all-exhausted case and the fallback order inside the group
  are those of 4, unchanged. The credit table is shared; opencode keys
  (`opencode/<provider>`) never collide with Claude keys.
- **Exhausted**: health holds `opencode/<provider>` (the meter, or the
  provider's own quota, auth or expired-key refusal), or
  `opencode/<provider>/<model>` for the session's model.
- Caveat for the release note: OpenCode 2.x run mode records turns at $0 in the
  ledger, so a ledger-only account (no provider meter) reads as full headroom.
  The provider meter is the reading to rely on.

**The pin is the session's model.** opencode has no per-session account
setting other than the model id, so the pick is stored in the session's
`model` column as `<picked provider>/<model key>`; a pick equal to the own
account leaves the model as it was. The pick is recorded in
`transportMeta.accountPick` as for Claude (`picked` and each candidate's
`account` are `opencode/<provider>` keys). `pinAccountAtCreation` returns the
pinned `model` beside `claudeConfigDir`, and every start path that applies a
pin applies it (the guard test lists them).

**Stickiness, switch and return.** As 5 to 7: the model column is the
session's own target, so turns, resumes and restarts keep it; a limit walks
the other members by headroom and then the rest of the chain; the return at
the reset goes back to the pinned model, because it is the own target. A
deliberate switch naming `engine: opencode` and no model re-picks; one naming a
model uses it and clears `accountPick`. A balanced session keeps the chain the
group came from (`accountPick.source`), read for the session's engine.

**Remote opencode employees** are balanced the same way: the pick is a model
id, and the readings are taken by the gateway (the provider's meter by key, the
ledger), not on the host. A member the host does not serve (its facts) is
skipped as for any link.

### 11. Balancing a remote employee's sessions

A remote employee's Claude runs on its host as that host's login, or as a
declared remote account on the same `user@host`
(`engines.claude.accounts.<name>.remoteHost`). Both questions the first release
left open already have an answer in the code:

**How the host reports headroom: it does not need to.** The engine-health
refresh reads every remote login (each remote employee's own, and every
declared remote account) over SSH every 15 minutes
(`engines/remote-account-usage.ts`) and appends the reading to that account's
usage history under its key, `claude@<user>@<host>[:<profile key>]`. The pick
reads those histories exactly as it reads a local account's. A host that does
not answer keeps its last sample, which turns stale after 30 minutes (half
weight) and is then outweighed by any fresh member; nothing is probed at pick
time.

**Candidates.** The home group's members the employee can run as on its
host: its own login (a member naming no profile, or the declared remote
account of its own directory) and declared remote accounts on its
`user@host`. A local profile or an account on another host keeps the existing
`remote` skip. The chain is the one a remote session resolves today (its
employee's, else `engines.claude.fallback`).

**Where the pin lives: `transportMeta.remoteAccountPin`.**

```ts
interface RemoteAccountPin {
  account: string;     // the picked remote account's key, claude@<user>@<host>:<profile key>
  configDir: string;   // its profile directory on the host
}
```

- Written at creation (and on a re-picking switch) when the pick is not the
  employee's own login; a pick equal to the own login writes nothing, so that
  row is byte-identical to today's (a re-picking switch onto the own login
  removes it).
- Never `sessions.claude_config_dir`: that column holds a directory on the
  gateway, and a remote session ignores it by design. Putting a remote path
  there would make a session whose employee later turns local read it as a
  local profile.
- Honoured only while the employee's current `user@host` is the one in
  `account`; otherwise ignored, and the session runs as its employee's login,
  as before. Undeclaring the account does not unpin a running session: the
  directory is in the record, as a local pin's is in its column.

**How the host receives the pin.** Every launch on the host already takes the
profile directory from one target, `sessionRemoteTarget` /
`withStandingRemoteAccount` (`sessions/session-account.ts`): the stage, the
folder-trust seed, the department sync, the turn, the terminal attach, the
background-session stop. That function's precedence becomes: a standing
account override's `substituteConfigDir`, else the pin's `configDir`, else the
employee's own (`remoteClaudeConfigDir`, else `remote.claudeConfigDir`). So the
host gets `CLAUDE_CONFIG_DIR=<pinned dir>` on every launch with nothing new on
the host. The session's own account (`ownClaudeAccount`, hence `threadSlot`,
health and the signed-in watch) is `pin.account`. Code that derives a remote
session's directory or own account from the employee directly moves onto these
two functions (known today: `claude-auth-watch.ts`, `remoteLaunch` in
`substitute-launch.ts`, `originalAccountOf` in `fallback-reroute.ts`); a guard
test fails if a session path calls `resolveRemoteClaudeConfigDir` on an
employee outside them.

**Stickiness, switch and return** are 5 to 7 unchanged: the pin is the own
target, a limit walks the other members by headroom, and the return at the
reset goes back to the pinned account's directory, never the employee's.

**Live verification (part I).** Part G proved the above with SessionManager tests that answer ssh with a local shell. The
fake-provider harness (`scripts/verify-fallback-chains.sh`, scenarios `rp`, `rr`, `rt`, `ru`) now runs it on a throwaway
instance: a remote employee whose target is `user@127.0.0.1`, reached through an `ssh` stand-in placed first on the instance's
PATH, which runs the host's commands in a local `sh -c` under a temporary host home with the fake `claude` first on its PATH.
The real gateway stages that host, opens its reverse tunnel and launches there; the scenarios assert
`transportMeta.remoteAccountPin`, `transportMeta.accountPick` and the `CLAUDE_CONFIG_DIR` each turn ran with.
Isolation, piece by piece: no sshd and no listener other than loopback ones (the tunnel's forwarder, the staging port probe);
no real `claude` (the fake, linked into the host home's `bin/`); every path the host touches (its home, profile
directories, staging, the system-wide policy directories the readiness probe reads, which the stand-in maps into the host
home) is inside the verification root; the caller's home and `~/.ssh` are never an environment, argument or path; the stand-in
refuses any destination but `user@127.0.0.1` and every option the gateway does not use, and a scenario fails if it refused
anything or if the network guard's log is not empty.
Not covered by the live run, because the harness cannot make it real without a real host: the gateway's own 15-minute
read of a remote account's usage over SSH (the fake profiles hold no token, so nothing is read; the scenarios seed the
histories the pick reads, as the Claude and opencode ones do), the terminal attach (`-tt` with a person at it), and a remote
opencode employee (the fake `opencode` is not on the host's PATH). The usage read has its own unit tests
(`remote-account-usage`); the other two are exercised by no scenario here (the third is §10's "remote opencode
employees", not run).
The first live run found a gap in the start paths: a new chat or spawn of a remote employee recorded the pick but dropped the
pin (`spawn-session.ts` copied `accountPick` and `claudeConfigDir` from the validated selection and not
`remoteAccountPin`), so the session ran as the employee's own login. Fixed in the same change, with a test that fails without it.

## The follow-up in parts

| Part | Scope |
|---|---|
| E | opencode groups core: wire and validation, loader, resolver expansion and ranking keys, the per-account opencode usage history written by the engine-health refresh, `startPick` for opencode subjects, credits reset on a group change in any engine's chain, doctor, docs |
| F | opencode pin: `pinAccountAtCreation` returns the pinned model and every start path and the switch apply it, the balanced chain read for the session's engine, the return path, stickiness tests |
| G | Remote balancing: `remoteAccountPin`, `sessionRemoteTarget` / `ownClaudeAccount` precedence, the start path and switch, the return path, the guard test, tests with SSH answered locally |
| H | Web: the chain editor's group link takes opencode members (an account select of opencode accounts); the diagram, chip and picker show opencode and remote picks |
| I | Fake-provider harness: the scenarios p to v for an opencode group; the remote equivalents as SessionManager tests, and on a throwaway instance |

## Every way a session starts

The pick happens in one function, `pinAccountAtCreation`, called from the two
places a new session's target is chosen: `validateNewSessionSelection`
(API new chat, spawn, delegate, Todo dispatch, dispatch config, switch) and
`newSessionEngineSelection` (connector-routed sessions). Every other
`createSession` call site (Todo dispatcher, Talk, Talk delegation adapter,
Todo capture, terminal, remote MCP principal) either goes through one of those
two or is listed in a guard test with the reason it does not start an agent
session on Claude. The board walk's view of which account a Todo would run on
(`walkAccounts.of`) uses the same pick as a preview.

## Release note (operators)

Existing chains keep working unchanged and get no balancing. To balance,
operators must edit their fallback chains (each employee's `fallback`, and
`engines.claude.fallback` / `engines.claude.accounts.<name>.fallback`) to put
the accounts in a group as the first entry, as in the before/after above.

The follow-up adds two before/afters:

```yaml
# opencode, before: every new session bills the built-in Go workspace
engines:
  opencode:
    model: opencode-go/glm-5
    accounts:
      go-b: { provider: opencode-go-b, base: opencode-go, keyEnv: OPENCODE_GO_B_API_KEY }
    fallback:
      - { engine: opencode, model: opencode-go-b/glm-5 }

# after: new sessions are spread across both workspaces by headroom
engines:
  opencode:
    model: opencode-go/glm-5
    accounts:
      go-a: { provider: opencode-go }
      go-b: { provider: opencode-go-b, base: opencode-go, keyEnv: OPENCODE_GO_B_API_KEY }
    fallback:
      - group:
          - { engine: opencode, profile: go-a }
          - { engine: opencode, profile: go-b }
```

```yaml
# remote employee, before: the group only ranks fallback links; every session starts on the host's login
fallback:
  - group:
      - { engine: claude }                       # the employee's own login on its host
      - { engine: claude, profile: host-spare }  # declared with remoteHost: the same user@host
# after: the same chain; new sessions are now spread across both logins by headroom
```

Account groups have not been released yet (they sit under Unreleased in the
changelog), so no released config holds a remote employee's group that was
fallback-only: this is opt-in like the rest of the feature. The changelog's
existing group entry is updated in place (its "Not covered" line goes, the two
examples are added); it gets no second entry.

## Parts

| Part | Scope |
|---|---|
| A | Wire, config validation, loader, resolver expansion and ranking, balancer (pure), group-aware next-link, chains API (`startPick`), doctor, docs/fallback-chains.md |
| B | `pinAccountAtCreation` at every start path, pick record, switch path, own-account on the return path, board walk preview, guard test, stickiness tests |
| C | Web: chain editor group link, flow diagram, session chip with the pick and why, new-chat picker |
| D | Fake-provider harness scenarios: pick by headroom, group hop then rest, stickiness over turns and a resume, every start path |
