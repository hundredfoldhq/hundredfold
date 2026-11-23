import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doctorFindings } from "../doctor.js";

/** `doctor` says when a config.yaml fallback chain repeats a target, which still loads but cannot be saved. */

let home: string;

beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-fallback-")); });
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const write = (fallback: unknown[]) => fs.writeFileSync(path.join(home, "config.yaml"), yaml.dump({ engines: { claude: { bin: "claude", model: "opus", fallback } } }));
const run = () => doctorFindings({ home, env: {}, instances: [] });

describe("doctor: fallback chains", () => {
  it("names a repeated target, in either form, and says it still loads", () => {
    for (const chain of [["codex", "codex"], [{ engine: "codex", model: "m" }, { engine: "codex", model: "m" }]]) {
      write(chain);
      const line = run().find((finding) => finding.message.includes("duplicates"));
      expect(line?.level).toBe("problem");
      expect(line?.message).toContain("engines.claude.fallback[1] duplicates engines.claude.fallback[0]");
      expect(line?.message).toContain("It loads (the repeat is ignored)");
    }
  });

  it("is quiet about a clean chain, a missing config and an unreadable one", () => {
    write(["codex", "grok"]);
    expect(run().some((finding) => finding.message === "No fallback chain in config.yaml repeats a target.")).toBe(true);
    fs.rmSync(path.join(home, "config.yaml"));
    expect(run().some((finding) => finding.message.includes("fallback chain"))).toBe(false);
    fs.writeFileSync(path.join(home, "config.yaml"), "engines: [unclosed");
    expect(run().some((finding) => finding.level === "problem")).toBe(false);
  });
});

describe("doctor: opencode account groups", () => {
  const writeOpencode = (opencode: Record<string, unknown>, claudeFallback?: unknown[]) => fs.writeFileSync(path.join(home, "config.yaml"), yaml.dump({
    engines: {
      claude: { bin: "claude", model: "opus", ...(claudeFallback ? { fallback: claudeFallback } : {}) },
      opencode: { bin: "opencode", model: "opencode-go/glm-5", accounts: { "go-a": { provider: "opencode-go" }, "go-b": { provider: "opencode-go-b", base: "opencode-go", keyEnv: "GO_B_KEY" } }, ...opencode },
    },
  }));
  const GO = (profile: string) => ({ engine: "opencode", profile });
  const problems = () => run().filter((finding) => finding.level === "problem").map((finding) => finding.message);

  it("counts a valid group in engines.opencode.fallback and has no problem", () => {
    writeOpencode({ fallback: [{ group: [GO("go-a"), GO("go-b")] }] });
    const found = run();
    expect(found.some((finding) => finding.message.includes("holds 1 balanced account group, and none has a problem"))).toBe(true);
    expect(problems()).toEqual([]);
  });

  it("prints the new sentences for a mixed group, a member with no profile and an opencode group in a Claude chain", () => {
    writeOpencode({ fallback: [{ group: [GO("go-a"), { engine: "claude" }] }, { group: [GO("go-a"), { engine: "opencode" }] }] });
    expect(problems().join("\n")).toContain("engines.opencode.fallback[0].group: a group's members all run on one engine. A config with this problem does not load");
    expect(problems().join("\n")).toContain("engines.opencode.fallback[1].group[1]: an opencode group member names its account with profile");
    writeOpencode({}, [{ group: [GO("go-a"), GO("go-b")] }]);
    expect(problems().join("\n")).toContain("engines.claude.fallback[0].group: an opencode group balances an opencode session's own model; put it in an opencode employee's chain or engines.opencode.fallback");
  });
});

