import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { compareSemver } from "./version.js";

/**
 * Whether a Claude Code install knows the `PostToolUseFailure` hook event. A tool that fails (a Bash
 * that exits non-zero, say) fires that event and no `PostToolUse`, so the engine registers it to see
 * a tracked call end. It must not be registered on a build that does not know it: Claude Code
 * 2.1.330 answers an unknown hook event in `--settings` with an interactive "Settings Warning"
 * dialog (Continue / Exit) before it starts, and an unattended PTY would sit in front of it forever.
 *
 * Judged, like the `claudeMdExcludes` check, by what `claude --version` reports, so a shim or
 * wrapper answers for the build it runs.
 */

/** The oldest Claude Code verified to know the event: its changelog documents the event's input from this version. An older build may know it too, but is not assumed to. */
export const TOOL_FAILURE_HOOK_MIN_VERSION = "2.1.119";

/** Whether `versionOutput`, what `claude --version` printed ("2.1.330 (Claude Code)"), names a build that knows the event. */
export function toolFailureHookSupported(versionOutput: string): boolean {
  const version = /\d+\.\d+\.\d+/.exec(versionOutput)?.[0];
  return version !== undefined && compareSemver(version, TOOL_FAILURE_HOOK_MIN_VERSION) >= 0;
}

/** What was found per binary, by path, size and modification time, so an upgrade is noticed. Asked once: a failed run answers false. */
const answers = new Map<string, boolean>();

/** The local check: run `bin --version` once per binary. False when it cannot be run or reports an older build. */
export function localClaudeKnowsToolFailureHook(bin: string): boolean {
  let key = bin;
  try {
    const real = fs.realpathSync(bin);
    const stat = fs.statSync(real);
    key = `${real}\0${stat.size}\0${stat.mtimeMs}`;
  } catch {
    // Not a path we can see (a bare name, say): remembered under the name.
  }
  const known = answers.get(key);
  if (known !== undefined) return known;
  let output = "";
  try {
    output = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    output = "";
  }
  const supported = toolFailureHookSupported(output);
  answers.set(key, supported);
  return supported;
}

export function clearToolFailureHookCacheForTests(): void {
  answers.clear();
}
