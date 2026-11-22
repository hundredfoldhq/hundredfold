import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findPython } from "../sidecar/bootstrap.js";

/** Runs the sidecar's Python unit tests (framing, VAD endpointing, dispatch and cancellation, models stubbed) under the suite, where a Python 3.10+ exists. */
const python = findPython();
const here = path.dirname(fileURLToPath(import.meta.url));

describe("speech_sidecar.py unit tests", () => {
  it.skipIf(!python)("pass under python -m unittest", () => {
    const run = spawnSync(python!.command, ["-m", "unittest", "discover", "-s", here, "-p", "test_*.py"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
    expect(run.stderr + run.stdout).toMatch(/Ran \d+ tests?/);
    expect(run.status, run.stderr).toBe(0);
  });
});
