import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { CornerDownRight } from "@/components/ui/icon"
import { api, type WorkItemCompactWire, type WorkItemDetailWire, type WorkItemTreeNodeWire } from "@/lib/api"
import { StatusCircle } from "../state-glyph"
import { RailRow } from "./rail-rows"
import { nodeOf } from "./task-tree"
import { reparentErrorMessage, useReparentWorkItem } from "./use-reparent"

/* The task rail's Parent row: which Todo this one is a sub-task of, and the
 * picker that moves it under another Todo or back to top level. The gateway
 * does the work and the refusing (a loop, a closed parent, a sprint, a
 * department boundary); the row shows its message in place. The Todo's own
 * sub-tasks move with it, which the picker says before the move. */

const ROW_CLASS = "focus-outline flex min-h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] outline-none hover:bg-[var(--fill-tertiary)] disabled:opacity-50"
const MONO = { fontFamily: "var(--font-code)", letterSpacing: ".04em" } as const

/** Every id at or below `node`: the Todos that cannot become this one's parent. */
function idsBelow(node: WorkItemTreeNodeWire | undefined): Set<string> {
  const out = new Set<string>()
  const walk = (n: WorkItemTreeNodeWire) => {
    for (const child of n.children ?? []) {
      out.add(child.id)
      walk(child)
    }
  }
  if (node) walk(node)
  return out
}

export function ParentRailRow({ detail }: { detail: WorkItemDetailWire }) {
  const item = detail.workItem
  const parentId = item.parentId ?? null
  const rootId = item.rootId ?? item.id
  const [open, setOpen] = useState(false)
  const move = useReparentWorkItem()
  // The same tree the page reads for its breadcrumb, so the title and the sub-tasks cost no request of their own.
  const tree = useQuery({
    queryKey: ["work-item-tree", rootId],
    queryFn: () => api.getWorkItemTree(rootId),
    staleTime: 10_000,
  })
  const root = tree.data?.tree.root
  const parent = parentId ? nodeOf(root, parentId) : undefined
  const below = idsBelow(nodeOf(root, item.id))

  const choose = (next: string | null) => {
    move.mutate({ id: item.id, parentId: next }, { onSuccess: () => setOpen(false) })
  }

  return (
    <div className="relative">
      <RailRow quiet testId="rail-parent" label="Parent" onOpen={() => { move.reset(); setOpen((o) => !o) }} open={open}>
        <CornerDownRight size={14} aria-hidden className="flex-none text-[var(--text-quaternary)]" />
        <ParentValue parentId={parentId} title={parent?.title} />
      </RailRow>
      {open && (
        <ParentPicker
          itemId={item.id}
          parentId={parentId}
          below={below}
          hasSubtasks={below.size > 0}
          pending={move.isPending}
          onChoose={choose}
          onClose={() => setOpen(false)}
        />
      )}
      {move.isError && (
        <div role="alert" data-testid="rail-parent-error" className="pt-1 text-[length:var(--text-caption1)] text-[var(--system-red)]">
          {reparentErrorMessage(move.error, "Couldn't move the Todo")}
        </div>
      )}
    </div>
  )
}

function ParentValue({ parentId, title }: { parentId: string | null; title: string | undefined }) {
  if (!parentId) return <span className="text-[var(--text-tertiary)]">Top level</span>
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="text-[11px] text-[var(--text-tertiary)]" style={MONO}>{parentId}</span>
      {title && <span className="min-w-0 truncate">{title}</span>}
    </span>
  )
}

function useParentSearch(itemId: string, query: string): WorkItemCompactWire[] {
  const [results, setResults] = useState<WorkItemCompactWire[]>([])
  useEffect(() => {
    const text = query.trim()
    let cancelled = false
    const timer = window.setTimeout(() => {
      const page = text.length >= 2 ? api.searchWorkItems({ text, limit: 8 }) : api.listWorkItems({ limit: 8 })
      void page
        .then((found) => { if (!cancelled) setResults(found.workItems.filter((candidate) => candidate.id !== itemId)) })
        .catch(() => { if (!cancelled) setResults([]) })
    }, text ? 200 : 0)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [itemId, query])
  return results
}

function ParentPicker({ itemId, parentId, below, hasSubtasks, pending, onChoose, onClose }: {
  itemId: string
  parentId: string | null
  below: Set<string>
  hasSubtasks: boolean
  pending: boolean
  onChoose: (parentId: string | null) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState("")
  const results = useParentSearch(itemId, query)
  return (
    <div className="mt-1.5 rounded-[12px] bg-[var(--fill-tertiary)] p-2" data-testid="parent-picker">
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") onClose() }}
        placeholder="Search for a parent Todo…"
        aria-label="Search for a parent Todo"
        data-testid="parent-search"
        className="w-full rounded-full bg-[var(--fill-quaternary)] px-3 py-1.5 text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)]"
      />
      <div className="mt-1.5 flex flex-col">
        {parentId !== null && (
          <button type="button" data-testid="parent-detach" disabled={pending} onClick={() => onChoose(null)} className={ROW_CLASS}>
            <span className="font-medium text-[var(--text-primary)]">Move to top level</span>
          </button>
        )}
        {results.map((candidate) => (
          <CandidateRow
            key={candidate.id}
            candidate={candidate}
            disabled={pending || candidate.id === parentId}
            underItem={below.has(candidate.id)}
            onPick={() => onChoose(candidate.id)}
          />
        ))}
      </div>
      {hasSubtasks && (
        <div className="px-2 pt-1.5 text-[10.5px] leading-snug text-[var(--text-quaternary)]">Its sub-tasks move with it.</div>
      )}
    </div>
  )
}

function CandidateRow({ candidate, disabled, underItem, onPick }: {
  candidate: WorkItemCompactWire
  disabled: boolean
  /** The candidate sits below the Todo being moved: picking it asks the gateway, which refuses the loop. */
  underItem: boolean
  onPick: () => void
}) {
  return (
    <button type="button" data-testid={`parent-result-${candidate.id}`} disabled={disabled} onClick={onPick} className={ROW_CLASS}>
      <StatusCircle status={candidate.status} size={16} />
      <span className="flex-none whitespace-nowrap text-[11px] text-[var(--text-tertiary)]" style={MONO}>{candidate.id}</span>
      <span className="min-w-0 truncate font-medium text-[var(--text-primary)]">{candidate.title}</span>
      {underItem && <span className="ml-auto flex-none text-[11px] text-[var(--text-quaternary)]">sub-task</span>}
    </button>
  )
}
