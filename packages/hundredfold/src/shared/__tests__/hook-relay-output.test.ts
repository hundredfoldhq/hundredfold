import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NAMES } from "../codename.js";
import { readHostAsset } from "../host-assets.js";

/**
 * The hook relay is a standalone script Claude Code runs for each hook. What a
 * SessionStart hook prints goes back into the conversation, which is how a
 * session whose conversation was just compacted is given its reminder back, so
 * this runs the real script against a stand-in gateway.
 */

const RELAY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "assets", "hook-relay.mjs");
const HOME_VAR = `${NAMES.codename.toUpperCase()}_HOME`;

let dir: string;
let server: http.Server;
let reply: { status: number; body: unknown };
let posted: Array<{ url: string; secret: string | string[] | undefined; body: any }>;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-output-"));
  fs.writeFileSync(path.join(dir, "relay.mjs"), readHostAsset(RELAY));
  posted = [];
  reply = { status: 200, body: { message: "ok" } };
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      posted.push({ url: req.url ?? "", secret: req.headers[`x-${NAMES.codename}-hook-secret`], body: JSON.parse(raw) });
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  fs.writeFileSync(path.join(dir, "gateway.json"), JSON.stringify({ port, secret: "s3cret" }));
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

function runRelay(hook: Record<string, unknown>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [path.join(dir, "relay.mjs"), "sess-1"], { env: { PATH: process.env.PATH, [HOME_VAR]: dir } }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
    child.stdin!.end(JSON.stringify(hook));
  });
}

const OUTPUT = { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "[Gateway reminder] Board: one." } };

describe("hook relay output", () => {
  it("prints the output the gateway's reply carries, for Claude Code to add to the conversation", async () => {
    reply = { status: 200, body: { message: "ok", hookOutput: OUTPUT } };
    const result = await runRelay({ hook_event_name: "SessionStart", source: "compact", session_id: "c1" });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(OUTPUT);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toBe("/api/internal/hook");
    expect(posted[0]!.secret).toBe("s3cret");
  });

  it("prints nothing when the reply has no output, as for every other hook", async () => {
    const result = await runRelay({ hook_event_name: "Stop" });
    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it.each([
    ["a reply that is not JSON", { status: 200, body: "ok" }],
    ["a failed reply", { status: 500, body: { hookOutput: OUTPUT } }],
    ["an output that is not an object", { status: 200, body: { hookOutput: "text" } }],
  ])("prints nothing and still exits 0 on %s", async (_name, next) => {
    reply = next;
    const result = await runRelay({ hook_event_name: "SessionStart", source: "compact" });
    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("still refuses a blocked command with the policy text on stderr and exit 2", async () => {
    reply = { status: 451, body: "Blocked by policy" };
    const result = await runRelay({ hook_event_name: "PreToolUse", tool_name: "Bash" });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Blocked by policy");
    expect(result.stdout).toBe("");
  });
});
