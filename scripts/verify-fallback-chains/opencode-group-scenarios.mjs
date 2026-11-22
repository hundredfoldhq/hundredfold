// The opencode account group scenarios (docs/design/fallback-account-groups.md section 10): the counterparts of
// group-scenarios.mjs for a chain whose first entry is a group of two opencode accounts. An opencode account is a
// provider id, so the two accounts are two fake providers that serve one model key (the fake `opencode models` lists
// `own-provider/model-own` and `group-b-provider/model-own`), and a session's pin is its `model` column.
//
// Headroom is seeded the way the gateway reads it: one sample in each account's usage history, keyed
// `opencode/<provider>` (`h.seedUsage`). Each scenario asserts three things agree for every session it starts:
// the account the gateway says it picked (`transportMeta.accountPick`, also `fallback.chain.pick`), the session row's
// `model` (`<picked provider>/<model key>`), and the model the fake opencode ran each turn on (the ledger).
//
// Ids op..ov, run in both opencode modes (`run` and `server`) by the script like every other scenario.
import { expectEqual, expectTrue, sleep, walkOf } from "./lib.mjs";
import { chainHops, cliClear, healthOf, limitedFor, linkKey } from "./scenario-defs.mjs";
import { boardWalkTick, expectWithin, startVia } from "./group-scenarios.mjs";

const SPACING_MS = 400;

const pickOf = (session) => session.fallback?.chain?.pick;
const recordedPick = (session) => session.transportMeta?.accountPick;
const firstModel = (rows) => rows.find((row) => row.outcome !== undefined)?.model;

/** The account name (A or B) whose key is `key`, or undefined. */
const accountNamed = (keys, key) => Object.keys(keys).find((name) => keys[name] === key);

/**
 * Starts `count` sessions of the opencode employee, `spacingMs` apart (0: all at once), each with its own ledger tag.
 * `engine` and `model` go to the API as given; `employee: null` starts one with no employee (the engine's own chain).
 * @param {any} h
 * @param {number} count
 * @param {{ spacingMs?: number, engine?: string, model?: string, employee?: string | null }} [options]
 */
async function startSessions(h, count, { spacingMs = SPACING_MS, engine, model, employee = h.layout.employees.onOpencode } = {}) {
  const begin = async () => {
    const tag = h.newTag();
    const result = await h.api("POST", "/api/sessions", {
      prompt: `Reply briefly. ${tag}`, source: "web", ...(employee ? { employee } : {}), ...(engine ? { engine } : {}), ...(model ? { model } : {}),
    });
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

/** Each started session settled, with the pick it records and the model its first turn ran on. */
async function describe(h, started) {
  const out = [];
  for (const { id, tag } of started) {
    const session = await h.settled(id);
    out.push({ id, tag, session, pick: pickOf(session), rows: h.rowsFor(tag), ranOn: firstModel(h.rowsFor(tag)) });
  }
  return out;
}

/** The pick's candidates' weights and shares by account name. */
function sharesOf(accounts, pick) {
  const byAccount = {};
  for (const candidate of pick.candidates) {
    const name = accountNamed(accounts.keys, candidate.account);
    if (name) byAccount[name] = { weight: candidate.weight, share: candidate.sharePercent };
  }
  return byAccount;
}

/** Counts by account of the picks the gateway recorded, after checking the row's model, the recorded pick and the ledger agree session by session. */
function countPicks(accounts, described) {
  const counts = { A: 0, B: 0 };
  for (const one of described) {
    expectTrue("the session records its pick", one.pick, `no fallback.chain.pick on session ${one.id}: ${JSON.stringify(one.session.fallback?.chain)}`);
    const account = accountNamed(accounts.keys, one.pick.picked);
    expectTrue("the pick names a member of the group", account, one.pick.picked);
    expectEqual("transportMeta.accountPick is the pick", recordedPick(one.session)?.picked, one.pick.picked);
    expectEqual("the session row's model is the picked provider's", one.session.model, accounts.models[account]);
    expectEqual("the ledger's model for the first turn is the picked account's", one.ranOn, accounts.models[account]);
    counts[account] += 1;
  }
  return counts;
}

/** A split by headroom: `used` is each account's tightest-window use, so headroom is 100 minus it. */
async function splitBy(h, accounts, { used, count, expectedA, shares }) {
  h.seedUsage(accounts.keys.A, used.A);
  h.seedUsage(accounts.keys.B, used.B);
  const described = await describe(h, await startSessions(h, count));
  const counts = countPicks(accounts, described);
  expectEqual(`${count} sessions are all accounted for`, counts.A + counts.B, count);
  expectWithin(`account A of ${count} at headroom ${100 - used.A}/${100 - used.B}`, counts.A, expectedA, 1);
  expectWithin(`account B of ${count} at headroom ${100 - used.A}/${100 - used.B}`, counts.B, count - expectedA, 1);
  expectEqual("the pick's weights and shares", sharesOf(accounts, described.at(-1).pick), shares);
  return { described, counts };
}

/** distribution: headroom 60/40 splits 12/8 of 20, 90/10 splits 18/2, an exhausted member gets none of 10, each within ±1. */
async function distribution(h) {
  const accounts = await h.useOpencodeGroup();
  h.writeScenario({ opencode: { "*": "ok" } });
  await splitBy(h, accounts, { used: { A: 40, B: 60 }, count: 20, expectedA: 12, shares: { A: { weight: 60, share: 60 }, B: { weight: 40, share: 40 } } });
  await splitBy(h, accounts, { used: { A: 10, B: 90 }, count: 20, expectedA: 18, shares: { A: { weight: 90, share: 90 }, B: { weight: 10, share: 10 } } });
  const { counts, described } = await splitBy(h, accounts, { used: { A: 20, B: 100 }, count: 10, expectedA: 10, shares: { A: { weight: 80, share: 100 }, B: { weight: 0, share: 0 } } });
  expectEqual("an exhausted member is never picked", counts.B, 0);
  expectTrue("the pick says why", described.every((one) => one.pick.reason === "weighted"), JSON.stringify(described.map((one) => one.pick.reason)));
  expectEqual("the instance runs the opencode mode under test", described[0].rows[0].mode, h.layout.mode);
}

/** burst: ten sessions started at once against two equally fresh accounts split 5/5 ±1 and never all land on one. */
async function burst(h) {
  const accounts = await h.useOpencodeGroup();
  h.writeScenario({ opencode: { "*": "ok" } });
  h.seedUsage(accounts.keys.A, 30);
  h.seedUsage(accounts.keys.B, 30);
  const described = await describe(h, await startSessions(h, 10, { spacingMs: 0 }));
  const counts = countPicks(accounts, described);
  expectEqual("ten sessions are all accounted for", counts.A + counts.B, 10);
  expectWithin("account A of ten started together", counts.A, 5, 1);
  expectWithin("account B of ten started together", counts.B, 5, 1);
  expectTrue("a burst never lands on one account", counts.A > 0 && counts.B > 0, JSON.stringify(counts));
  expectEqual("an even split of weights", sharesOf(accounts, described[0].pick), { A: { weight: 70, share: 50 }, B: { weight: 70, share: 50 } });
}

/** A walk of the group then the rest: `from` is the account the pick lands on (the other has no headroom), `then` the member it moves to. */
async function groupWalk(h, { from, then }) {
  const accounts = await h.useOpencodeGroup();
  const { opencodeX } = h.links();
  h.seedUsage(accounts.keys[from], 0);
  h.seedUsage(accounts.keys[then], 100);
  h.writeScenario({ opencode: { [accounts.models.A]: "rate-limit", [accounts.models.B]: "rate-limit", [opencodeX.model]: "ok" } });
  const tag = h.newTag();
  const session = await h.settled(await h.startSession({ employee: h.layout.employees.onOpencode, tag }));
  const rows = h.rowsFor(tag);
  expectEqual("the pick", pickOf(session)?.picked, accounts.keys[from]);
  expectEqual("the walk the ledger recorded", walkOf(rows), `opencode/${accounts.models[from]}:rate-limit -> opencode/${accounts.models[then]}:rate-limit -> opencode/${opencodeX.model}:ok`);
  expectEqual("hop targets in order", chainHops(session).map((hop) => hop.to), [linkKey({ engine: "opencode", model: accounts.models[then] }), linkKey(opencodeX)]);
  // The stand-in on the other member runs on that member's model, not the model the session was pinned to.
  expectEqual("the other member's turn ran on its own provider's model", rows[1].model, accounts.models[then]);
  expectEqual("one opencode session carries the walk", [...new Set(rows.map((row) => row.sessionId))].length, 1);
  expectEqual("session status", session.status, "idle");
}

const groupHopThenRest = (h) => groupWalk(h, { from: "A", then: "B" });
const groupHopFromPick = (h) => groupWalk(h, { from: "B", then: "A" });

/** A pinned session keeps its model: five turns and a resume after a gateway restart, while the other account's usage drops below it. Pinned to the non-own account too, which is the pin that is not the model the employee would have run. */
async function stickiness(h) {
  const accounts = await h.useOpencodeGroup();
  h.writeScenario({ opencode: { "*": "ok" } });
  for (const [pinned, other] of [["A", "B"], ["B", "A"]]) {
    h.seedUsage(accounts.keys[pinned], 0);
    h.seedUsage(accounts.keys[other], 100);
    const tag = h.newTag();
    const id = await h.startSession({ employee: h.layout.employees.onOpencode, tag });
    const first = await h.settled(id);
    const pick = pickOf(first);
    expectEqual(`pinned to ${pinned} at its start`, pick?.picked, accounts.keys[pinned]);
    expectEqual(`the row's model is ${pinned}'s`, first.model, accounts.models[pinned]);
    // The other account is now the far better one, and the pinned one nearly spent.
    h.seedUsage(accounts.keys[pinned], 90);
    h.seedUsage(accounts.keys[other], 0);
    for (let turn = 2; turn <= 5; turn += 1) {
      await h.sendMessage(id, tag);
      await h.settled(id);
    }
    await h.restartGateway();
    await h.sendMessage(id, tag);
    const last = await h.settled(id);
    const rows = h.rowsFor(tag);
    expectEqual(`six turns ran (pinned to ${pinned})`, rows.length, 6);
    expectEqual(`every turn ran on ${pinned}'s model`, [...new Set(rows.map((row) => row.model))], [accounts.models[pinned]]);
    expectEqual("no hop", chainHops(last), []);
    expectEqual("the row's model is unchanged", last.model, accounts.models[pinned]);
    expectEqual("no re-pick: the pick is the one made at the start", recordedPick(last), recordedPick(first));
    await h.api("POST", `/api/sessions/${id}/stop`, {});
  }
}

/** Pinned to B, a limit on B moves the session to A; clearing B's limit sends the next turn back to B's model, not to A or to the group's first member. */
async function returnToPinned(h) {
  const accounts = await h.useOpencodeGroup();
  h.seedUsage(accounts.keys.A, 100);
  h.seedUsage(accounts.keys.B, 0);
  h.writeScenario({ opencode: { [accounts.models.B]: [limitedFor(3600), "ok"], [accounts.models.A]: "ok" } });
  const tag = h.newTag();
  const id = await h.startSession({ employee: h.layout.employees.onOpencode, tag });
  const first = await h.settled(id);
  expectEqual("pinned to B", pickOf(first)?.picked, accounts.keys.B);
  expectEqual("B's limit moved the turn to A, on A's model", walkOf(h.rowsFor(tag)), `opencode/${accounts.models.B}:rate-limit -> opencode/${accounts.models.A}:ok`);
  // A provider's usage limit is held under the provider's key (`opencode/<provider>`), and only B's is.
  const held = Object.entries(healthOf(h)).filter(([, record]) => record.state !== "ok").map(([key]) => key);
  expectEqual("one held record, B's", held, [accounts.keys.B]);
  cliClear(h, accounts.keys.B);
  await h.sendMessage(id, tag);
  const after = await h.settled(id);
  expectEqual("the next turn is back on B's model", h.rowsFor(tag).at(-1).model, accounts.models.B);
  expectEqual("position, pick and the row's model", [after.fallback?.chain?.position, pickOf(after)?.picked, after.model], [0, accounts.keys.B, accounts.models.B]);
}

/**
 * Every way a session starts gets a pick, and a model named on the other account's provider gets none. A has no headroom and B
 * all of it, so a picked session is on B and a pinned one on whichever provider it named.
 */
async function startPaths(h) {
  const accounts = await h.useOpencodeGroup();
  const employee = h.layout.employees.onOpencode;
  h.writeScenario({ opencode: { "*": "ok" }, claude: { "*": "ok" } });
  h.seedUsage(accounts.keys.A, 100);
  h.seedUsage(accounts.keys.B, 0);
  const results = {};
  const record = async (path, id, tag) => {
    h.sessions.push(id);
    const session = await h.settled(id);
    results[path] = { pick: pickOf(session)?.picked, model: session.model, ranOn: firstModel(h.rowsFor(tag)) };
  };
  const via = async (path, options) => {
    const [started] = await startSessions(h, 1, options);
    await record(path, started.id, started.tag);
  };
  await via("new chat", {});
  await via('new chat, engine "opencode"', { engine: "opencode" });
  await via("new chat, no employee", { employee: null, engine: "opencode" });
  await via("new chat, the employee's own model", { model: accounts.models.A });
  await via("new chat, the other account's model", { model: accounts.models.B });
  const parent = (await startSessions(h, 1, { engine: "opencode" }))[0];
  h.sessions.push(parent.id);
  await h.settled(parent.id);
  for (const path of ["spawn", "delegate", "wake", "dispatch"]) {
    const tag = h.newTag();
    await record(path, await startVia[path](h, { employee, tag, parent: parent.id }), tag);
  }
  await boardWalkTick(h, employee);

  const onB = { pick: accounts.keys.B, model: accounts.models.B, ranOn: accounts.models.B };
  for (const path of ["new chat", 'new chat, engine "opencode"', "new chat, no employee", "new chat, the employee's own model", "spawn", "delegate", "wake"]) {
    expectEqual(`${path}: picked B and ran on B's model`, results[path], onB);
  }
  expectEqual("a model named on the other account's provider chooses it: no pick", results["new chat, the other account's model"], { pick: undefined, model: accounts.models.B, ranOn: accounts.models.B });
  // The built-in Todo Dispatcher runs as the instance's default engine (Claude, its default login), which the group does not hold.
  expectEqual("the Todo Dispatcher's own engine is not an opencode account, so it gets no pick", results.dispatch?.pick, undefined);
  expectEqual("the instance runs the opencode mode under test", h.rowsFor(parent.tag)[0].mode, h.layout.mode);
}

export const OPENCODE_GROUP_SCENARIOS = [
  { id: "op", title: "opencode distribution: new sessions split by headroom (60/40 gives 12/8 of 20, 90/10 gives 18/2, an exhausted account none), the model column and the ledger agreeing", run: distribution },
  { id: "oq", title: "opencode burst: ten sessions started at once across two fresh accounts split 5/5, never all on one", run: burst },
  { id: "or", title: "opencode group hop then rest: a limit on the picked account moves the turn to the other account's model, then on to the chain's next link", run: groupHopThenRest },
  { id: "os", title: "opencode group hop from the other side: a session picked onto B moves to A on B's limit, then to the chain's next link", run: groupHopFromPick },
  { id: "ot", title: "opencode stickiness: a pinned session (on either account) keeps its model over five turns and a restart while the other account's usage drops below it", run: stickiness },
  { id: "ou", title: "opencode return: pinned to B and moved to A by a limit, the next turn after B is cleared goes back to B's model", run: returnToPinned },
  { id: "ov", title: "opencode start paths: new chat (with and without engine opencode, with no employee, with the own model), spawn, delegate and a Todo wake each get a pick, a model on the other account none, the Todo Dispatcher none; a board walk tick runs", run: startPaths },
];
