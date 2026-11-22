import type { WorkItemStatus } from './store.js';

/** Declared edges: from → the set of legal targets (design §1.1's diagram).
 *  They govern every caller; the agent lane is the narrower set of pairs below
 *  (`isAgentLaneMove`), which the status route checks first. */
export const EDGES: Readonly<Record<WorkItemStatus, ReadonlySet<WorkItemStatus>>> = {
  // `done` from backlog covers trivially-completed work — rare, but refusing it
  // would strand a truthful terminal.
  backlog: new Set(['executing', 'in_review', 'blocked', 'done', 'cancelled']),
  // `backlog` here is "not now": work picked up too early goes back down.
  executing: new Set(['backlog', 'in_review', 'blocked', 'done', 'cancelled']),
  in_review: new Set(['executing', 'done', 'blocked', 'cancelled']),
  blocked: new Set(['backlog', 'executing', 'in_review', 'done', 'cancelled']),
  // Sticky terminals: leaving them is HUMAN-ONLY (enforced in transitions.ts, not by
  // edge absence). The operator reopens closed work to `backlog` (start over) or
  // straight to `in_review` (it was closed too soon: look at it again). Nothing
  // else is a reopen: `executing` is a start that dispatches an agent, which the
  // review bounce (`in_review → executing`) already covers one move later, and
  // `blocked` would stop work that is not running.
  done: new Set(['backlog', 'in_review']),
  cancelled: new Set(['backlog', 'in_review']),
};

/** The rule a refused move broke, in words: what `transition()` puts in the
 *  `illegal-edge` error so the caller learns which rule said no, not only that
 *  one did. A manual move into `executing` is refused earlier than the edge
 *  check but only ever from a status whose edges lack it (a closed Todo), so
 *  the declared exits are the whole answer. */
export function illegalEdgeRule(from: WorkItemStatus, to: WorkItemStatus): string {
  const exits = [...EDGES[from]].join(', ');
  const closed = from === 'done' || from === 'cancelled' ? ` (a closed Todo reopens to ${exits}${to === 'executing' ? '; send it back from in_review once it is open' : ''})` : '';
  return `the declared edges from ${from} are ${exits}${closed}`;
}

/** The statuses an agent session works in. Closing (`done`, `cancelled`) and
 *  reopening closed work are the operator's. */
const AGENT_OPEN: readonly WorkItemStatus[] = ['backlog', 'executing', 'in_review'];

/** The agent lane: pick work up or put it down (backlog ↔ executing), hand it
 *  to review and take it back (executing ↔ in_review), and stop or resume any
 *  open Todo (open ↔ blocked), plus staying put. Every pair is also a declared
 *  edge. */
const AGENT_LANE: ReadonlySet<string> = new Set([
  'backlog>executing', 'executing>backlog', 'executing>in_review', 'in_review>executing',
  ...AGENT_OPEN.flatMap((open) => [`${open}>blocked`, `blocked>${open}`, `${open}>${open}`]),
  'blocked>blocked',
]);

export function isAgentLaneMove(from: WorkItemStatus, to: WorkItemStatus): boolean {
  return AGENT_LANE.has(`${from}>${to}`);
}
