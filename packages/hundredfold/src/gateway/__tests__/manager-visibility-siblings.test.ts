import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Employee } from "../../shared/types.js";

/**
 * One orchestrator delegates to several children. The skip-level notice for a
 * later delegation must reach a session that manages the target, never a
 * sibling child that only shares the manager's employee name.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-visibility-siblings-"));
process.env.HUNDREDFOLD_HOME = tmp;
const reg = await import("../../sessions/registry.js");
const { surfaceManagerVisibility, findManagerVisibilitySession } = await import("../manager-visibility.js");

function employee(name: string, rank: Employee["rank"], reportsTo?: string): Employee {
  return { name, displayName: name, department: "platform", rank, engine: "claude", model: "test-model", persona: name, reportsTo } as Employee;
}

const roster = new Map<string, Employee>([
  ["lead", employee("lead", "manager")],
  ["builder", employee("builder", "senior", "lead")],
  ["reviewer", employee("reviewer", "senior", "builder")],
  ["analyst", employee("analyst", "senior", "builder")],
]);

function spawn(employeeName: string, parentSessionId?: string) {
  const s = reg.createSession({ engine: "claude", source: "web", sourceRef: `web:${Math.random()}`, employee: employeeName, parentSessionId });
  reg.updateSession(s.id, { status: "running" } as never);
  return reg.getSession(s.id)!;
}

beforeEach(async () => {
  const db = (await import("../../shared/db.js")).initDb();
  db.exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
});

describe("manager visibility with an orchestrator and its children", () => {
  it("sends nothing to a running sibling child that shares the manager's employee", () => {
    const orchestrator = spawn("lead");
    const child1 = spawn("builder", orchestrator.id);
    const child2 = spawn("reviewer", orchestrator.id);
    const child3 = spawn("analyst", orchestrator.id);
    const notifyManager = vi.fn();
    const appendFallback = vi.fn();
    const deps = { findManagerSession: findManagerVisibilitySession, notifyManager, appendFallback, warn: vi.fn() };

    // Delegating children 2 and 3: their manager (builder) has child 1 running.
    for (const [child, name] of [[child2, "reviewer"], [child3, "analyst"]] as const) {
      surfaceManagerVisibility(
        { roster, employee: name, delegatorSession: orchestrator, childSession: child, workItemId: `wi_${name}`, title: "Work" },
        deps,
      );
    }

    expect(notifyManager).not.toHaveBeenCalled();
    expect(notifyManager.mock.calls.some(([id]) => id === child1.id)).toBe(false);
    // The notice is not lost: each delegation leaves its fallback reference on the Todo.
    expect(appendFallback).toHaveBeenCalledTimes(2);
  });

  it("still reaches a top-level session of the manager, passing over its child sessions", () => {
    const orchestrator = spawn("lead");
    const child1 = spawn("builder", orchestrator.id);
    const topLevelManager = spawn("builder");
    const child2 = spawn("reviewer", orchestrator.id);
    const notifyManager = vi.fn();
    const deps = { findManagerSession: findManagerVisibilitySession, notifyManager, appendFallback: vi.fn(), warn: vi.fn() };

    surfaceManagerVisibility(
      { roster, employee: "reviewer", delegatorSession: orchestrator, childSession: child2, workItemId: "wi_r", title: "Work" },
      deps,
    );

    expect(notifyManager).toHaveBeenCalledOnce();
    expect(notifyManager.mock.calls[0][0]).toBe(topLevelManager.id);
    expect(notifyManager.mock.calls[0][0]).not.toBe(child1.id);
  });
});
