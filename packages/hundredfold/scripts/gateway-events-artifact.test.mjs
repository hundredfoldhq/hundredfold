import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gatewayEventsDist = path.resolve(packageRoot, "../gateway-events/dist");
const backupDist = `${gatewayEventsDist}.artifact-test-${process.pid}`;

test("package-local CLI build produces the neutral protocol from a missing dist", () => {
  const hadDist = fs.existsSync(gatewayEventsDist);
  fs.rmSync(backupDist, { recursive: true, force: true });
  if (hadDist) fs.renameSync(gatewayEventsDist, backupDist);

  try {
    const result = spawnSync(process.execPath, ["scripts/build.mjs"], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(fs.existsSync(path.join(gatewayEventsDist, "index.js")));
    assert.ok(fs.existsSync(path.join(gatewayEventsDist, "index.d.ts")));
    // Every module the embedded declaration names has to be embedded beside it,
    // or the published package's types resolve to nothing.
    const embedded = path.resolve(packageRoot, "dist", "src", "shared");
    const declaration = fs.readFileSync(path.join(embedded, "gateway-events.d.ts"), "utf8");
    for (const [, specifier] of declaration.matchAll(/from "\.\/([^"]+)\.js"/g)) {
      assert.ok(fs.existsSync(path.join(embedded, `${specifier}.d.ts`)), `missing embedded ${specifier}.d.ts`);
    }
  } finally {
    fs.rmSync(gatewayEventsDist, { recursive: true, force: true });
    if (hadDist) fs.renameSync(backupDist, gatewayEventsDist);
  }
});

test("embedded gateway protocol runtime matches its exported declarations", async () => {
  const runtimeUrl = pathToFileURL(path.join(packageRoot, "dist", "src", "shared", "gateway-events.js"));
  runtimeUrl.searchParams.set("artifact-test", String(Date.now()));
  const protocol = await import(runtimeUrl.href);

  assert.equal(protocol.GATEWAY_EVENTS.sessionStopped, "session:stopped");
  const frame = { event: "session:stopped", payload: { sessionId: "runtime-consumer" } };
  assert.deepEqual(protocol.decodeGatewayEvent(frame), frame);
  assert.equal(protocol.isGatewayEvent(frame), true);
});

test("no compiled module imports the workspace protocol package by name", () => {
  // `@hundredfold/gateway-events` is a devDependency and is not shipped, so a
  // bare import of it only resolves in a source checkout (through the workspace
  // link) and fails on an installed package. Runtime code reaches the protocol
  // through the embedded `shared/gateway-events.js`, which the build writes.
  const distSrc = path.join(packageRoot, "dist", "src");
  const embedded = path.join(distSrc, "shared", "gateway-events.js");
  assert.ok(fs.existsSync(embedded), "embedded protocol runtime is missing; build first");
  const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']@hundredfold\/gateway-events(?:\/[^"']*)?["']/;
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js") && full !== embedded && pattern.test(fs.readFileSync(full, "utf8"))) {
        offenders.push(path.relative(packageRoot, full));
      }
    }
  };
  walk(distSrc);
  assert.deepEqual(offenders, [], "compiled modules import the unshipped protocol package by name");
});
