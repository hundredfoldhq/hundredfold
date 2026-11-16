import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// One process draining the FTS backfill of a shared database file, as every gateway process that opens
// it may. Waits at a file barrier so all workers start draining together.
const [home, registryPath, dbPath, barrierDir, count, span] = process.argv.slice(2);
process.env.HUNDREDFOLD_HOME = home;

const loggerUrl = new URL("../shared/logger.js", pathToFileURL(registryPath).href).href;
const { configureLogger } = await import(loggerUrl);
configureLogger({ stdout: false, file: false });
const registry = await import(pathToFileURL(registryPath).href);
const { default: Database } = await import("better-sqlite3");

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 30000");

fs.writeFileSync(path.join(barrierDir, `ready-${process.pid}`), "");
while (fs.readdirSync(barrierDir).length < Number(count)) {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

let windows = 0;
try {
  while (!registry.relayFtsBackfillStep(db, Number(span))) windows++;
} catch (err) {
  process.stderr.write(`drain failed after ${windows} windows: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
db.close();
if (!process.exitCode) process.stdout.write(JSON.stringify({ windows }));
