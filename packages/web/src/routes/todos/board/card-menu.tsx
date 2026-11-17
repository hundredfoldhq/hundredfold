import { useCallback, useRef, useState } from "react"
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  PointMenu,
  type MenuPoint,
} from "@/components/ui/context-menu"
import type { WorkItemCompactWire, WorkItemStatusWire } from "@/lib/api"
import { STATUS_LABEL } from "@/lib/todos"
import { MENU_ITEM_CLASS, MENU_LABEL_CLASS, SprintCardItems, type CardSprints } from "../sprints/sprint-card-menu"
import { StatusCircle } from "../state-glyph"
import { moveRows } from "./move-menu"

/* Right-click a board card for the actions the board has, without dragging it
 * or opening it: Open, a move to any column the card can legally go to, keep
 * on Home, and, on a desktop, a move between sprints.
 *
 * The moves are the "Move to…" menu's own rows (moveRows, off the same
 * legalTargets() map the drag, the pickers and the Needs-you menu read), and a
 * choice goes through the board's own move, so a gated move shows with its
 * reason and cannot be chosen, and a refusal says why in the board's callout.
 * The menu is the one the tab right-click menus use (ui/context-menu).
 *
 * ONE menu for the whole board, opened at the pointer, rather than a context
 * menu wrapped around each card: a per-card wrapper re-rendered every card on
 * unrelated page state, which the board's render-cost budget forbids. */

const MENU_CLASS = "min-w-[220px] rounded-[var(--radius-xl)] p-1.5"

interface MenuTarget {
  item: WorkItemCompactWire
  point: MenuPoint
  /** Bumped per open: each one mounts a fresh menu, measured at its own
   *  point, rather than reusing the one still anchored where the last one was. */
  seq: number
}

export interface BoardCardMenuOptions {
  /** The cards as the board shows them now (an optimistic move included), by column. */
  itemsByStatus: Partial<Record<WorkItemStatusWire, WorkItemCompactWire[]>>
  enabled: boolean
  openChildrenOf: (id: string) => number
  onOpen: (id: string, item: WorkItemCompactWire) => void
  onMove: (item: WorkItemCompactWire, to: WorkItemStatusWire) => void
  onKeep?: (vars: { id: string; kept: boolean }) => void
  /** Sprints to offer, when the board has them in reach (not on a phone). */
  sprints?: CardSprints
}

/** `onContextMenu` and `onKeyDown` go on the element holding the cards; `menu` renders anywhere. */
export function useBoardCardMenu(options: BoardCardMenuOptions) {
  const [target, setTarget] = useState<MenuTarget | null>(null)
  const latest = useRef(options)
  latest.current = options

  const open = useCallback((event: Event, card: HTMLElement | null, point: (card: HTMLElement) => MenuPoint) => {
    const { enabled, itemsByStatus } = latest.current
    if (!enabled || !card) return false
    const id = card.dataset.boardCard ?? ""
    const item = Object.values(itemsByStatus).flat().find((candidate) => candidate?.id === id)
    // Anywhere but a card keeps the browser's own menu.
    if (!item) return false
    event.preventDefault()
    setTarget((last) => ({ item, point: point(card), seq: (last?.seq ?? 0) + 1 }))
    return true
  }, [])

  const onContextMenu = useCallback((event: React.MouseEvent) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>("[data-board-card]")
    open(event.nativeEvent, card, () => ({ x: event.clientX, y: event.clientY }))
  }, [open])

  // Shift+F10 and the Menu key, on a focused card: the menu opens under the card, with its first row focused.
  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (!(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return
    const card = event.target instanceof HTMLElement && event.target.matches("[data-board-card]") ? event.target : null
    open(event.nativeEvent, card, (el) => {
      const rect = el.getBoundingClientRect()
      return { x: rect.left + Math.min(rect.width / 2, 24), y: rect.bottom, keyboard: true }
    })
  }, [open])

  const menu = target
    ? <BoardCardMenu key={target.seq} target={target} options={options} onClose={() => setTarget(null)} />
    : null
  return { onContextMenu, onKeyDown, menu }
}

function BoardCardMenu({ target, options, onClose }: { target: MenuTarget; options: BoardCardMenuOptions; onClose: () => void }) {
  const { item } = target
  const { sprints, onKeep, onOpen, onMove } = options
  // The current column is where the card already is: only the others are moves.
  const moves = moveRows(item, options.openChildrenOf(item.id)).filter((row) => row.status !== item.status)
  return (
    <PointMenu point={target.point} onOpenChange={(open) => { if (!open) onClose() }}>
      <ContextMenuContent aria-label={`${item.id} actions`} className={MENU_CLASS} data-testid="board-card-menu">
        <ContextMenuLabel className={MENU_LABEL_CLASS}>{item.id}</ContextMenuLabel>
        <ContextMenuItem className={MENU_ITEM_CLASS} data-testid="board-card-open" onSelect={() => onOpen(item.id, item)}>
          Open
        </ContextMenuItem>
        {onKeep && (
          <ContextMenuItem className={MENU_ITEM_CLASS} data-testid="board-card-keep" onSelect={() => onKeep({ id: item.id, kept: item.kept !== true })}>
            {item.kept === true ? "Remove from Home" : "Keep on Home"}
          </ContextMenuItem>
        )}
        {moves.length > 0 && (
          <>
            <ContextMenuSeparator />
            {moves.map((row) => (
              <ContextMenuItem
                key={row.status}
                className={`${MENU_ITEM_CLASS} items-start py-2`}
                disabled={row.disabled}
                data-testid={`board-card-move-${row.status}`}
                onSelect={() => onMove(item, row.status)}
              >
                <StatusCircle status={row.status} size={18} />
                <span className="flex flex-col items-start">
                  Move to {STATUS_LABEL[row.status]}
                  {row.reason && <span className="text-[11px] font-normal text-[var(--text-tertiary)]">{row.reason}</span>}
                </span>
              </ContextMenuItem>
            ))}
          </>
        )}
        {sprints && (
          <>
            <ContextMenuSeparator />
            <SprintCardItems item={item} sprints={sprints.sprints} onMove={(sprint) => sprints.move(item, sprint)} />
          </>
        )}
      </ContextMenuContent>
    </PointMenu>
  )
}
