import { searchSessionsFiltered } from "../sessions/registry.js";
import {
  notifyManagerVisibility,
  type ManagerVisibilityDetails,
} from "../sessions/callbacks.js";
import { logger } from "../shared/logger.js";
import { reportingParentSessionId } from "../work-items/employee-session-delegation.js";
import type { Employee, Session } from "../shared/types.js";
import { appendWorkItemEvent } from "../work-items/store.js";
import { resolveOrgHierarchy } from "./org-hierarchy.js";

export interface ManagerVisibilityInput {
  roster: Map<string, Employee>;
  employee: string;
  delegatorSession?: Session;
  childSession: Session;
  workItemId: string;
  title: string;
}

export interface ManagerVisibilityFallback {
  workItemId: string;
  manager: string;
  delegator: string | null;
  employee: string;
  childSessionId: string;
  title: string;
}

export interface ManagerVisibilityDeps {
  findManagerSession(manager: string): Session | undefined;
  notifyManager(managerSessionId: string, details: ManagerVisibilityDetails): void;
  appendFallback(fallback: ManagerVisibilityFallback): void;
  warn(message: string): void;
}

/** Passive visibility may join a conversation already in flight, but must not
 * start a new turn on a completed, stopped, or otherwise idle manager thread.
 * A session that reports to another session, whether it was spawned by it or
 * a delegation landed in it, is working a brief it was handed, not managing a
 * team: it knows nothing of this delegation, so the notice would only wake it
 * for a turn that answers "nothing for me", and that answer is relayed to the
 * session it reports to. When the manager's only live sessions report upward,
 * the Todo carries the fallback reference instead. */
export function isEligibleManagerVisibilitySession(session: Session): boolean {
  if (reportingParentSessionId(session)) return false;
  return session.status === "running" || session.status === "waiting";
}

/** The manager's live session that can take the notice, if it has one. */
export function findManagerVisibilitySession(manager: string): Session | undefined {
  return searchSessionsFiltered({ employee: manager }, 20).find(isEligibleManagerVisibilitySession);
}

const defaultDeps: ManagerVisibilityDeps = {
  findManagerSession: findManagerVisibilitySession,
  notifyManager: notifyManagerVisibility,
  appendFallback: (fallback) => {
    appendWorkItemEvent({
      workItemId: fallback.workItemId,
      kind: "note",
      actor: "delegation",
      detail: {
        managerVisibility: {
          manager: fallback.manager,
          delegator: fallback.delegator,
          employee: fallback.employee,
          childSessionId: fallback.childSessionId,
          title: fallback.title,
        },
      },
      versionEffect: "audit",
    });
  },
  warn: (message) => logger.warn(message),
};

/**
 * Surface one skip-level delegation to the target employee's manager without
 * changing the route. Direct-report and same-manager work needs no extra signal.
 * Delivery is deliberately fail-open: visibility must never gate IC dispatch.
 */
export function surfaceManagerVisibility(
  input: ManagerVisibilityInput,
  deps: ManagerVisibilityDeps = defaultDeps,
): void {
  try {
    const hierarchy = resolveOrgHierarchy(input.roster);
    const targetNode = hierarchy.nodes[input.employee];
    const manager = targetNode?.parentName;
    if (!manager) return;

    const delegator = input.delegatorSession?.employee ?? null;
    const delegatorManager = delegator ? hierarchy.nodes[delegator]?.parentName ?? null : null;
    if (delegator === manager || delegatorManager === manager) return;

    const managerEmployee = input.roster.get(manager);
    const targetEmployee = targetNode.employee;
    const delegatorEmployee = delegator ? input.roster.get(delegator) : undefined;
    const details: ManagerVisibilityDetails = {
      manager,
      managerDisplay: managerEmployee?.displayName || manager,
      delegator,
      delegatorDisplay: delegatorEmployee?.displayName || delegator || "The operator",
      employee: input.employee,
      employeeDisplay: targetEmployee.displayName || input.employee,
      childSessionId: input.childSession.id,
      workItemId: input.workItemId,
      title: input.title,
    };

    const managerSession = deps.findManagerSession(manager);
    if (managerSession && isEligibleManagerVisibilitySession(managerSession)) {
      deps.notifyManager(managerSession.id, details);
      return;
    }

    deps.appendFallback({
      workItemId: input.workItemId,
      manager,
      delegator,
      employee: input.employee,
      childSessionId: input.childSession.id,
      title: input.title,
    });
  } catch (error) {
    deps.warn(`Manager visibility failed open: ${error instanceof Error ? error.message : String(error)}`);
  }
}
