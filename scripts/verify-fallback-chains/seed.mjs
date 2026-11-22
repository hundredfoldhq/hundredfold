// Seeds the throwaway instance of scripts/verify-fallback-chains.sh before it starts:
// two fake Claude profiles (A and B) declared under engines.claude.accounts, the stub
// binaries as absolute `engines.<engine>.bin`, the opencode mode under test, and the
// employees the scenarios drive. Every path it writes is under the temporary host home.
//
//   node seed.mjs --sandbox-home H --host-home T --remote-home M --gateway-repo R --harness-root S --mode run|server
//
// It also lays out the "remote host" a remote employee runs on (ssh-shim.mjs answers `user@127.0.0.1` locally): a
// temporary home of its own with the fake `claude`, a `hundredfold` linked to the build under test, two signed-in fake
// Claude profile directories, a work directory, and the shim's config. The remote accounts that group those profiles are
// declared by the scenarios that use them, not here.
//
// It prints the layout as JSON for the driver (profile directories, employees, models).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const arg = (name) => {
  const index = argv.indexOf(`--${name}`);
  if (index < 0 || !argv[index + 1]) throw new Error(`seed.mjs: --${name} is required`);
  return argv[index + 1];
};
const sandboxHome = arg("sandbox-home");
const hostHome = arg("host-home");
const remoteHome = arg("remote-home");
const gatewayRepo = arg("gateway-repo");
const harnessRoot = arg("harness-root");
const mode = arg("mode");
if (mode !== "run" && mode !== "server") throw new Error(`seed.mjs: --mode is run or server, not ${mode}`);

// The instance home is a child of the temporary host home, the way hundredfold-sandbox.sh lays it out.
if (path.dirname(sandboxHome) !== hostHome) throw new Error(`seed.mjs: ${sandboxHome} is not directly inside the temporary host home ${hostHome}`);

/**
 * own, x, y: the model the opencode employee runs on, and the two a chain hops through; groupB: the same model key
 * on a second provider, which an opencode account group pairs with the own model's provider.
 */
function opencodeModelsFromEnv() {
  const [own, x, y, groupB] = (process.env.FAKE_PROVIDER_OPENCODE_MODELS ?? "").split(",").map((model) => model.trim());
  if (!own || !x || !y || !groupB) throw new Error("seed.mjs: FAKE_PROVIDER_OPENCODE_MODELS must list the own, x, y and group-B models");
  if (own.slice(own.indexOf("/")) !== groupB.slice(groupB.indexOf("/"))) throw new Error("seed.mjs: the group-B model must carry the own model's key on another provider");
  return { own, x, y, groupB };
}

// The verification root holds the host home, the remote home and the shim's files side by side.
const verifyRoot = path.dirname(hostHome);
if (path.dirname(remoteHome) !== verifyRoot) throw new Error(`seed.mjs: ${remoteHome} is not beside the temporary host home ${hostHome}`);
const REMOTE_USER = "harness";

export const LAYOUT = {
  profiles: { A: path.join(hostHome, "profile-a"), B: path.join(hostHome, "profile-b") },
  defaultProfile: path.join(sandboxHome, ".claude-sandbox"),
  bins: {
    claude: path.join(harnessRoot, "scripts/fake-providers/fake-claude.mjs"),
    opencode: path.join(harnessRoot, "packages/hundredfold/src/engines/__tests__/fixtures/fake-opencode.mjs"),
  },
  // The opencode models the scenarios use: the session's own, and the two a chain hops through.
  // From the script (FAKE_PROVIDER_OPENCODE_MODELS), which also hands them to the fake `opencode models`.
  opencodeModels: opencodeModelsFromEnv(),
  employees: {
    onA: "dev-on-a", onDefault: "dev-on-default", onOpencode: "dev-on-opencode", override: "dev-override", remote: "dev-remote",
  },
  // The remote host: `user@127.0.0.1` through the shim, with HOME at `home` and the fake `claude` first on its PATH.
  remote: {
    home: remoteHome,
    user: REMOTE_USER,
    host: "127.0.0.1",
    cwd: path.join(remoteHome, "work"),
    profiles: { A: path.join(remoteHome, "profile-ra"), B: path.join(remoteHome, "profile-rb") },
    shimLog: path.join(verifyRoot, "ssh-shim.jsonl"),
    shimRefusals: path.join(verifyRoot, "ssh-shim-refusals.jsonl"),
  },
};

/** Credentials the sign-in check accepts and nothing can use: a login file with no token in it. */
function fakeLogin(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".credentials.json"), `${JSON.stringify({ claudeAiOauth: { note: "fake-provider-harness" } })}\n`, { mode: 0o600 });
}

function employee(name, extra) {
  const dir = path.join(sandboxHome, "org", "fallback-harness");
  fs.mkdirSync(dir, { recursive: true });
  const lines = [`name: ${name}`, `displayName: ${name}`, "department: fallback-harness", "rank: senior", ...extra, "persona: |", `  You are ${name}, a stand-in employee for the fallback chain harness.`, ""];
  fs.writeFileSync(path.join(dir, `${name}.yaml`), lines.join("\n"));
}

async function patchConfig() {
  const dist = path.join(gatewayRepo, "packages/hundredfold/dist/src");
  const { patchConfigFile } = await import(pathToFileURL(path.join(dist, "shared/config-document.js")).href);
  const { opencodeModels, bins, profiles } = LAYOUT;
  patchConfigFile(path.join(sandboxHome, "config.yaml"), [
    { path: ["engines", "claude", "bin"], value: bins.claude },
    { path: ["engines", "claude", "accounts"], value: { A: { configDir: profiles.A }, B: { configDir: profiles.B } } },
    { path: ["engines", "opencode"], value: { bin: bins.opencode, mode, model: opencodeModels.own } },
    // The default browser MCP server is `npx -y @playwright/mcp@latest`: a registry fetch the harness must not make.
    { path: ["mcp", "browser", "enabled"], value: false },
    { path: ["mcp", "search", "enabled"], value: false },
    { path: ["mcp", "fetch", "enabled"], value: false },
    // Nothing else may serve a turn: a stray codex or grok bin on the host must never be reachable.
    { path: ["engines", "codex", "bin"], value: path.join(sandboxHome, "no-such-codex") },
    { path: ["engines", "grok", "bin"], value: path.join(sandboxHome, "no-such-grok") },
    { path: ["engines", "hermes", "bin"], value: path.join(sandboxHome, "no-such-hermes") },
    // Remote execution: every remoteCwd under the remote home's work directory, and the gateway's own home as the "mount" the
    // host sees it at (the host is this machine, so it is the same directory).
    { path: ["remote"], value: { root: LAYOUT.remote.cwd, mount: sandboxHome } },
  ]);
}

/** The remote host: its own home, the stand-in commands on its PATH, signed-in profiles that have accepted bypass-permissions, and the shim's config. */
function layOutRemoteHost() {
  const { remote } = LAYOUT;
  const hostBin = path.join(remoteHome, "bin");
  const install = path.join(remoteHome, "install");
  for (const dir of [hostBin, path.join(install, "bin"), remote.cwd]) fs.mkdirSync(dir, { recursive: true });
  // `claude` is the fake; `hundredfold` is an install tree around the build under test, laid out as npm lays one out
  // (`bin/hundredfold`, with the MCP entry points at `../src/mcp`), so the host probe finds the version and the entry directory.
  fs.symlinkSync(LAYOUT.bins.claude, path.join(hostBin, "claude"));
  fs.writeFileSync(path.join(install, "bin", "hundredfold"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(gatewayRepo, "packages/hundredfold/dist/bin/hundredfold.js")}" "$@"\n`, { mode: 0o755 });
  fs.symlinkSync(path.join(gatewayRepo, "packages/hundredfold/dist/src"), path.join(install, "src"));
  fs.symlinkSync(path.join(install, "bin", "hundredfold"), path.join(hostBin, "hundredfold"));
  for (const dir of Object.values(remote.profiles)) {
    fakeLogin(dir);
    fs.writeFileSync(path.join(dir, "settings.json"), `${JSON.stringify({ skipDangerousModePermissionPrompt: true })}\n`);
  }
  const shimConfig = path.join(verifyRoot, "ssh-shim.json");
  fs.writeFileSync(shimConfig, `${JSON.stringify({
    home: remoteHome,
    path: `${hostBin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    // What a host's own session has, and nothing of the gateway's: the fakes' files and the network guard.
    env: {
      FAKE_PROVIDER_SCENARIO: process.env.FAKE_PROVIDER_SCENARIO, FAKE_PROVIDER_LEDGER: process.env.FAKE_PROVIDER_LEDGER,
      FAKE_PROVIDER_NET_LOG: process.env.FAKE_PROVIDER_NET_LOG, NODE_OPTIONS: process.env.NODE_OPTIONS,
      HUNDREDFOLD_CLAUDE_USAGE_API: "off", TMPDIR: path.join(verifyRoot, "tmp"),
    },
    // The system-wide Claude policy directories the gateway's profile probe reads, kept inside the remote home (empty there).
    rewrite: [["/etc/claude-code", path.join(remoteHome, "etc", "claude-code")], ["/Library/Application Support/ClaudeCode", path.join(remoteHome, "Library", "ClaudeCode")]],
    log: remote.shimLog,
    refusals: remote.shimRefusals,
  }, null, 2)}\n`);
  // `ssh` first on the instance's PATH (the script puts this directory there): the real ssh is never reached.
  const shim = path.join(verifyRoot, "bin", "ssh");
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(harnessRoot, "scripts/verify-fallback-chains/ssh-shim.mjs")}" --config "${shimConfig}" "$@"\n`, { mode: 0o755 });
  for (const file of [remote.shimLog, remote.shimRefusals]) fs.writeFileSync(file, "");
}

for (const dir of [...Object.values(LAYOUT.profiles), LAYOUT.defaultProfile]) fakeLogin(dir);
layOutRemoteHost();
employee(LAYOUT.employees.onA, ["engine: claude", "model: opus", `claudeConfigDir: ${LAYOUT.profiles.A}`]);
employee(LAYOUT.employees.onDefault, ["engine: claude", "model: opus"]);
employee(LAYOUT.employees.override, ["engine: claude", "model: opus"]);
employee(LAYOUT.employees.onOpencode, ["engine: opencode", `model: ${LAYOUT.opencodeModels.own}`]);
// The remote employee runs as the first remote profile (the account the scenarios declare for it), as `user@host`.
employee(LAYOUT.employees.remote, ["engine: claude", "model: opus", `remoteHost: ${LAYOUT.remote.host}`, `remoteUser: ${LAYOUT.remote.user}`, `remoteCwd: ${LAYOUT.remote.cwd}`, `remoteClaudeConfigDir: ${LAYOUT.remote.profiles.A}`]);
await patchConfig();
process.stdout.write(`${JSON.stringify({ ...LAYOUT, mode })}\n`);
