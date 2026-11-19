import { lazy, Suspense, useCallback, useMemo, useState } from "react"
import { LoadBoundary } from "@/components/ui/lazy-overlay"
import type { TodoFilters } from "@/lib/todos"
import { SprintStrip } from "./sprint-strip"
import type { CardSprints } from "./sprint-card-menu"
import { sprintErrorMessage, useSetWorkItemSprint, useSprints } from "./use-sprints"

/* The planner is only needed once someone opens it, so it stays out of the
 * board chunk and loads on first open. It then stays mounted, closed, so the
 * dialog plays its exit animation. */
const SprintsDialog = lazy(() => import("./sprints-dialog").then((module) => ({ default: module.SprintsDialog })))

/** The lazily loaded planner. One that cannot load is dropped, not just closed, so the next open tries (and says so) again. */
function PlannerHost({ planner, close, drop, onShowOnBoard }: {
  planner: { open: boolean; completing?: string }
  close: () => void
  drop: () => void
  onShowOnBoard: (sprintId: string) => void
}) {
  return (
    <LoadBoundary what="The sprint planner" onFailed={drop}>
      <Suspense fallback={null}>
        <SprintsDialog
          open={planner.open}
          onOpenChange={(open) => { if (!open) close() }}
          completing={planner.completing ?? null}
          onShowOnBoard={onShowOnBoard}
        />
      </Suspense>
    </LoadBoundary>
  )
}

/* Everything the board needs for sprints, in one place: the strip under the
 * filter row while a sprint filter is set, the planner dialog, and the card
 * sprints a card's right-click menu offers. The board mounts `strip` and
 * `overlays`, hands `openPlanner` to its filter controls, and gives
 * `cardSprints` to the card menu. */

export function useBoardSprints({ filters, setFilters, mobile, announce }: {
  filters: TodoFilters
  setFilters: (next: TodoFilters) => void
  mobile: boolean
  announce: (message: string) => void
}) {
  const [planner, setPlanner] = useState<null | { open: boolean; completing?: string }>(null)
  const sprints = useSprints(!mobile)
  const openSprints = useMemo(() => (sprints.data ?? []).filter((sprint) => sprint.status !== "closed"), [sprints.data])
  const onMoveError = useCallback(
    (error: unknown) => announce(sprintErrorMessage(error, "The gateway refused to move the Todo to that sprint")),
    [announce],
  )
  const setSprint = useSetWorkItemSprint()
  const cardSprints = useMemo<CardSprints | undefined>(
    () => (mobile ? undefined : { sprints: openSprints, move: (item, sprint) => setSprint.mutate({ id: item.id, sprint }, { onError: onMoveError }) }),
    [mobile, openSprints, setSprint.mutate, onMoveError],
  )
  const openPlanner = useCallback(() => setPlanner({ open: true }), [])
  const closePlanner = useCallback(() => setPlanner((current) => (current ? { ...current, open: false } : current)), [])

  const strip = filters.sprint
    ? <SprintStrip filter={filters.sprint} onManage={openPlanner} onComplete={(id) => setPlanner({ open: true, completing: id })} />
    : null
  const overlays = (
    <>
      {planner !== null && (
        <PlannerHost
          planner={planner}
          close={closePlanner}
          drop={() => setPlanner(null)}
          onShowOnBoard={(sprintId) => {
            closePlanner()
            setFilters({ ...filters, sprint: sprintId })
          }}
        />
      )}
    </>
  )
  return { strip, overlays, openPlanner, cardSprints }
}
