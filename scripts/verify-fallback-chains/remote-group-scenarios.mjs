// The remote account group scenarios (docs/design/fallback-account-groups.md section 11): the counterparts of p, r, t and u
// of group-scenarios.mjs for an employee that runs on a host over ssh. The host is this machine, reached through the stand-in
// `ssh` that ssh-shim.mjs installs first on the instance's PATH: the real gateway stages the host, opens its tunnel and runs
// the fake `claude` there with HOME at a temporary "remote home", exactly as it would on another machine, with no daemon, no
// key and no network.
//
// The employee runs as remote account A (its `remoteClaudeConfigDir`), and the group at the head of its chain holds the
// declared remote accounts A and B (config directories under the remote home). A pick of A is the employee's own login and
// writes no pin; a pick of B is recorded in `transportMeta.remoteAccountPin`, and every launch on the host then runs with that
// account's directory as `CLAUDE_CONFIG_DIR`. Each scenario asserts three things agree: the pick (`transportMeta.accountPick`),
// the pin, and the directory each turn's fake claude ran with (the ledger's profile directory).
//
// Ids rp, rr, rt, ru.
import { expectEqual, expectTrue, sleep, walkOf } from "./lib.mjs";
import { chainHops, cliClear, healthOf, limitedFor } from "./scenario-defs.mjs";
import { expectWithin } from "./group-scenarios.mjs";

const SPACING_MS = 400;
const NAMES = { A: "remote-a", B: "remote-b" };

const pickOf = (session) => session.fallback?.chain?.pick;
const pinOf = (session) => session.transportMeta?.remoteAccountPin;
const recordedPick = (session) => session.transportMeta?.accountPick;
const firstDir = (rows) => rows.find((row) => row.outcome !== undefined)?.profileDir;

/**
 * Declares remote accounts A and B (directories under the remote home, on the employee's own `user@host`), puts the group
 * [A, B] as the remote employee's chain, and returns the accounts' store keys and directories.
 */
async function useRemoteGroup(h) {
  const { remote } = h.layout;
  const declared = (configDir) => ({ remoteHost: remote.host, remoteUser: remote.user, configDir });
  const group = { group: [{ engine: "claude", profile: NAMES.A }, { engine: "claude", profile: NAMES.B }] };
  await h.putConfig({ engines: { claude: { accounts: { [NAMES.A]: declared(remote.profiles.A), [NAMES.B]: declared(remote.profiles.B) } } } });
  const patched = await h.api("PATCH", `/api/org/employees/${h.layout.employees.remote}`, { fallback: [group] });
  expectEqual("PATCH the remote employee's chain: status", patched.status, 200);
  const employee = h.layout.employees.remote;
  const view = (await h.api("GET", `/api/fallback-chains?employee=${employee}`)).body;
  const subject = view?.subjects?.find((entry) => entry.kind === "employee" && entry.id === employee);
  // The profiles list names each declared account's store key (`claude@<user>@<host>:<profile key>`) and its directory on the host.
  const keyOf = (name) => view?.profiles?.find((profile) => profile.name === name)?.account;
  const keys = { A: keyOf(NAMES.A), B: keyOf(NAMES.B) };
  expectTrue("the chains API names both remote accounts", keys.A && keys.B && keys.A !== keys.B, JSON.stringify(view?.profiles));
  expectEqual("the employee's own account is remote account A", subject?.primary?.account, keys.A);
  return { keys, dirs: { A: remote.profiles.A, B: remote.profiles.B } };
}

/** Each started session settled, with the pick, the pin and the directory its first turn ran with. */
async function describe(h, started) {
  const out = [];
  for (const { id, tag } of started) {
    const session = await h.settled(id);
    out.push({ id, tag, session, pick: pickOf(session), pin: pinOf(session), rows: h.rowsFor(tag), ranWith: firstDir(h.rowsFor(tag)) });
  }
  return out;
}

async function startSessions(h, count, spacingMs = SPACING_MS) {
  const started = [];
  for (let i = 0; i < count; i += 1) {
    const tag = h.newTag();
    started.push({ id: await h.startSession({ employee: h.layout.employees.remote, tag }), tag });
    if (i < count - 1) await sleep(spacingMs);
  }
  return started;
}

/** Counts by account of the picks the gateway recorded, after checking the pin and the directory the host ran each session with agree. */
function countPicks(accounts, described) {
  const counts = { A: 0, B: 0 };
  for (const one of described) {
    expectTrue("the session records its pick", one.pick, `no fallback.chain.pick on session ${one.id}: ${JSON.stringify(one.session.fallback?.chain)}`);
    const account = Object.keys(accounts.keys).find((name) => accounts.keys[name] === one.pick.picked);
    expectTrue("the pick names a member of the group", account, one.pick.picked);
    expectEqual("transportMeta.accountPick is the pick", recordedPick(one.session)?.picked, one.pick.picked);
    // The own login writes no pin; the other account is pinned with its directory on the host.
    expectEqual(`the pin of a session picked onto ${account}`, one.pin, account === "A" ? undefined : { account: accounts.keys.B, configDir: accounts.dirs.B });
    expectEqual("a remote pin never sets the gateway-side claudeConfigDir", one.session.claudeConfigDir ?? null, null);
    expectEqual("the host ran the first turn with the picked account's directory", one.ranWith, accounts.dirs[account]);
    counts[account] += 1;
  }
  return counts;
}

/** The ssh shim answered the host's calls, and refused none. */
function expectShimUsed(h) {
  expectTrue("the stand-in ssh answered the host's commands", h.shimCalls().length > 0, "no call reached the shim: the gateway used another ssh");
  expectEqual("the stand-in ssh refused nothing", h.shimRefusals(), []);
  // The host's profile probe names the system-wide Claude policy directories; the shim keeps them inside the remote home.
  const targets = h.shimCalls().flatMap((call) => call.rewroteTo ?? []);
  expectTrue("the profile probe's system paths were kept inside the remote home", targets.length > 0, "no call named a system policy directory, so the probe did not run as expected");
  expectTrue("every rewrite points inside the remote home", targets.every((target) => target.startsWith(`${h.layout.remote.home}/`)), JSON.stringify([...new Set(targets)]));
}

/** distribution: headroom 60/40 splits ten spaced sessions 6/4, and a member with no headroom gets none of four, each within ±1. */
async function distribution(h) {
  const accounts = await useRemoteGroup(h);
  h.writeScenario({ claude: { "*": "ok" } });
  const split = async ({ used, count, expectedA }) => {
    h.seedUsage(accounts.keys.A, used.A);
    h.seedUsage(accounts.keys.B, used.B);
    const described = await describe(h, await startSessions(h, count));
    const counts = countPicks(accounts, described);
    expectEqual(`${count} sessions are all accounted for`, counts.A + counts.B, count);
    expectWithin(`account A of ${count} at headroom ${100 - used.A}/${100 - used.B}`, counts.A, expectedA, 1);
    expectWithin(`account B of ${count} at headroom ${100 - used.A}/${100 - used.B}`, counts.B, count - expectedA, 1);
    return { counts, described };
  };
  await split({ used: { A: 40, B: 60 }, count: 10, expectedA: 6 });
  const { counts, described } = await split({ used: { A: 20, B: 100 }, count: 4, expectedA: 4 });
  expectEqual("an exhausted member is never picked", counts.B, 0);
  expectTrue("the pick says why", described.every((one) => one.pick.reason === "weighted"), JSON.stringify(described.map((one) => one.pick.reason)));
  expectShimUsed(h);
}

/** A session whose limit on `from` moves its turn to the other member: A (the own login) to B and B (the pin) to A, each ran with the right directory. */
async function groupHop(h) {
  const accounts = await useRemoteGroup(h);
  for (const [from, to] of [["A", "B"], ["B", "A"]]) {
    h.seedUsage(accounts.keys[from], 0);
    h.seedUsage(accounts.keys[to], 100);
    h.writeScenario({ claude: { [`${dirName(accounts.dirs[from])}|*`]: "rate-limit", [`${dirName(accounts.dirs[to])}|*`]: "ok" } });
    const tag = h.newTag();
    const session = await h.settled(await h.startSession({ employee: h.layout.employees.remote, tag }));
    const rows = h.rowsFor(tag);
    expectEqual(`the pick is ${from}`, pickOf(session)?.picked, accounts.keys[from]);
    expectEqual(`the walk from ${from} the ledger recorded`, walkOf(rows), `claude/${dirName(accounts.dirs[from])}/opus:rate-limit -> claude/${dirName(accounts.dirs[to])}/opus:ok`);
    expectEqual("each turn ran with its own account's directory", rows.map((row) => row.profileDir), [accounts.dirs[from], accounts.dirs[to]]);
    expectEqual(`one hop, to ${to}`, chainHops(session).length, 1);
    // The pin is the session's own account: the hop does not move it.
    expectEqual("the pin is still the pick's", pinOf(session), from === "B" ? { account: accounts.keys.B, configDir: accounts.dirs.B } : undefined);
    expectEqual("the gateway-side claudeConfigDir stays unset", session.claudeConfigDir ?? null, null);
    expectEqual("session status", session.status, "idle");
  }
  expectShimUsed(h);
}

const dirName = (dir) => dir.slice(dir.lastIndexOf("/") + 1);

/** A session pinned to B keeps B's directory over five turns and a gateway restart while A's usage drops below B's, with the pin and the pick unchanged. */
async function stickiness(h) {
  const accounts = await useRemoteGroup(h);
  h.writeScenario({ claude: { "*": "ok" } });
  h.seedUsage(accounts.keys.A, 100);
  h.seedUsage(accounts.keys.B, 0);
  const tag = h.newTag();
  const id = await h.startSession({ employee: h.layout.employees.remote, tag });
  const first = await h.settled(id);
  expectEqual("pinned to B at its start", pickOf(first)?.picked, accounts.keys.B);
  expectEqual("the pin", pinOf(first), { account: accounts.keys.B, configDir: accounts.dirs.B });
  // A is now the far better account, and B the nearly spent one.
  h.seedUsage(accounts.keys.A, 0);
  h.seedUsage(accounts.keys.B, 90);
  for (let turn = 2; turn <= 5; turn += 1) {
    await h.sendMessage(id, tag);
    await h.settled(id);
  }
  await h.restartGateway();
  await h.sendMessage(id, tag);
  const last = await h.settled(id);
  const rows = h.rowsFor(tag);
  expectEqual("six turns ran", rows.length, 6);
  expectEqual("every turn ran with B's directory", [...new Set(rows.map((row) => row.profileDir))], [accounts.dirs.B]);
  expectEqual("no hop", chainHops(last), []);
  expectEqual("the pin survived the restart", pinOf(last), pinOf(first));
  expectEqual("the gateway-side claudeConfigDir stays unset", last.claudeConfigDir ?? null, null);
  expectEqual("no re-pick: the pick is the one made at the start", recordedPick(last), recordedPick(first));
  expectShimUsed(h);
}

/** Pinned to B, a limit on B moves the session to A (the own login); once B is cleared the next turn runs with B's directory again, never the employee's. */
async function returnToPinned(h) {
  const accounts = await useRemoteGroup(h);
  h.seedUsage(accounts.keys.A, 100);
  h.seedUsage(accounts.keys.B, 0);
  const b = dirName(accounts.dirs.B);
  const a = dirName(accounts.dirs.A);
  h.writeScenario({ claude: { [`${b}|*`]: [limitedFor(3600), "ok"], [`${a}|*`]: "ok" } });
  const tag = h.newTag();
  const id = await h.startSession({ employee: h.layout.employees.remote, tag });
  const first = await h.settled(id);
  expectEqual("pinned to B", pickOf(first)?.picked, accounts.keys.B);
  expectEqual("B's limit moved the turn to A's directory", walkOf(h.rowsFor(tag)), `claude/${b}/opus:rate-limit -> claude/${a}/opus:ok`);
  const held = Object.entries(healthOf(h)).filter(([, record]) => record.state !== "ok").map(([key]) => key);
  expectEqual("one held record, B's", held, [accounts.keys.B]);
  cliClear(h, accounts.keys.B);
  await h.sendMessage(id, tag);
  const after = await h.settled(id);
  expectEqual("the next turn ran with B's directory again", h.rowsFor(tag).at(-1).profileDir, accounts.dirs.B);
  expectEqual("position, pick and pin", [after.fallback?.chain?.position, pickOf(after)?.picked, pinOf(after)], [0, accounts.keys.B, { account: accounts.keys.B, configDir: accounts.dirs.B }]);
  expectEqual("the gateway-side claudeConfigDir stays unset", after.claudeConfigDir ?? null, null);
  expectShimUsed(h);
}

export const REMOTE_GROUP_SCENARIOS = [
  { id: "rp", title: "remote distribution: a remote employee's new sessions split by headroom across two accounts on its host (60/40 gives 6/4 of 10, an exhausted account none), the pin and the host's CLAUDE_CONFIG_DIR agreeing", run: distribution },
  { id: "rr", title: "remote group hop: a limit on the own login moves the turn to the other account's directory on the host, and a limit on a pinned account moves it to the own login", run: groupHop },
  { id: "rt", title: "remote stickiness: a session pinned to the second account keeps its directory over five turns and a gateway restart while the other account's usage drops below it", run: stickiness },
  { id: "ru", title: "remote return: pinned to the second account and moved by a limit, the next turn after it is cleared runs with the pinned account's directory again", run: returnToPinned },
];
