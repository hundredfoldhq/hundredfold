// The account group scenarios (docs/design/fallback-account-groups.md, docs/fallback-chains.md): a chain
// whose first entry is a group of Claude accounts spreads new sessions across them in proportion to each
// account's usage headroom, pins a session to its pick, and walks the group's other members before the
// rest of the chain. Each is `{ id, title, run(h) }`, like the scenarios in scenario-defs.mjs.
//
// Usage is seeded the way the gateway reads it: one sample in each account's own usage history file
// (`h.seedUsage`), so no provider is called and the network guard stays on. A scenario reads what the
// gateway says (`fallback.chain.pick` on the session, with each candidate's weight and `sharePercent`) and
// what the fakes ran (the ledger's profile per turn), and asserts the two agree.
//
// Ids p..v. Those that need the start paths to pin an account at creation (part B of the account group
// work) are in the script's default `--pending` until that is merged; the others run against what is merged.
import { expectEqual, expectTrue, sleep, walkOf } from "./lib.mjs";
import { chainHops, cliClear, healthOf, limitedFor, linkKey } from "./scenario-defs.mjs";

const PROFILE_OF = { A: "profile-a", B: "profile-b" };
const SPACING_MS = 400;

const pickOf = (session) => session.fallback?.chain?.pick;
const firstProfile = (rows) => rows.find((row) => row.outcome !== undefined)?.profile;

/** Tag, id and settled session of each started session, plus the pick it records and the profile that ran its first turn. */
async function describe(h, started) {
  const out = [];
  for (const { id, tag } of started) {
    const session = await h.settled(id);
    out.push({ id, tag, session, pick: pickOf(session), profile: firstProfile(h.rowsFor(tag)), rows: h.rowsFor(tag) });
  }
  return out;
}

/**
 * Starts `count` sessions on the group's employee, `spacingMs` apart (0: all at once), each with its own ledger tag.
 * @param {any} h
 * @param {number} count
 * @param {{ spacingMs?: number, engine?: string }} [options]
 */
async function startSessions(h, count, { spacingMs = SPACING_MS, engine } = {}) {
  const employee = h.layout.employees.onA;
  const begin = async () => {
    const tag = h.newTag();
    const result = await h.api("POST", "/api/sessions", { prompt: `Reply briefly. ${tag}`, employee, source: "web", ...(engine ? { engine } : {}) });
    if (result.status !== 201) throw new Error(`POST /api/sessions refused (${result.status}): ${result.body?.error ?? JSON.stringify(result.body)}`);
    h.sessions.push(result.body.id);
    return { id: result.body.id, tag };
  };
  if (spacingMs === 0) return Promise.all(Array.from({ length: count }, begin));
  const started = [];
  for (let i = 0; i < count; i += 1) {
    started.push(await begin());
    if (i < count - 1) await sleep(spacingMs);
  }
  return started;
}

/** Counts of the sessions that landed on each account by what the gateway recorded, after checking the ledger agrees session by session. */
function countPicks(keys, described) {
  const counts = { A: 0, B: 0 };
  for (const one of described) {
    expectTrue("the session records its pick", one.pick, `no fallback.chain.pick on session ${one.id}: ${JSON.stringify(one.session.fallback?.chain)}`);
    const account = Object.keys(keys).find((name) => keys[name] === one.pick.picked);
    expectTrue("the pick names a member of the group", account, one.pick.picked);
    expectEqual("the ledger's profile for the first turn is the picked account", one.profile, PROFILE_OF[account]);
    counts[account] += 1;
  }
  return counts;
}

/** The candidates' weights and shares as the pick recorded them, by account name. */
function sharesOf(keys, pick) {
  const byAccount = {};
  for (const candidate of pick.candidates) {
    const name = Object.keys(keys).find((account) => keys[account] === candidate.account);
    if (name) byAccount[name] = { weight: candidate.weight, share: candidate.sharePercent };
  }
  return byAccount;
}

function expectWithin(label, actual, expected, tolerance) {
  expectTrue(`${label}: ${expected} ±${tolerance}`, Math.abs(actual - expected) <= tolerance, `got ${actual}`);
}

/** A split by headroom: `used` is each account's tightest-window use, so headroom is 100 minus it. */
async function splitBy(h, keys, { used, count, expectedA, shares }) {
  h.seedUsage(keys.A, used.A);
  h.seedUsage(keys.B, used.B);
  const described = await describe(h, await startSessions(h, count));
  const counts = countPicks(keys, described);
  expectEqual(`${count} sessions are all accounted for`, counts.A + counts.B, count);
  expectWithin(`account A of ${count} at headroom ${100 - used.A}/${100 - used.B}`, counts.A, expectedA, 1);
  expectWithin(`account B of ${count} at headroom ${100 - used.A}/${100 - used.B}`, counts.B, count - expectedA, 1);
  expectEqual("the pick's weights and shares", sharesOf(keys, described.at(-1).pick), shares);
  return { described, counts };
}

/** distribution: headroom 60/40 splits 12/8 of 20, 90/10 splits 18/2, an exhausted member gets none of 10, each within ±1. */
async function distribution(h) {
  const keys = await h.useGroup();
  h.writeScenario({ claude: { "*": "ok" } });
  await splitBy(h, keys, { used: { A: 40, B: 60 }, count: 20, expectedA: 12, shares: { A: { weight: 60, share: 60 }, B: { weight: 40, share: 40 } } });
  await splitBy(h, keys, { used: { A: 10, B: 90 }, count: 20, expectedA: 18, shares: { A: { weight: 90, share: 90 }, B: { weight: 10, share: 10 } } });
  const { counts, described } = await splitBy(h, keys, { used: { A: 20, B: 100 }, count: 10, expectedA: 10, shares: { A: { weight: 80, share: 100 }, B: { weight: 0, share: 0 } } });
  expectEqual("an exhausted member is never picked", counts.B, 0);
  expectTrue("the pick says why", described.every((one) => one.pick.reason === "weighted"), JSON.stringify(described.map((one) => one.pick.reason)));
}

/** burst: ten sessions started at once against two equally fresh accounts split 5/5 ±1 and never all land on one. */
async function burst(h) {
  const keys = await h.useGroup();
  h.writeScenario({ claude: { "*": "ok" } });
  h.seedUsage(keys.A, 30);
  h.seedUsage(keys.B, 30);
  const described = await describe(h, await startSessions(h, 10, { spacingMs: 0 }));
  const counts = countPicks(keys, described);
  expectEqual("ten sessions are all accounted for", counts.A + counts.B, 10);
  expectWithin("account A of ten started together", counts.A, 5, 1);
  expectWithin("account B of ten started together", counts.B, 5, 1);
  expectTrue("a burst never lands on one account", counts.A > 0 && counts.B > 0, JSON.stringify(counts));
  expectEqual("an even split of weights", sharesOf(keys, described[0].pick), { A: { weight: 70, share: 50 }, B: { weight: 70, share: 50 } });
}

/** A group of the account's own and one more: a limit on the own account moves the turn to the other member, a limit there goes on to opencode, the hops in order. */
async function groupHopThenRest(h) {
  const keys = await h.useGroup();
  const { opencodeX } = h.links();
  // B has no headroom, so the session is A's whichever way a pick goes; the walk is what is under test.
  h.seedUsage(keys.A, 0);
  h.seedUsage(keys.B, 100);
  h.writeScenario({ claude: { "profile-a|*": "rate-limit", "profile-b|*": "rate-limit" }, opencode: { [opencodeX.model]: "ok" } });
  const tag = h.newTag();
  const session = await h.settled(await h.startSession({ employee: h.layout.employees.onA, tag }));
  expectEqual("the walk the ledger recorded", walkOf(h.rowsFor(tag)), `claude/profile-a/opus:rate-limit -> claude/profile-b/opus:rate-limit -> opencode/${opencodeX.model}:ok`);
  expectEqual("hop targets in order", chainHops(session).map((hop) => hop.to), ["claude|B|opus", linkKey(opencodeX)]);
  expectEqual("session status", session.status, "idle");
}

/** The same walk from the other side: a session the pick put on B moves to A (the group's other member) on B's limit, then to opencode on A's. */
async function groupHopFromPick(h) {
  const keys = await h.useGroup();
  const { opencodeX } = h.links();
  h.seedUsage(keys.A, 100);
  h.seedUsage(keys.B, 0);
  h.writeScenario({ claude: { "profile-a|*": "rate-limit", "profile-b|*": "rate-limit" }, opencode: { [opencodeX.model]: "ok" } });
  const tag = h.newTag();
  const session = await h.settled(await h.startSession({ employee: h.layout.employees.onA, tag }));
  expectEqual("the pick is B", pickOf(session)?.picked, keys.B);
  expectEqual("the walk the ledger recorded", walkOf(h.rowsFor(tag)), `claude/profile-b/opus:rate-limit -> claude/profile-a/opus:rate-limit -> opencode/${opencodeX.model}:ok`);
  expectEqual("hop targets in order", chainHops(session).map((hop) => hop.to), ["claude|A|opus", linkKey(opencodeX)]);
}

/** A pinned session keeps its account: five turns and a resume after a gateway restart, while the other account's usage drops below it. */
async function stickiness(h) {
  const keys = await h.useGroup();
  h.writeScenario({ claude: { "*": "ok" } });
  h.seedUsage(keys.A, 0);
  h.seedUsage(keys.B, 100);
  const tag = h.newTag();
  const id = await h.startSession({ employee: h.layout.employees.onA, tag });
  const first = await h.settled(id);
  const pick = pickOf(first);
  expectEqual("pinned to A at its start", pick?.picked, keys.A);
  // B is now the far better account, and A the nearly spent one.
  h.seedUsage(keys.A, 90);
  h.seedUsage(keys.B, 0);
  for (let turn = 2; turn <= 5; turn += 1) {
    await h.sendMessage(id, tag);
    await h.settled(id);
  }
  await h.restartGateway();
  await h.sendMessage(id, tag);
  const last = await h.settled(id);
  const rows = h.rowsFor(tag);
  expectEqual("six turns ran", rows.length, 6);
  expectEqual("every turn ran on A", [...new Set(rows.map((row) => row.profile))], ["profile-a"]);
  expectEqual("no hop", chainHops(last), []);
  expectEqual("no re-pick: the pick is the one made at the start", pickOf(last), pick);
}

/** Pinned to B, a limit on B moves the session to A; clearing B's limit sends the next turn back to B, the account it was pinned to, not to A or to the group's first member. */
async function returnToPinned(h) {
  const keys = await h.useGroup();
  h.seedUsage(keys.A, 100);
  h.seedUsage(keys.B, 0);
  h.writeScenario({ claude: { "profile-b|*": [limitedFor(3600), "ok"], "profile-a|*": "ok" } });
  const tag = h.newTag();
  const id = await h.startSession({ employee: h.layout.employees.onA, tag });
  const first = await h.settled(id);
  expectEqual("pinned to B", pickOf(first)?.picked, keys.B);
  expectEqual("B's limit moved the turn to A", walkOf(h.rowsFor(tag)), "claude/profile-b/opus:rate-limit -> claude/profile-a/opus:ok");
  const exhausted = Object.entries(healthOf(h)).filter(([, record]) => record.state === "exhausted").map(([key]) => key);
  expectEqual("one exhausted record (B's)", exhausted, [keys.B]);
  cliClear(h, keys.B);
  await h.sendMessage(id, tag);
  const after = await h.settled(id);
  expectEqual("the next turn is back on B", h.rowsFor(tag).at(-1).profile, "profile-b");
  expectEqual("position and pick", [after.fallback?.chain?.position, pickOf(after)?.picked], [0, keys.B]);
}

/** Spawn, delegate, a Todo wake and the Todo Dispatcher through the API: each returns the id of the session it started. */
const startVia = {
  async spawn(h, { employee, tag, parent }) {
    const spawned = await h.api("POST", "/api/sessions", { prompt: `Reply briefly. ${tag}`, employee, parentSessionId: parent, source: "web" });
    expectEqual("spawn: status", spawned.status, 201);
    return spawned.body.id;
  },
  async delegate(h, { employee, tag, parent }) {
    const delegated = await h.api("POST", "/api/delegations", { task: `Reply briefly. ${tag}`, employee, parentSessionId: parent });
    expectTrue("delegate: accepted", delegated.status === 201 || delegated.status === 200, `${delegated.status} ${JSON.stringify(delegated.body)}`);
    return delegated.body.sessionId;
  },
  /** A mention on the assigned Todo starts the employee's own session on it (the Todo wake). */
  async wake(h, { employee, tag }) {
    const todoId = await newTodo(h, `Reply briefly ${tag}`, `Reply briefly. ${tag}`, employee);
    const commented = await h.api("POST", `/api/work-items/${todoId}/comments`, { body: `@${employee} Reply briefly. ${tag}` });
    expectTrue("Todo wake: comment accepted", commented.status === 200 || commented.status === 201, `${commented.status} ${JSON.stringify(commented.body)}`);
    const linked = await h.api("GET", `/api/work-items/${todoId}/sessions`);
    const sessions = linked.body?.sessions ?? linked.body ?? [];
    expectEqual("Todo wake: one session started on the Todo", sessions.length, 1);
    return sessions[0].id ?? sessions[0].sessionId;
  },
  /** The built-in Todo Dispatcher runs as the default login, which the group [A, B] does not hold: no pick (design 3). */
  async dispatch(h, { employee, tag }) {
    const todoId = await newTodo(h, `Reply briefly ${tag}`, `Reply briefly. ${tag}`, employee);
    const dispatched = await h.api("POST", `/api/work-items/${todoId}/dispatch`, {});
    expectEqual("Todo dispatch: status", dispatched.status, 201);
    return dispatched.body.sessionId;
  },
};

/** A Todo assigned to `employee`; returns its id. */
async function newTodo(h, title, body, employee) {
  const todo = await h.api("POST", "/api/work-items", { title, body });
  expectEqual("Todo: created", todo.status, 201);
  const id = todo.body.workItem?.id ?? todo.body.id;
  expectEqual("Todo: assigned", (await h.api("POST", `/api/work-items/${id}/assign`, { assignee: employee })).status, 200);
  return id;
}

/**
 * The board walk starts a Todo through the same dispatcher call the button uses (the dispatch case). What the
 * walk decides is a model turn, and a fake model calls none of the walk's tools, so a tick cannot start a Todo
 * here and reports that its turn decided nothing. It is driven for what it can show: the tick runs its turn on
 * the fakes, and starts no session on the Todo by itself.
 */
async function boardWalkTick(h, employee) {
  const walkId = await newTodo(h, "Walk fixture", "A Todo for the board walk to see.", employee);
  const tick = await h.api("POST", "/api/board-walk/tick?wait=1");
  expectEqual("board walk tick: status", tick.status, 200);
  expectTrue("board walk tick: its turn ran", tick.body.tick?.sessionId, JSON.stringify(tick.body.tick));
  const walkSessions = await h.api("GET", `/api/work-items/${walkId}/sessions`);
  expectEqual("the tick started no session on the Todo by itself", (walkSessions.body?.sessions ?? walkSessions.body ?? []).length, 0);
}

/** Every way a session starts gets a pick, and `engine: "claude:<name>"` gets none. A has no headroom and B all of it, so a picked session is on B and a pinned one on A. */
async function startPaths(h) {
  const keys = await h.useGroup();
  const employee = h.layout.employees.onA;
  h.writeScenario({ claude: { "*": "ok" } });
  h.seedUsage(keys.A, 100);
  h.seedUsage(keys.B, 0);
  const results = {};
  const record = async (path, id, tag) => {
    h.sessions.push(id);
    results[path] = { pick: pickOf(await h.settled(id))?.picked, profile: firstProfile(h.rowsFor(tag)) };
  };
  const chat = await startSessions(h, 1);
  await record("new chat", chat[0].id, chat[0].tag);
  const [engineNamed] = await startSessions(h, 1, { engine: "claude" });
  await record('new chat, engine "claude"', engineNamed.id, engineNamed.tag);
  const [pinned] = await startSessions(h, 1, { engine: "claude:A" });
  await record('new chat, engine "claude:A"', pinned.id, pinned.tag);
  for (const path of ["spawn", "delegate", "wake", "dispatch"]) {
    const tag = h.newTag();
    await record(path, await startVia[path](h, { employee, tag, parent: chat[0].id }), tag);
  }
  await boardWalkTick(h, employee);

  for (const path of ["new chat", 'new chat, engine "claude"', "spawn", "delegate", "wake"]) {
    expectEqual(`${path}: picked B and ran on B`, results[path], { pick: keys.B, profile: "profile-b" });
  }
  expectEqual("the Todo Dispatcher's own login is not in the group, so it gets no pick", results.dispatch?.pick, undefined);
  expectEqual('engine "claude:A" pins A and gets no pick', results['new chat, engine "claude:A"'], { pick: undefined, profile: "profile-a" });
}

export const GROUP_SCENARIOS = [
  { id: "p", title: "distribution: new sessions split by headroom (60/40 gives 12/8 of 20, 90/10 gives 18/2, an exhausted member none)", run: distribution },
  { id: "q", title: "burst: ten sessions started at once across two fresh accounts split 5/5, never all on one", run: burst },
  { id: "r", title: "group hop then rest: a limit on the own account moves the turn to the other member, then on to opencode, hops in order", run: groupHopThenRest },
  { id: "s", title: "group hop from a pick: a session picked onto B moves to A on B's limit, then to opencode", run: groupHopFromPick },
  { id: "t", title: "stickiness: a pinned session keeps its account over five turns and a restart while the other account's usage drops below it", run: stickiness },
  { id: "u", title: "return: pinned to B and moved to A by a limit, the next turn after B is cleared goes back to B", run: returnToPinned },
  { id: "v", title: "start paths: new chat (with and without engine claude), spawn, delegate and a Todo wake each get a pick, the Todo Dispatcher (default login) none; claude:<name> gets none; a board walk tick runs", run: startPaths },
];
