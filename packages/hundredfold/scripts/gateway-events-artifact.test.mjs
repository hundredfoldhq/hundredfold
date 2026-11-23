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

test("no compiled runtime module imports the workspace protocol package", () => {
  // @hundredfold/gateway-events is a devDependency: the published package carries it
  // only as the embedded src/shared/gateway-events.js. A runtime import of the package
  // name from any other module fails to load once installed from the tarball.
  const distSrc = path.join(packageRoot, "dist", "src");
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) {
        const source = fs.readFileSync(full, "utf8");
        if (/(?:from|import)\s*\(?\s*["']@hundredfold\/gateway-events["']/.test(source)) {
          offenders.push(path.relative(packageRoot, full));
        }
      }
    }
  };
  walk(distSrc);
  assert.deepEqual(offenders, [], "import these through src/shared/gateway-events.ts instead");
});
