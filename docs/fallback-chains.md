# Fallback chains

A fallback chain is an ordered list of **targets** a session moves through when
its own target cannot serve a turn. A target is an engine, optionally a Claude
profile, and optionally a model:

```yaml
engines:
  claude:
    accounts:
      work: { configDir: /home/operator/.claude-work }
    fallback:                         # the default Claude profile's chain
      - { engine: claude, profile: work, model: sonnet }
      - { engine: opencode, model: opencode-go/glm-5 }
      - { engine: opencode, model: openrouter/z-ai/glm-5 }
```

The gateway owns all fallback. Engines run without fallback of their own; in
particular opencode no longer switches models internally (see
[opencode](#opencode-internal-fallback-is-removed)).

The wire shapes, normalisation and validation sentences live in
`packages/hundredfold/src/shared/fallback-chain-wire.ts`, shared by the config loader
and the Settings editor.

## Config

### Where a chain is written

| Subject | Key | Applies to |
|---|---|---|
| Engine default | `engines.<engine>.fallback` | sessions on that engine (for Claude: the default profile) |
| Claude account | `engines.claude.accounts.<name>.fallback` | sessions on that declared profile |
| Employee | `fallback` in the employee's YAML | that employee's sessions; overrides the two above |

A session's chain is chosen in this order, first match wins:

1. the session's own fallback target (chosen from the fallback chip): a
   one-link chain, as before;
2. the employee's `fallback` (`fallback: []` means no fallback);
3. the session's account chain (`engines.claude.accounts.<name>.fallback`);
4. the engine default (`engines.<engine>.fallback`), for the default Claude
   profile and every other engine.

A local named profile that is not declared under `engines.claude.accounts`, and
whose employee writes no `fallback`, has no chain: it waits for its own reset,
as before.

### Entries

An entry is a mapping `{engine, profile?, model?}`:

- `engine`: any known engine.
- `profile`: a declared account name under `engines.claude.accounts`. Only
  Claude links take one. Absent means the default Claude profile. A profile
  runs where its account is declared: a local account on the gateway, an
  account with `remoteHost` on that host (see Remote sessions below).
- `model`: a model id the engine serves (opencode's `provider/model`). Absent
  means: on the same engine as the session, the session's own model; on
  another engine, the `fallbackModelMap` translation of the session's model if
  there is one, otherwise that engine's default.

The same engine may appear several times with another profile or model, so
`claude/A/opus -> claude/B/sonnet` and `opencode-go/x -> openrouter/x` are both
chains. Only an exact duplicate (same engine, profile and model) is a problem,
as is a link equal to the target the chain falls back from.

A save (`PUT /api/config`, the employee `PATCH`) refuses a duplicate. A config
that already repeats a target still loads, so an upgrade never stops a gateway
starting: the repeat is warned about at startup (naming the config path and the
target), the chain lists the target once, the chain's `problems` in
`GET /api/fallback-chains` and `hundredfold doctor` report it, and an unrelated save
leaves it untouched until that chain is edited. A link equal to the target the
chain falls back from, an unknown engine, an undeclared profile and a bad model
are still load errors; in an employee's YAML they drop that employee's chain
(it inherits) and are reported as `problems`.

### Balanced groups

An entry may instead be a **group**: a set of Claude accounts the gateway
orders by remaining usage when the chain is resolved.

```yaml
engines:
  claude:
    accounts:
      work: { configDir: /home/operator/.claude-work }
      spare: { configDir: /home/operator/.claude-spare }
    fallback:
      - group:
          - { engine: claude }                 # the default login
          - { engine: claude, profile: work }
          - { engine: claude, profile: spare }
      - { engine: opencode, model: opencode-go/glm-5 }
```

A group is `{ group: [<link>, ...] }`, written wherever a chain is written: an
employee's `fallback`, `engines.claude.fallback` and
`engines.claude.accounts.<name>.fallback`. It is valid when:

- it lists at least two members;
- every member is a mapping with `engine: claude` and an optional `profile`
  (a member with no profile is the default login), or, for a group of opencode
  accounts, `engine: opencode` with `profile` (see [opencode account
  groups](#opencode-account-groups)). A group's members all run on one engine: a
  group that mixes Claude and opencode, or holds any other engine, is refused;
- no member names a `model`: a member is an account, and the model is the
  session's own, or the link rules above for a hop;
- members are distinct, and every `profile` is a declared account;
- no member is a string or another group, and the entry holds only `group`.

A member counts as a link for the duplicate rule: a standalone link that
repeats a member, or a member listed in two groups, is a duplicate (warned and
listed once at load, refused on a save). A group may list the chain's own
account, which the rule above forbids for a standalone link; that is how a
chain says "balance across these accounts, mine included". A chain with no
group parses, resolves and walks exactly as before.

In the web app, a group is one row in the chain editor (Settings > Engines, each
account card, and the employee editor): tick the accounts it holds from the default
login and the declared accounts, and reorder or remove it like any link. A group is
saved as `{ group: [...] }` from the members as written, never the models the gateway
resolved them to, and the gateway's validation sentences show under its row. The
diagram draws a group as one node listing its accounts in the order a limit walks
them, each with its headroom, and the start node says where a new session would start
and with what share. A balanced session's fallback chip shows which account
it was pinned to and why: each account's headroom and share (weighted by headroom, not
"most headroom"), when it was picked and on what trigger. A department-scoped viewer is
sent the pick without the numbers, and sees the accounts, their states and the reason.
In the new-chat picker the default option reads "Balanced (by headroom)" when the chosen
employee's chain opens with a group holding its own account, and sends no profile;
choosing a profile still sends `claude:<name>`.

#### opencode account groups

A group may instead hold opencode accounts: the accounts declared under
`engines.opencode.accounts` (see [opencode accounts](design/opencode-accounts.md)),
each a provider id. A member names its account with `profile`:

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

- Every member is `engine: opencode` with a `profile` that is a declared opencode
  account; no member names a `model`; at least two members, distinct; no nesting,
  no strings. A `profile` on a standalone opencode link is still refused: outside
  a group an opencode account is named by its provider in the model
  (`opencode-go-b/glm-5`).
- Valid only where the chain's own target runs on opencode: an opencode employee's
  `fallback` and `engines.opencode.fallback`. Anywhere else (a Claude employee, an
  engine or account chain of another engine) a member has no model of its own to
  run, so it is a load error.
- Three refusals have fixed sentences, shared with the Settings editor:
  `a group's members all run on one engine`; `an opencode group member names its
  account with profile`; and `an opencode group balances an opencode session's own
  model; put it in an opencode employee's chain or engines.opencode.fallback`.
  `hundredfold doctor` prints them, with the rest of a group's problems.
- A group's **own account** is the declared account whose `provider` is the
  provider of the subject's own model (the employee's `model`, else
  `engines.opencode.model`). A subject whose model's provider is no declared
  account has none and is never balanced: declare the built-in provider as an
  account (`go-a` above) to include it. The **model key** is the model without its
  provider: `opencode-go/glm-5` gives `glm-5`.
- **Expansion.** A member resolves to `{ engine: opencode, model: <member
  provider>/<model key> }`: with the own model `opencode-go/glm-5`, `go-b` is
  `opencode-go-b/glm-5`. A member whose account does not serve that key (it is not
  in the model registry as available) is passed over as `model-not-served`, so it
  is no candidate and no fallback link for that session. The member that is the
  session's own account is the own target and is not listed again. The link's
  `account` stays `opencode`; the group ranks its members by health key,
  `opencode/<provider>`.
- **Headroom** comes from a usage history per declared account, keyed
  `opencode/<provider>` and kept beside the Claude ones (same collapse, retention
  and cap): the engine-health refresh, every fifteen minutes, appends one sample
  per account from what it already computes for the provider, the provider's own
  meter where it answered, else the usage ledger's buckets for accounts with
  `usageLimits`. Windows are `5h`, `7d` and `30d`. The provider's meter and a ledger
  bucket for the provider's `*` apply to every model; a ledger bucket for one model
  is a window named `<window> <model key>` that applies only to a session on exactly
  that model key (an exact match, not Claude's family match). An account with no
  reading has no sample: it is unknown, weight 0 while another member has a reading,
  an even split when none has. The provider meter is the reading to rely on: on
  OpenCode 2.x `run` mode records turns at $0 in the ledger, so a ledger-only
  account reads as full headroom.
- **Exhausted** means health holds `opencode/<provider>` (the meter, or the
  provider's own quota, auth or expired-key refusal) or `opencode/<provider>/<model>`
  for the session's model.
- The weights, shares, smooth round-robin, freshness and the all-exhausted rule are
  those of [balanced groups at runtime](#balanced-groups-at-runtime); the credit
  table is shared and its keys never collide with Claude's. A config reload that
  changes a group in any chain (`engines.opencode.fallback` included) forgets the
  credits. `GET /api/fallback-chains` shows `startPick` for an opencode employee or
  the opencode engine subject whose chain opens with a home group.

Pinning a session to its pick (a model `<picked provider>/<model key>`) is separate,
later work: today the pick is previewed, not applied to new sessions.

### Legacy forms

The string forms keep working and keep their meaning:

- `codex` is that engine, followed by codex's own chain;
- `claude:<name>` is that declared account, followed by its own chain.

A chain is resolved to its **effective** chain by expanding each string entry
in place into the order the old walker visited it, skipping targets already in
the list. A chain written only in strings therefore runs exactly as before.
`fallbackModelMap` keeps working as the model rule for links without a model.
The Settings editor shows the effective chain; saving an edited legacy chain
writes it as explicit links.

## Runtime

### What moves a session along its chain

| Failure | Moves on from | Recorded in engine health |
|---|---|---|
| rate limit, quota, usage limit | any target | yes, on the failing target |
| opencode provider refuses: spent allowance (402), dead key (401), model not enabled (403), model unroutable (`provider.no-route`) | any target | yes: the provider, or for a 403 or a no-route the model alone (see [opencode failure classes](engines-opencode.md#failure-classes)) |
| engine gave up its own provider retries | any target | yes |
| model not served | a fallback link only | no |
| profile signed out | a fallback link only | the auth outage record, as today |

Other failures (network, terminal errors) end the turn as before. A turn on
the session's own target that hits a limit with no usable link waits for its
reset, as before.

### Walking

- A **run** starts at the session's first hop and ends when the session goes
  back to its own target. Within a run every target is tried at most once: the
  session's own target and every tried link are in the run's tried set, which
  is the loop guard. A chain can hop several times within one turn, up to its
  length: the turn runs on a link, and when that link fails in a way that moves
  on, the next link takes the same turn.
- The next link is the first one after the target the session stands on that
  has not been tried and is not ruled out. A chain is always the chain of the
  session's **own** target, whichever target is running now, so a limit on a
  stand-in continues along it and never goes back to the target the session left.
- A link is passed over, and named in the hop record with why (the skip
  reasons below). A link whose health says it is at its limit is passed over
  first, and tried only when nothing healthier is left. A link on an opencode
  provider whose key was rejected is never tried in that run (`signed-out`), and
  neither is a session's own fallback target on that provider.
- When the chain runs out, the session waits for its own target's reset and
  resumes there. It reads `waiting` (its `lastError` names the own target and
  when it reopens, e.g. "claude · work · opus usage limit, resumes …"), its last
  hop has no target, and the notice says plainly that no hop is left and what
  was tried. A fallback link that is signed out (its key or login refused,
  in this turn or an earlier one that left its provider held as signed out)
  is named in the `lastError`, the notice and the operator alert, since no
  reset renews it: "…; fallback opencode · go-b/mimo is signed out: its key or
  login needs replacing". It stays named in `lastError` while the session waits on the limit. A
  turn whose own target was refused (a dead key, a spent balance, a model it
  cannot use) fails instead of waiting, and its error, reply and alert name a
  signed-out link the same way, after the provider's own words. A remote
  profile that is only not ready on its host is not called signed out.
  If a stand-in held the session when it ran out, the wait ends
  where the stand-in's window does (the own target's reset), and the turn runs
  again on the own target. See [session statuses](session-statuses.md) for what
  `waiting` means and how to read it.
- At its own target's reset the session goes back to it and the run ends, as
  substitution reverts today (see [returning to the own target](#returning-to-the-own-target)).
  So does a manual engine switch, an API reset and a conversation the engine lost:
  the run ends, the hops stay.
- A **new** session whose own target is out of allowance starts on the first
  healthy link instead, with a run that starts there.


### Balanced groups at runtime

When a chain is resolved, a group is expanded in place into its members as
ordinary links, so the walk, health, hop records and the session view keep
working on exact single targets. Each member link carries `group`: the group's
entry index in the chain as written, the group as written (`written`, what an
editor writes back) and the ranking input it was ordered by (`headroom`). The
subject's own account, when it is a member, stays the own target at index 0 and
is not listed again.

Members are ordered best first by their **headroom**: 100 minus the highest
`usedPercent` across the windows that apply, in whole percent (rounded down),
taken from the newest usage sample recorded for the account. A window that has
already reset counts as unused. A window named `7d <model>` applies only when
the session's model is of that family (`7d Opus` for `opus` or `claude-opus-*`);
`5h`, `7d` and any other window always apply, and every window applies when the
session's model is unknown. Accounts fall into tiers, best first:

1. fresh readings (at most thirty minutes old, twice the health refresh interval) of healthy accounts;
2. stale readings of healthy accounts;
3. accounts with no reading;
4. exhausted accounts (health says the account is at its limit).

An account that cannot be read is never preferred over one that can. Within a
tier the order is headroom, highest first, then the order written; among
exhausted accounts the one that reopens first comes first. This is the order a
limit tries a group's other members in. Members a session cannot use (an
undeclared profile, or an account on another host) keep their written order
after the usable ones and are passed over with their reason. Ordering reads only
what is on disk and in engine health; nothing calls a provider.

New sessions are not all sent to the best account: they are **spread in
proportion to headroom**, because usage readings lag and sessions start in
bursts. Each account has a weight: its headroom for a fresh reading, half its
headroom for a stale one, 0 with no reading while another account has one (1
each when none has), and 0 at its limit or with no headroom. Its share of new
sessions is its weight over the sum, so headroom 60 against 40 splits 60/40, 90
against 10 splits 90/10, and an exhausted account gets none. A smooth weighted
round-robin makes this deterministic: each candidate set keeps an in-memory credit
per account; at each start every credit grows by the account's weight, the
highest credit wins (ties: the order written) and the winner's credit drops by
the sum of the weights. A burst therefore splits even inside one reading
interval. The pick itself is pure; the credit is charged only when a session
really starts, never by a preview. When every weight is 0 the account that
reopens first is picked and creation moves the session on to the first healthy
link after the group.

A group walks as a **set**. When a limit moves a session on and the cursor is on
a member, or the next untried link is a member, every untried member of that
block is considered, in the resolved order, before the walk moves past the
block, wherever a member sits relative to the cursor. The run's tried set is the
loop guard, so a different ordering between two resolutions can neither skip a
member nor revisit one.

A group at the head of a chain that holds the subject's own account is that
subject's **home group**. For an employee or engine subject with one,
`GET /api/fallback-chains` reports `startPick`: the member a new session would
be balanced onto now, why (`weighted`, `only-candidate`, `no-readings`,
`all-exhausted`) and the candidates by headroom with their `weight` and
`sharePercent`. A group holds a subject's own login only when it names it: the
default login is `{ engine: claude }`, a profile is `{ engine: claude, profile }`.
The default login is not a candidate for an employee whose own login is a named
profile. A session
the balancer has pinned records its choice in `transportMeta.accountPick` and
resolves against the chain the group came from (`source`), ahead of the pinned
account's own chain, so its chain is the pinned account, the group's other
members by headroom, then the rest of the chain.

#### Pinning at every start

Every way a session starts on Claude goes through the same pick
(`pinAccountAtCreation`): a new chat, a spawn, a delegation, a Todo wake or
dispatch, a Todo capture, a connector-routed session. The session starts on the member it picks, stored where a chosen
profile already lives (`claudeConfigDir`; a pick equal to the employee's own login
stores nothing, so that row is as it was before groups), and records the pick in
`transportMeta.accountPick`. A caller that names a profile (`engine:
claude:<name>`) is pinned there and not balanced; naming `engine: claude` or a
model is still balanced. Nothing starts a new pick afterwards: not a turn, a
resume, a restart, a session reset or a revert. A limit walks the chain and the
return at the reset goes back to the pinned account, not to the employee's login
and not to the group's first member.

Members are chosen by a smooth weighted round-robin over their headroom. The
credit that makes it round-robin is charged only when a session really starts: a
refused start, a stored Todo override that is only validated, a preview and the
board walk's view never move it, and neither does a pick that finds every member
at its limit (that session pins the member that reopens first and is then
rerouted at creation like any other session whose own account is out). The
credits live in memory and start at zero after a restart; a config reload that
changes a group forgets them.

A deliberate switch onto Claude that names no profile (the operator's
engine-only switch, or a session's own `compact_session` switch) runs the same
pick with trigger `switch`, and a session's own switch picks again when it is
applied. A switch that names a profile pins that profile and clears the pick. The
board walk judges a Todo whose assignee has a home group on the member the
balancer would pick for it now.

### Returning to the own target

A hop is temporary. Every swap onto a link records the own target it left (engine,
Claude account, model, thread) and the moment that target reopens, taken from the
limit that moved the session: its stated reset, else six hours. The record is
`transportMeta.engineOverride`, and a nested hop (a link limited in turn) keeps the
first swap's record, so the session still goes back to where it started, not to the
link before.

- **Automatic, not an action.** Nothing in a session prefers a stand-in, so there
  is no "switch back" button to forget. The return is checked when a turn is
  admitted: the web dispatch when the queue releases the turn, and a connector
  message, the `/message` route and a callback when the message arrives (so a
  message queued behind a running turn is judged at arrival, before a reset that
  falls while it waits). It is never made mid-turn: a turn that began on a link
  finishes there, and the session returns on a later one. A manual engine switch,
  an API reset or a conversation the engine lost ends the run the same way.
- **Same for every kind of link.** An engine, another Claude account, another model
  of the same account, an opencode model on another provider and a chain of several
  links all return the same way, to the own target and not to a link on the way.
- **One source for the reopening.** The window is the limit's reset as recorded in
  engine health, the store the chain walk reads and the limits readout writes. When
  the window has passed, health is asked once more, under the own target's key
  (its account for Claude; its provider for an opencode model, from the model the
  session pins, else its employee's or the engine's default; the engine for the
  rest). If the target is recorded as spent, typically because another session's
  probe or the limits readout found it limited again, the window moves out to that
  return and the session stays where it is, with no turn spent probing. The first
  session to meet a limit still finds it out with a turn.
- **A turn that outlives its window.** A turn on a stand-in that hits the stand-in's
  own limit after the window has passed, with the own target recorded as still
  spent, runs once more on the stand-in and then waits for the new window. It says
  it is back on its own target only when it is.
- **Loop guard.** A session goes back at most once per window. If the own target
  is limited when it is tried, the turn falls back as before with the new reset,
  a new run starts at the first link, and the next return is at that reset. Within
  one turn the run's tried set still stops any target being visited twice.
- **Context.** The own target's thread resumes with everything exchanged elsewhere
  prepended. A target that never had a thread of its own (the session was born on
  the stand-in, or the first turn there was the one that hit the limit) starts a
  fresh run that carries the conversation; it is never handed the stand-in
  account's thread.
- **Waiting.** A session whose chain ran out waits for the own target's reset and
  runs there, as described above.

### Why a link is passed over

| Skip | When |
|---|---|
| `tried` | already tried in this run (the loop guard) |
| `not-installed` | its engine is not installed where the session runs: on the gateway, or for a session on a remote host, on that host. For an engine that runs remotely the link also carries `skipDetail` naming the host, e.g. "build-box has no \`muse\` on its non-interactive PATH", and the hop record carries it as `detail` |
| `remote` | the link cannot run where the session does: for a remote session, an engine other than `claude`, `pi`, `opencode` and `musecode`, a local Claude profile, or a remote account on another `user@host`; for a local session, a remote account. A profile link carries `skipDetail` saying which, e.g. `profile "spare" is on me@build-host, not this session's host other-host`, `profile "x" is a profile on the gateway, not on build-host`, `profile "spare" is on remote host build-host` |
| `scoped` | the session is department-scoped and the link is not a Claude account |
| `exhausted` | its health says it is at its limit; tried only when nothing else is left |
| `signed-out` | an opencode link whose provider is held as signed out (its key was rejected, `failureClass: auth`): never tried, even when nothing else is left, since every model on that provider would be refused with the same key. The hold lifts when the credential changes. A model held alone (`model-access`) or a spent allowance (`quota`) stays `exhausted` |
| `model-not-served` | the engine's catalog does not list the link's model |
| `profile-unknown` | the link names a profile that is not a declared account |

Whether a remote host has an engine's CLI comes from the facts the gateway
learned when it last spawned a session there (`command -v` over a
non-interactive ssh). A host this gateway has not probed since it started counts
as having it, and the spawn then says if it does not. `GET /api/fallback-chains`
judges an employee on a remote host the same way, so its chain shows what its
turns would do.
### Remote sessions and remote accounts

A session on a remote host follows its chain on that host: engines that run
there, and Claude **accounts declared on its own `user@host`** (an entry under
`engines.claude.accounts` with `remoteHost`, and `remoteUser` when the employee
has one; `configDir` is the profile directory on the host). A link naming such
an account runs the session on that directory, with the recent history in the
prompt, under the account's key (`claude@<user>@<host>:<key>`), the key a remote
employee on that directory has. A remote account has no chain of its own: its
employees write theirs. When the employee's own login is a declared account,
its own link carries that profile, so a chain naming it is the employee's own
target and is refused. A local profile is refused on a remote session, a remote
account on a local one, and a remote account on another `user@host` is refused
on both. `employeeFallbackProblems` reports each at load, and a chain that
still names one passes it over as `remote`.

**A remote employee's home group balances its new sessions.** When the group at
the head of a remote employee's chain (its own `fallback`, else
`engines.claude.fallback`) holds its own login (the member naming no profile, or
the declared account of its own directory), each new session is pinned to a
member by headroom, as a gateway session is, and the other members stay its
fallback links. Headroom comes from the usage readings the gateway already
takes over SSH for each login. A member on another `user@host` is no candidate.
The pin is kept in the session's `transportMeta.remoteAccountPin`
(`{ account, configDir }`), never in its profile column, which is a directory on
the gateway, and every launch, wake and return of the session runs on that
directory. It is honoured only while the employee still runs on the same
`user@host`: move the employee and its sessions run on its own login again.
`GET /api/fallback-chains?employee=<name>` reports the next pick as `startPick`.

### Health keys

A Claude target's health is its account's. An opencode target's health is kept
per provider (`opencode/<provider>`), so a provider's usage limit does not mark
other providers' links as spent, and a link is also read under its own model
(`opencode/<provider>/<model>`), where a model the account is not enabled for is
held without marking the provider's other models. A record carries the kind of
failure it holds (`failureClass`: `quota`, `auth` or `model-access`). Every other
engine keeps one key.

An opencode link is read under its provider's key and the engine-wide
`opencode` key (`[opencode/<provider>, opencode]`): the provider's own limit, or
the engine as a whole being out. An opencode target that names no model (an
employee who pins none) is read under the provider of `engines.opencode.model`,
the model its session runs on, without pinning the session's model; it is
resolved on the own link only, and shows as `healthProvider` in
`GET /api/fallback-chains`.

### opencode accounts in chains

A declared opencode account (`engines.opencode.accounts`, see
[opencode accounts](design/opencode-accounts.md)) is a provider of its own, so a
chain names its models as it names any provider's: `opencode-go-b/<model>`.

- **Links.** `{ engine: opencode, model: opencode-go-b/deepseek-v4.1-flash }` is
  the second account's copy of a Go model, and `{ engine: opencode, model:
  opencode-go/deepseek-v4.1-flash }` is the stock provider's. They are different
  targets, so a chain can list both, and neither dedupes the other.
- **Health keys.** Each account is its own key, `opencode/<account's provider>`.
  The usage meter writes it when one of that account's windows is spent
  (metered by the account's `usageLimits`, or inherited from its base), and a
  provider's own refusal recorded under the same key outranks the meter. One
  account being out leaves the stock provider and every other account usable,
  and none of them writes the engine-wide `opencode` key.
- **New sessions.** A session whose own provider is an exhausted account starts
  on the first healthy link of its chain, as for Claude accounts, and goes back
  when the account's window reopens.
- **A hop between accounts keeps the thread.** Accounts share opencode's one
  data directory and one session store; only the provider id and its key differ.
  `opencode-go/x -> opencode-go-b/x` is "same thread, other model", so the
  conversation resumes as it does for `opencode-go/x -> openrouter/x`, with no
  messages replayed.

### Context across a hop

Each account (and each non-Claude engine) keeps its own conversation thread.

- **Same thread, other model** (`claude/A/opus -> claude/A/sonnet`,
  `opencode-go/x -> openrouter/x`): the thread resumes with the new model.
- **Another account or engine with a thread of its own**: that thread resumes,
  with the messages it has not seen prepended (everything since the thread was
  last brought up to date: its slot's `lastSyncedAt`).
- **Another account or engine with no thread**: a fresh run whose prompt
  carries the recent conversation, then the message being answered, stated
  as the current message. A Claude session id from one profile is never
  resumed under another.
- **Back on the session's own target**: its thread resumes with the messages
  exchanged elsewhere prepended, as today.

A message from another session (a brief, a follow-up, a child's reply) is
logged as a notification and travels in these transcripts as `MESSAGE FROM
ANOTHER SESSION`; gateway notices are left out. If the session's parent has
already been sent this exact reply by the session, a turn answered after a
limit that comes back with the same text is not relayed again: the parent is
sent a one-line note that nothing is new.

### Background tasks across a hop

A background Bash task, Monitor or background sub-agent lives inside one Claude Code
process, which a hop releases (and so does the return to the own target, for the
stand-in's process). They are not carried: re-running a background command would run
it twice. The gateway records what the released process held, and the next prompt
the session reads, on whichever target serves the turn, leads with a note naming each
task by id, kind and command, saying the session moved after a usage limit and its
process was replaced, and asking it to check the outcome and re-arm any Monitor it
still needs. A link that fails before it reads the prompt leaves the tasks owed to
the next link, and to the wait that follows a chain that ran out. No separate nudge
turn is started for a move. A release that is not a move (an idle eviction, a
respawn after a crash) still starts one.

### What is recorded

Each hop is recorded on the session (most recent 20) with its time, from and
to targets, reason, the failing target's reset and any links passed over, and
announced in the transcript as a notice: a `notification` message whose
`meta.fallbackHop` is the hop (`FallbackHopNoticeMeta`), which the dashboard
shows as a card with the links passed over. A chain that runs out records a
last hop with no target. The target that served the latest turn is recorded
too, for a session that has walked a chain. In `transportMeta`: `fallbackRun`
(`source`, `position`, `tried`, `startedAt`, present only while the session is
off its own target), `fallbackHops` and `fallbackServedBy`; the override record
names the stand-in as `substituteTarget {engine, profile?, model?}`. The
session API reports the chain, its position, the next hop and the hops under
`fallback.chain`.

## A session started on a chosen profile

A session's own target is normally its employee's Claude login. A session created with `engine: "claude:<name>"` (see [Starting on a chosen profile](session-fallback-mode.md#starting-on-a-chosen-profile)) has that declared account as its own target instead: its chain starts there, an employee-less session inherits the account's chain from `engines.claude.accounts.<name>.fallback`, and an entry that names the chosen account is the own target, so it is not listed a second time. An account swap made at a usage limit still returns to the chosen account, not to the employee's.

## API

- `GET /api/fallback-chains`: declared profiles, plus every engine and account
  chain as written and as effective. Each link carries its limit state, its
  `written` form (what an editor writes back) and why it would be skipped.
  `?employee=<name>` adds that employee's chain, with the `source` it comes from.
  The route is the operator's: a department-scoped caller is refused.
  A group entry appears whole in `configured`; its members appear in `effective`
  with `group`; an employee or engine subject with a home group also carries
  `startPick` (`AccountPick`).
- Engine and account chains are written through `PUT /api/config`; an
  employee's through `PATCH /api/org/employees/<name>` with `fallback` (a list,
  or `null` to inherit).
- `GET /api/fallback-preview?engine=claude:<name>` previews the chain a session started on that account would get.
- `GET /api/sessions/<id>`: `fallback.chain` (`SessionFallbackChainView`): the
  links, the position, the next hop, the hops and `servedBy`. A
  department-scoped session reading its own session gets each link's `state`
  and `until`, but not `usedPercent` or `window`, and a balanced session's
  `pick` (its recorded `AccountPick`) and each member's `group.headroom` without
  `headroomPercent`, `tightest`, `readingAt`, `weight` or `sharePercent`.
- `hundredfold doctor` reports a malformed group in `config.yaml` (it does not load).

## opencode internal fallback is removed

opencode used to switch models on a usage limit by itself, through the
`opencode-rate-limit` plugin (1.x) or the example `model-fallback.js` plugin
(2.x), configured per host in `rate-limit-fallback.json`. That fallback was
invisible to the gateway, could not move a session to another engine or
profile, and could not be seen or edited in the dashboard. It is removed:

- opencode turns run with no internal fallback, and the adapter code that
  adopted a plugin's re-sent prompt is gone;
- opencode model and provider hops are chain links:
  `{engine: opencode, model: openrouter/x}`;
- a host still running a fallback plugin is reported by `hundredfold doctor`, at
  gateway start, and in Settings, so a double fallback is never silent.

### A configured plugin is reported, not neutralised

The gateway cannot switch an operator's fallback plugin off for its own
sessions alone, so it detects and reports one. Checked on the real binaries
(opencode 1.19.0 with `opencode-rate-limit@1.4.0`, and 2.0.29 with the example
`model-fallback.js`, against a provider answering 429):

| Lever | 1.19.0 | 2.0.29 |
|---|---|---|
| a staged `OPENCODE_CONFIG` with an empty plugin list | the plugin still switches models: plugin lists are concatenated, not replaced | the same |
| a staged plugin with the same name as the operator's | the plugin still switches models | not applicable: 2.x reads no local module path from config |
| `OPENCODE_DISABLE_DEFAULT_PLUGINS`, `OPENCODE_DISABLE_PROJECT_CONFIG` | the plugin still switches models | no such variable |
| `OPENCODE_PURE=1` | stops the plugin, and every other external plugin with it: the operator's provider-auth plugins and the gateway's own staged plugin (the command-timeout cap) | no such variable |
| `OPENCODE_CONFIG_DIR` pointing elsewhere | not tried | replaces the operator's config directory, so the provider config goes too (`provider.no-route`) |
| the plugin's own `"enabled": false` | the plugin reads the first existing file of the project, `~` and the config directory (each under `.opencode/`, `opencode/`, then bare): the gateway would have to write into the operator's project or home | the same |

What a gateway turn does on a host that still has the plugin (real binaries, the
same 429 upstream, through the gateway's opencode engine; the default model's
provider answers 429 and the plugin's fallback provider answers normally):

| opencode | Mode | What happens |
|---|---|---|
| 1.19.0 + `opencode-rate-limit@1.4.0` | server | The plugin aborts the turn and re-sends the prompt as a new message, which the gateway no longer adopts. The turn ends in about 5 s as a usage limit (`rateLimit: rejected`) whose error names the plugin, so the chain takes over. The re-sent copy has usually reached the fallback model by then (one request); the gateway aborts it, and its answer is never delivered. |
| 1.19.0 + `opencode-rate-limit@1.4.0` | run | The plugin's abort ends the process with exit 0, no answer and no error of its own, before any re-send, so no request reaches the fallback model. The turn ends as a usage limit whose error names the plugin. |
| 2.0.29 + `model-fallback.js` | server | The plugin switches the session's model inside the turn. The fallback model answers it in about 3 s. No hop is recorded and the chain is not walked, but the turn says so: a warning in the gateway log and one session notice, "Answered by <provider/model> through the host's opencode fallback plugin, not the gateway's chain. Run `hundredfold doctor` to remove it." |
| 2.0.29 + `model-fallback.js` | run | The same answer from the fallback model, invisibly to the chain; the notice is posted only for a server turn, which sees which model each step ran on. |

**How a 1.x turn's outcome is decided on a plugin host.** The plugin's abort
carries no error, so the gateway reads it from evidence. Every condition below must
hold before a turn becomes the plugin's usage limit:

- the host has the plugin and the binary is 1.x. 2.x turns are never read this
  way, because the 2.x plugin switches models instead of aborting;
- the process exited 0, the transport did not fail, and the gateway did not stop
  the turn itself (an interrupt or a timeout keeps its own error);
- no error other than a usage limit was reported;
- the turn stopped while a model step was still due: no step finished, or the
  last one finished on a tool call. opencode only stops there when something
  aborts it. A turn the model ended itself closes on a `stop` step.

When all hold, any text the turn wrote came from a step that ended on a tool call.
That text is narration ("Let me read the file") and is not taken for the answer.
The turn ends as a usage limit, and its error names the plugin.

When any condition fails, the turn is read exactly as on a host without the plugin:
- a blank last step is a plain error, so it cannot mark the whole opencode
  engine as exhausted;
- a final step's text is the answer;
- a crash, transport failure or interrupt is never read as a usage limit.

The tests in `opencode-fallback-plugin-turn.test.ts` and
`opencode-server-provider.test.ts` pin each side of every condition. A change
here must keep both sides covered.
The 2.x notice is posted wherever the turn takes the engine's result: the first
attempt, a chain hop's substitute and a parked retry.

Before this was handled, a 1.x server turn also ended as a usage limit but left the copy running, and a 1.x run turn
ended with `opencode exited successfully without a final assistant response` and no rate limit, so the chain
never took over.

What is checked, and where:

- the plugin in a `plugin` or `plugins` list of the operator's opencode config
  (`opencode.json`, `opencode.jsonc` or `config.json` in the config directory
  and `~/.opencode/`, `OPENCODE_CONFIG`, and `opencode.json` and `.opencode/`
  in the directory the gateway (or `hundredfold doctor`) runs in, which stands for the
  project: a session's own working directory is not read);
- a `model-fallback` or `opencode-rate-limit` file or directory in a `plugin`
  or `plugins` directory of those;
- a `rate-limit-fallback.json` without `"enabled": false` in `.opencode/`,
  `opencode/` or the directory itself, under the project, `~` and
  `$XDG_CONFIG_HOME`: the places the plugin reads.

`GET /api/engines` carries the reading on the opencode entry:

```json
"internalFallback": { "detected": true, "neutralised": false, "sources": ["…/rate-limit-fallback.json"] }
```

`sources` are the operator's own paths: they are in `hundredfold doctor`'s output and
at debug level in the log, never in an info-level line. Nothing is ever
written to the operator's files.

A remote host is read best effort, through the facts the gateway already
collects when it first reaches the host: a shell probe for the same markers
(a `grep` for the plugin's name as a whole package or file name in the opencode
config files, so a comment that merely mentions it counts; the plugin files; a
settings file whose top-level `enabled` is not false, read as plain JSON, so a
file with comments, which the plugin itself cannot read either, is skipped).
Its findings are added to `sources` as `host: path`, and the first
one for a host logs the same warning. A project directory is not read on a
remote host, since the host does not know which project a session will run in.

### Migrating a host

1. Run `hundredfold fallback migrate-opencode` to print the chain equivalent of the
   host's `rate-limit-fallback.json` (`--write` adds it to the config).
   `fallbackModels: [a, b]` becomes
   `engines.opencode.fallback: [{engine: opencode, model: a}, {engine: opencode, model: b}]`;
   per-model lists become employee chains for the employees pinned to that
   model, and `"*"` the engine default.
2. Remove the plugin from the host's opencode config (`plugin` in
   `opencode.json`, or `model-fallback.js` from the plugin directory) and delete
   `rate-limit-fallback.json`.
3. `hundredfold doctor` confirms no internal fallback is left.

The plugin's `cooldownMs`, `circuitBreaker`, `fallbackMode`, `restoreModel`
and `retryPolicy` have no setting of their own: engine health, the
once-per-run rule (a chain's length bounds the hops) and the return to the
session's own target at its reset cover them. `hundredfold fallback migrate-opencode`
lists each such key it finds, with this reason. `--write` merges only the
engine default, and refuses when `engines.opencode.fallback` is already set. It goes through the atomic config save, so YAML comments in `config.yaml` are not kept, and an `engines.opencode` block is created when there is none.

## Testing without real providers

`scripts/verify-fallback-chains.sh` starts a throwaway gateway on its own port
with a temporary home, fake Claude profiles and stub `claude` and `opencode`
binaries that succeed, report a usage limit, stall or fail on command, per
profile and model, in the formats the gateway classifies. Its scenarios walk a
four-link chain hop by hop, run a chain out, and check the loop guard. No
provider is contacted. `scripts/verify-fallback-chains/README.md` says how to run it, keep the
instance up for screenshots, and add a scenario.
