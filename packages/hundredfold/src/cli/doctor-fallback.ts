import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { duplicateProblemsByChain, groupCount, groupProblemsByChain } from "../shared/fallback-chain-load.js";
import type { DoctorFinding } from "./doctor.js";

/**
 * Fallback chains in `config.yaml` that repeat a target, and balanced account groups
 * that are malformed. A repeat still loads (the chain tries each target once), so it is
 * no failure, but it is reported here and by `GET /api/fallback-chains` because a write
 * refuses it. A malformed group does not load, so it is reported with what to change.
 * Read-only, like the rest of `doctor`.
 */
export function fallbackChainFindings(home: string): DoctorFinding[] {
  let engines: unknown;
  try {
    engines = (yaml.load(fs.readFileSync(path.join(home, "config.yaml"), "utf-8")) as { engines?: unknown } | null)?.engines;
  } catch {
    return [];
  }
  const repeats = Object.values(duplicateProblemsByChain(engines)).flat();
  const repeatFindings: DoctorFinding[] = repeats.length === 0
    ? [{ level: "ok", message: "No fallback chain in config.yaml repeats a target." }]
    : repeats.map((problem) => ({ level: "problem", message: `${problem}. It loads (the repeat is ignored); remove it, because saving this chain is refused.` }));
  return [...repeatFindings, ...groupFindings(engines)];
}

/** One finding per group problem, or one ok line when the config holds groups and none is wrong. Nothing when it holds none. */
function groupFindings(engines: unknown): DoctorFinding[] {
  const problems = Object.values(groupProblemsByChain(engines)).flat();
  if (problems.length > 0) return problems.map((problem) => ({ level: "problem", message: `${problem}. A config with this group does not load; fix it in config.yaml.` }));
  const count = groupCount(engines);
  return count === 0 ? [] : [{ level: "ok", message: `config.yaml holds ${count} balanced account group${count === 1 ? "" : "s"}, and none has a problem.` }];
}
