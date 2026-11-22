import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeClaudeSessionSettings } from "../claude-profile-launch.js";
import { clearToolFailureHookCacheForTests } from "../../shared/claude-tool-failure-hook.js";

/**
 * The per-session settings of a local Claude session register PostToolUseFailure only for a Claude Code
 * that knows the event: an older one answers an unknown hook event with a dialog that stops an unattended
 * PTY at startup. A remote session passes no local binary and never registers it.
 */
describe("the settings file a local session writes", () => {
  let dir: string;
  beforeEach(() => {
    clearToolFailureHookCacheForTests();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-settings-failure-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function fakeClaude(name: string, version: string): string {
    const bin = path.join(dir, name);
    fs.writeFileSync(bin, `#!/bin/sh\necho '${version} (Claude Code)'\n`, { mode: 0o755 });
    return bin;
  }
  function hooksWritten(id: string, localBin?: string): Record<string, unknown> {
    const file = writeClaudeSessionSettings(id, undefined, localBin);
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")).hooks;
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  it("registers it for a build that knows the event", () => {
    expect(hooksWritten("sfh-new", fakeClaude("new", "2.1.330"))).toHaveProperty("PostToolUseFailure");
  });

  it("leaves it out for an older build, one that cannot be run, and a remote session", () => {
    expect(hooksWritten("sfh-old", fakeClaude("old", "2.0.40"))).not.toHaveProperty("PostToolUseFailure");
    expect(hooksWritten("sfh-missing", path.join(dir, "missing"))).not.toHaveProperty("PostToolUseFailure");
    expect(hooksWritten("sfh-remote")).not.toHaveProperty("PostToolUseFailure");
  });

  it("keeps every other hook either way", () => {
    const withIt = hooksWritten("sfh-a", fakeClaude("a", "2.1.330"));
    const without = hooksWritten("sfh-b");
    const { PostToolUseFailure: _ignored, ...rest } = withIt;
    expect(Object.keys(rest).sort()).toEqual(Object.keys(without).sort());
  });
});
