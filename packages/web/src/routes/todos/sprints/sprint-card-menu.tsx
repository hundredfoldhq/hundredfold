import { ContextMenuItem, ContextMenuLabel, ContextMenuSeparator } from "@/components/ui/context-menu"
import type { WorkItemCompactWire } from "@/lib/api"
import type { SprintWire } from "@/lib/sprint-api"
import { MenuCheck } from "../filter-chips"
import { keptByClosedSprint } from "./use-sprints"

/* The sprint part of a board card's right-click menu: move the Todo into a
 * sprint, between sprints, or out of one, card by card, without opening each
 * Todo. The menu itself, and the status moves beside this, are the board's
 * (board/card-menu.tsx); this is only the rows. The board shows top-level
 * Todos only, so every card here is one the gateway lets move. */

export const MENU_ITEM_CLASS =
  "min-h-9 cursor-pointer gap-2 rounded-[9px] px-2.5 text-[length:var(--text-subheadline)] text-[var(--text-primary)] focus:bg-[var(--fill-tertiary)]"
export const MENU_LABEL_CLASS =
  "px-2.5 pb-1 pt-1.5 text-[length:var(--text-caption1)] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]"

/** What the board hands its card menu to offer sprints: the open sprints a card may move to (closed ones are history), and the move. */
export interface CardSprints {
  sprints: SprintWire[]
  move: (item: WorkItemCompactWire, sprint: string | null) => void
}

export function SprintCardItems({ item, sprints, onMove }: {
  item: WorkItemCompactWire
  sprints: SprintWire[]
  onMove: (sprint: string | null) => void
}) {
  const current = item.sprint?.id ?? null
  const kept = keptByClosedSprint(item.status, item.sprint)
  const moveTo = (sprint: string | null) => {
    if (sprint !== current) onMove(sprint)
  }
  return (
    <>
      <ContextMenuLabel className={MENU_LABEL_CLASS}>Sprint</ContextMenuLabel>
      {kept && (
        <ContextMenuLabel
          data-testid="sprint-card-kept"
          className="max-w-[240px] px-2.5 pb-1.5 pt-0 text-[length:var(--text-caption1)] font-normal text-[var(--text-tertiary)]"
        >
          {item.status === "done" ? "Done" : "Cancelled"} in closed sprint {item.sprint?.name}, which keeps it as its record.
        </ContextMenuLabel>
      )}
      {sprints.map((sprint) => (
        <ContextMenuItem key={sprint.id} className={MENU_ITEM_CLASS} disabled={kept} data-testid={`sprint-card-move-${sprint.id}`} onSelect={() => moveTo(sprint.id)}>
          <span className="min-w-0 truncate">{sprint.name}</span>
          <span className="text-[11px] text-[var(--text-quaternary)]">{sprint.status}</span>
          <MenuCheck on={current === sprint.id} />
        </ContextMenuItem>
      ))}
      {sprints.length > 0 && <ContextMenuSeparator />}
      <ContextMenuItem className={MENU_ITEM_CLASS} disabled={kept} data-testid="sprint-card-move-none" onSelect={() => moveTo(null)}>
        No sprint
        <MenuCheck on={current === null} />
      </ContextMenuItem>
    </>
  )
}
