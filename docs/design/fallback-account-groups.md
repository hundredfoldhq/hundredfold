# Fallback chains: usage-balanced account groups

Status: design, settled. Builds on [fallback chains](../fallback-chains.md).

## Problem

A chain is a fixed order, so the first link always serves new sessions,
whatever its remaining allowance, and a sibling account is used only after a
limit hit. Giving each role its own first account (builders on account A,
reviewers on account B) drifts: one account runs out early in the week while
another ends it with allowance unused.

## What this adds

A chain entry may be a **group**: a set of Claude accounts. When a new
session starts and its own account is in the group at the head of its chain,
the gateway picks the member with the most usage headroom, pins the session
there, and makes the group's other members its next fallback links, ahead of
the rest of the chain.

```yaml
# before: fixed order, account "work" always serves new sessions
fallback:
  - { engine: claude, profile: spare }
  - { engine: opencode, model: opencode-go/glm-5 }

# after: a new session starts on whichever of the default login, "spare" and
# "work" has the most headroom; the other two are its next links
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
  `engines.claude.accounts.<name>.fallback`. Any engine other than Claude in a
  group is a load error in this release ("a group holds Claude accounts only").
  opencode account groups are a follow-up.
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
- the session runs on the gateway (not a remote employee: a remote employee's
  group is fallback-only in this release, see 9).

Anywhere else a group is a block of fallback links, ordered by headroom when
the chain is resolved.

A member that cannot serve the session (the existing skip reasons: `remote`,
`scoped`, `profile-unknown`, `not-installed`) is not a candidate. The default
login member is not a candidate for an employee whose own login is a named
profile (the session row has no way to say "default login" over an employee's
profile); it stays a fallback member.

### 4. The pick

Input per candidate: the newest usage sample of its account
(`latestAccountReading`, the per-account history the 15-minute engine-health
refresh writes), its engine-health record, and how many sessions are active on
it now.

- **Headroom** = 100 − the highest `usedPercent` across the windows that apply
  (the tightest window wins). A window whose `resetsAt` has passed counts as 0
  used. A window scoped to a model (a sample window named `7d <model name>`)
  applies only when the session's model is of that family (case-insensitive
  match of the family word, e.g. `7d Opus` for an `opus` or `claude-opus-*`
  model); `5h`, `7d` and a scoped window naming no model always apply, and so
  does every window when the session's model is unknown. Headroom is compared in whole percent (floor).
- **Freshness**: a sample is fresh when it is at most
  `2 × ENGINE_HEALTH_REFRESH_INTERVAL_MS` (30 minutes) old, stale when older,
  unknown when there is none.
- **Tiers**, best first: fresh and healthy; stale and healthy; unknown and
  healthy; exhausted (its health record says it is at its limit, or its login
  is recorded as signed out). An account that cannot be read is never
  preferred over one that can.
- **Order within a tier**: headroom, highest first (stale and fresh compare
  on their recorded headroom; unknown has none); then fewest active sessions
  (sessions with status `running` or `waiting` whose current account is that
  account); then the group's written order. Deterministic for a given state.
- **All exhausted**: pin the member whose health record reopens first, then let
  the existing creation reroute (`rerouteAtCreation`) move the session to the
  first healthy link after the group, with the pinned account as the own target
  it returns to.
- The pick never calls a provider: it reads only what is on disk and in health,
  so creation stays synchronous and cheap.

Accepted limitation: readings refresh every 15 minutes, so a burst of new
sessions inside one refresh goes to the same account unless headroom ties. The
active-session tie-break spreads a burst across accounts at equal headroom.

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
  activeSessions: number;
}

interface AccountPick {
  at: string;                    // ISO
  trigger: "start" | "switch";
  source: FallbackChainSource;   // the subject whose chain holds the group
  groupIndex: number;            // its entry index in that chain
  picked: string;                // account key
  reason: "most-headroom" | "tie" | "only-candidate" | "no-readings" | "all-exhausted";
  candidates: AccountHeadroom[]; // ranked, best first
}
```

- `SessionFallbackChainView.pick?: AccountPick`, from `transportMeta.accountPick`.
- `FallbackChainSubject.startPick?: AccountPick`: for an employee or engine
  subject whose chain has a home group, what a new session would pick now.
- A department-scoped caller reading its own session gets `pick` without
  `headroomPercent`, `tightest` and `readingAt`, matching the existing rule that
  strips `usedPercent`/`window`.

### 9. Out of scope in this release

- opencode account groups (refused at load with a clear message).
- Balancing a remote employee's sessions (its group is fallback-only).
- Probing an account at pick time.

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

## Parts

| Part | Scope |
|---|---|
| A | Wire, config validation, loader, resolver expansion and ranking, balancer (pure), group-aware next-link, chains API (`startPick`), doctor, docs/fallback-chains.md |
| B | `pinAccountAtCreation` at every start path, pick record, switch path, own-account on the return path, board walk preview, guard test, stickiness tests |
| C | Web: chain editor group link, flow diagram, session chip with the pick and why, new-chat picker |
| D | Fake-provider harness scenarios: pick by headroom, group hop then rest, stickiness over turns and a resume, every start path |
