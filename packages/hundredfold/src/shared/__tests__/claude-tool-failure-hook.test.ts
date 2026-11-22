import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearToolFailureHookCacheForTests, localClaudeKnowsToolFailureHook, TOOL_FAILURE_HOOK_MIN_VERSION, toolFailureHookSupported } from "../claude-tool-failure-hook.js";

describe("toolFailureHookSupported", () => {
  it("accepts a build at or past the oldest verified version", () => {
    expect(toolFailureHookSupported(`${TOOL_FAILURE_HOOK_MIN_VERSION} (Claude Code)`)).toBe(true);
    expect(toolFailureHookSupported("2.1.330 (Claude Code)\n")).toBe(true);
    expect(toolFailureHookSupported("3.0.0")).toBe(true);
  });

  it("refuses an older build, and output with no version in it", () => {
    expect(toolFailureHookSupported("2.1.118 (Claude Code)")).toBe(false);
    expect(toolFailureHookSupported("2.0.43")).toBe(false);
    expect(toolFailureHookSupported("")).toBe(false);
    expect(toolFailureHookSupported("command not found")).toBe(false);
  });
});

describe("localClaudeKnowsToolFailureHook", () => {
  let dir: string;
  beforeEach(() => {
    clearToolFailureHookCacheForTests();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-failure-hook-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** A stand-in claude that prints `version` and counts how often it was asked. */
  function fakeClaude(name: string, version: string): { bin: string; asked: () => number } {
    const bin = path.join(dir, name);
    const log = path.join(dir, `${name}.log`);
    fs.writeFileSync(bin, `#!/bin/sh\necho ask >> '${log}'\necho '${version} (Claude Code)'\n`, { mode: 0o755 });
    return { bin, asked: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").length : 0) };
  }

  it("runs `--version` once per binary and keeps the answer", () => {
    const { bin, asked } = fakeClaude("new-claude", "2.1.330");
    expect(localClaudeKnowsToolFailureHook(bin)).toBe(true);
    expect(localClaudeKnowsToolFailureHook(bin)).toBe(true);
    expect(asked()).toBe(1);
  });

  it("answers false for an old build, and for a binary that cannot be run", () => {
    expect(localClaudeKnowsToolFailureHook(fakeClaude("old-claude", "2.0.40").bin)).toBe(false);
    expect(localClaudeKnowsToolFailureHook(path.join(dir, "missing-claude"))).toBe(false);
  });

  it("holds a failed run against nobody: a probe that failed once passes the next time on the same binary", () => {
    const bin = path.join(dir, "flaky-claude");
    const flag = path.join(dir, "ready");
    const log = path.join(dir, "flaky.log");
    fs.writeFileSync(bin, `#!/bin/sh\necho ask >> '${log}'\n[ -e '${flag}' ] || exit 1\necho '2.1.330 (Claude Code)'\n`, { mode: 0o755 });
    expect(localClaudeKnowsToolFailureHook(bin)).toBe(false);
    fs.writeFileSync(flag, "");
    expect(localClaudeKnowsToolFailureHook(bin)).toBe(true);
    // The pass is kept: no third run.
    expect(localClaudeKnowsToolFailureHook(bin)).toBe(true);
    expect(fs.readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("does not keep the answer for a build that is too old either: an upgrade at the same path is seen", () => {
    const bin = path.join(dir, "shim-claude");
    fs.writeFileSync(bin, `#!/bin/sh\necho '2.0.40 (Claude Code)'\n`, { mode: 0o755 });
    expect(localClaudeKnowsToolFailureHook(bin)).toBe(false);
    // Same size and, within the clock's grain, possibly the same mtime: the old build was never remembered.
    fs.writeFileSync(bin, `#!/bin/sh\necho '2.1.330 (Claude Code)'\n`, { mode: 0o755 });
    expect(localClaudeKnowsToolFailureHook(bin)).toBe(true);
  });

  it("asks again when the binary at the same path was replaced", () => {
    const first = fakeClaude("claude", "2.0.40");
    expect(localClaudeKnowsToolFailureHook(first.bin)).toBe(false);
    // An upgrade in place: a different size, so a different key.
    fs.writeFileSync(first.bin, `#!/bin/sh\necho '2.1.330 (Claude Code)' # upgraded build\n`, { mode: 0o755 });
    expect(localClaudeKnowsToolFailureHook(first.bin)).toBe(true);
  });
});
