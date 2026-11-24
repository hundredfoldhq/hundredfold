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
const store = await import("../../work-items/store.js");
const { swapEmployeeSession } = await import("../../work-items/employee-sessions.js");
const { recordLandedBrief, startBriefTurn } = await import("../../work-items/employee-session-delegation.js");
const { noticeTargetSessionId } = await import("../../sessions/turn-requester.js");

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

  it("passes over a top-level session that a delegation landed in, which now reports to the delegator", () => {
    const orchestrator = spawn("lead");
    const todo = store.createWorkItem({ title: "reused" });
    const reused = spawn("builder");
    store.linkSession(todo.id, reused.id);
    expect(swapEmployeeSession(todo.id, "builder", null, reused.id)).toBe(true);
    recordLandedBrief({ briefKey: "brief-1", workItemId: todo.id, employee: "builder", sessionId: reused.id, delegatorSessionId: orchestrator.id });
    startBriefTurn(reused.id, ["brief-1"]);
    const child2 = spawn("reviewer", orchestrator.id);
    const notifyManager = vi.fn();
    const appendFallback = vi.fn();
    const deps = { findManagerSession: findManagerVisibilitySession, notifyManager, appendFallback, warn: vi.fn() };

    // The session's own row has no parent, yet its replies go to the orchestrator.
    expect(reg.getSession(reused.id)!.parentSessionId ?? null).toBeNull();
    surfaceManagerVisibility(
      { roster, employee: "reviewer", delegatorSession: orchestrator, childSession: child2, workItemId: "wi_r", title: "Work" },
      deps,
    );

    expect(notifyManager).not.toHaveBeenCalled();
    expect(appendFallback).toHaveBeenCalledOnce();
  });

  it("passes over a session with a brief waiting to start, whose turns will report to the delegator", () => {
    const orchestrator = spawn("lead");
    const todo = store.createWorkItem({ title: "queued" });
    const reused = spawn("builder");
    store.linkSession(todo.id, reused.id);
    expect(swapEmployeeSession(todo.id, "builder", null, reused.id)).toBe(true);
    // The brief landed behind the session's current turn and has not started.
    recordLandedBrief({ briefKey: "brief-waiting", workItemId: todo.id, employee: "builder", sessionId: reused.id, delegatorSessionId: orchestrator.id });
    const child2 = spawn("reviewer", orchestrator.id);
    const notifyManager = vi.fn();
    const appendFallback = vi.fn();
    const deps = { findManagerSession: findManagerVisibilitySession, notifyManager, appendFallback, warn: vi.fn() };

    // Nothing reports upward yet, so a check on the hop alone would pick it.
    expect(noticeTargetSessionId(reg.getSession(reused.id)!)).toBeNull();
    surfaceManagerVisibility(
      { roster, employee: "reviewer", delegatorSession: orchestrator, childSession: child2, workItemId: "wi_r", title: "Work" },
      deps,
    );

    expect(notifyManager).not.toHaveBeenCalled();
    expect(appendFallback).toHaveBeenCalledOnce();
    // A notice queued now would run after the brief, and its reply would reach the orchestrator.
    startBriefTurn(reused.id, ["brief-waiting"]);
    expect(noticeTargetSessionId(reg.getSession(reused.id)!)).toBe(orchestrator.id);
  });

  it("still reaches a manager session the operator delegated into, whose replies go to no session", () => {
    const orchestrator = spawn("lead");
    const started = store.createWorkItem({ title: "operator started" });
    const waiting = store.createWorkItem({ title: "operator waiting" });
    const managerSession = spawn("builder");
    store.linkSession(started.id, managerSession.id);
    store.linkSession(waiting.id, managerSession.id);
    expect(swapEmployeeSession(started.id, "builder", null, managerSession.id)).toBe(true);
    expect(swapEmployeeSession(waiting.id, "builder", null, managerSession.id)).toBe(true);
    recordLandedBrief({ briefKey: "op-started", workItemId: started.id, employee: "builder", sessionId: managerSession.id, delegatorSessionId: null });
    startBriefTurn(managerSession.id, ["op-started"]);
    recordLandedBrief({ briefKey: "op-waiting", workItemId: waiting.id, employee: "builder", sessionId: managerSession.id, delegatorSessionId: null });
    const child2 = spawn("reviewer", orchestrator.id);
    const notifyManager = vi.fn();
    const deps = { findManagerSession: findManagerVisibilitySession, notifyManager, appendFallback: vi.fn(), warn: vi.fn() };

    surfaceManagerVisibility(
      { roster, employee: "reviewer", delegatorSession: orchestrator, childSession: child2, workItemId: "wi_r", title: "Work" },
      deps,
    );

    expect(notifyManager).toHaveBeenCalledOnce();
    expect(notifyManager.mock.calls[0][0]).toBe(managerSession.id);
    startBriefTurn(managerSession.id, ["op-waiting"]);
    expect(noticeTargetSessionId(reg.getSession(managerSession.id)!)).toBeNull();
  });
});
