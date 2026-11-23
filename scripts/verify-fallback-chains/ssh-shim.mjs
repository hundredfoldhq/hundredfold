#!/usr/bin/env node
// A stand-in `ssh` for scripts/verify-fallback-chains.sh, installed as `ssh` first on the throwaway instance's PATH.
// A remote employee's `remote` target is `user@127.0.0.1`; this answers it without a network, a daemon or any key:
//
//   ssh [-T|-tt] [-o K=V]... [-R port:127.0.0.1:port] [-L ...] -- user@127.0.0.1 <remote command words>
//
// runs the command words in a local `sh -c`, as sshd would for the remote user's shell, with exactly the environment a
// host's non-interactive session has: a temporary "host home" as HOME (never the caller's), a PATH that starts at the
// harness's host bin (the fake `claude` and a `hundredfold` linked to the build under test), the fake providers' scenario
// and ledger files, and the network guard preloaded. Nothing of the gateway's own environment is passed on, as with ssh.
// A `-R` reverse tunnel is a loopback forwarder from the tunnel port to the gateway port for as long as the command runs.
//
// What it will never do: run the real `ssh`, reach any destination that is not loopback, or run with a HOME it was not
// configured with. A call it does not understand exits 255 and is written to the refusal log, which the scenarios assert
// is empty. Every call is logged (without its command, which can carry a secret) so the scenarios can see the shim was used.
//
//   ssh-shim.mjs --config <file> [ssh arguments]
//
// The config file (written by seed.mjs) names: home, path, env (extra variables), rewrite ([from, to] path pairs), log, refusals.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";

const argv = process.argv.slice(2);
if (argv[0] !== "--config" || !argv[1]) {
  process.stderr.write("ssh-shim: --config <file> is required\n");
  process.exit(255);
}
const config = JSON.parse(fs.readFileSync(argv[1], "utf8"));
const args = argv.slice(2);

const append = (file, row) => {
  try { fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...row })}\n`); } catch { /* a log that cannot be written must not hide the refusal below */ }
};
const refuse = (reason) => {
  append(config.refusals, { reason, args: args.filter((arg) => !/\s/.test(arg)).slice(0, 12) });
  process.stderr.write(`ssh-shim: ${reason}\n`);
  process.exit(255);
};

const GATEWAY_OPTIONS = /^(BatchMode|ConnectTimeout|EscapeChar|ExitOnForwardFailure|LogLevel|ServerAliveCountMax|ServerAliveInterval)=[A-Za-z0-9_.-]+$/;
// ssh's own option grammar, for the flags the gateway uses: -T/-tt, -o K=V, -R/-L spec, then `--`, the destination, the command words.
const reverse = [];
let tty = false;
let index = 0;
for (; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--") { index += 1; break; }
  if (arg === "-T") continue;
  if (arg === "-tt" || arg === "-t") { tty = true; continue; }
  if (arg === "-o") {
    const option = args[index + 1] ?? "";
    if (!GATEWAY_OPTIONS.test(option)) refuse(`unsupported ssh -o option ${option.split("=")[0]}`);
    index += 1; continue;
  }
  if (arg === "-R") { reverse.push(args[index + 1] ?? ""); index += 1; continue; }
  if (arg === "-L") { index += 1; continue; }
  refuse(`unsupported ssh option ${arg}`);
}
const destination = args[index];
const words = args.slice(index + 1);
if (!destination || words.length === 0) refuse("no destination or no command");
if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*@127\.0\.0\.1$/.test(destination)) refuse(`${destination} is not user@127.0.0.1: the shim reaches nothing else`);
// The host's own system directories are inside its home: a command that names one (the gateway's profile probe reads the
// system-wide Claude policy directories) is pointed at the temporary copy, so nothing outside the verification root is read.
const original = words.join(" ");
const command = (config.rewrite ?? []).reduce((text, [from, to]) => text.split(from).join(to), original);
const rewroteTo = (config.rewrite ?? []).filter(([from]) => original.includes(from)).map(([, to]) => to);
append(config.log, { destination, tty, reverse, commandLength: command.length, rewrote: command !== original, rewroteTo });

/** `-R port:127.0.0.1:port`: a listener on the tunnel port that pipes each connection to the gateway's port, both loopback. */
const servers = reverse.map((spec) => {
  const match = /^(\d+):127\.0\.0\.1:(\d+)$/.exec(spec);
  if (!match) return refuse(`unsupported reverse tunnel ${spec}`);
  const [, tunnelPort, gatewayPort] = match;
  const server = net.createServer((client) => {
    const upstream = net.connect({ host: "127.0.0.1", port: Number(gatewayPort) });
    client.pipe(upstream).pipe(client);
    const close = () => { client.destroy(); upstream.destroy(); };
    client.on("error", close); upstream.on("error", close); client.on("close", close); upstream.on("close", close);
  });
  server.on("error", (error) => refuse(`reverse tunnel ${spec}: ${error.message}`));
  server.listen(Number(tunnelPort), "127.0.0.1");
  return server;
});

const child = spawn("/bin/sh", ["-c", command], {
  stdio: "inherit",
  env: { HOME: config.home, PATH: config.path, LANG: "C.UTF-8", TERM: process.env.TERM ?? "dumb", ...config.env },
});
for (const signal of /** @type {NodeJS.Signals[]} */ (["SIGTERM", "SIGHUP", "SIGINT"])) process.on(signal, () => { try { child.kill(signal); } catch { /* already gone */ } });
child.on("error", (error) => refuse(`could not run the command: ${error.message}`));
child.on("close", (code, signal) => {
  for (const server of servers) server.close();
  process.exit(code ?? (signal ? 128 : 1));
});
