import { useCallback, useEffect, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"

/** The history-state key naming the Todo whose sub-board pop-up is open over the routed board. */
const OPEN_KEY = "cardSubBoardOf"

function record(state: unknown): Record<string, unknown> {
  return state !== null && typeof state === "object" ? (state as Record<string, unknown>) : {}
}

/** The sub-board pop-up a board card's menu opens over the board: which Todo's sub-Todos it shows, and the two moves.
 *
 *  Over the board's own route, opening it pushes an entry of the same address that names the Todo in its state, so Back closes
 *  it (as it does the Todo page's `?view=board`), a reload keeps it open, and Forward brings it back. Closing undoes that push.
 *  The address, and so the board's filters, are untouched. Over a pane, a tab or another pop-up (`routed` false) the route is
 *  not this board's to write, so the open Todo is held in memory (`pushes` false). */
export function useCardSubBoard(routed: boolean) {
  const { pathname, search, state, key } = useLocation()
  const navigate = useNavigate()
  const [held, setHeld] = useState<string | null>(null)
  /** The entry a close has started from while it is still landing: a second close before it must not go back again, which
   *  would leave the board. Cleared once the location moves. */
  const closingFrom = useRef<string | null>(null)
  useEffect(() => {
    closingFrom.current = null
  }, [key])
  const fromState = record(state)[OPEN_KEY]
  const openId = routed ? (typeof fromState === "string" ? fromState : null) : held
  const show = useCallback(
    (id: string) => {
      if (!routed) return setHeld(id)
      void navigate({ pathname, search }, { state: { ...record(state), [OPEN_KEY]: id } })
    },
    [routed, navigate, pathname, search, state],
  )
  const hide = useCallback(() => {
    if (!routed) return setHeld(null)
    if (closingFrom.current === key) return
    closingFrom.current = key
    void navigate(-1)
  }, [routed, navigate, key])
  return { openId, show, hide, pushes: routed }
}
