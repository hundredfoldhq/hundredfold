import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { CornerDownRight } from "@/components/ui/icon"
import { api, type WorkItemCompactWire, type WorkItemDetailWire, type WorkItemTreeNodeWire } from "@/lib/api"
import { PickerNote, PickerPopover, PickerRow, PickerSheet } from "../pickers/picker-shell"
import { StatusCircle } from "../state-glyph"
import { RailRow } from "./rail-rows"
import { nodeOf } from "./task-tree"
import { reparentErrorMessage, useReparentWorkItem } from "./use-reparent"
import { useIsTaskMobile } from "./use-task-mobile"

/* The task rail's Parent row: which Todo this one is a sub-task of, and the
 * picker that moves it under another Todo or back to top level. The picker is
 * the rail's own shell (popover on a desktop, bottom sheet on a phone), so
 * Escape, a click outside and the arrow keys behave as they do on every other
 * row. The gateway does the work and the refusing (a loop, a closed parent, a
 * sprint, a department boundary); the picker shows its message in place. The
 * Todo's own sub-tasks move with it, which the picker says before the move.
 * Mount it with `key={todoId}`: a picker opened on one Todo must not outlive it. */

const MONO = { fontFamily: "var(--font-code)", letterSpacing: ".04em" } as const
const isClosed = (status: string): boolean => status === "done" || status === "cancelled"

/** Every id below `node`: the Todos that cannot become this one's parent. */
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
  const mobile = useIsTaskMobile()
  const [open, setOpen] = useState(false)
  const move = useReparentWorkItem()
  // The same tree the page reads for its breadcrumb, so the title and the sub-tasks cost no request of their own.
  const tree = useQuery({
    queryKey: ["work-item-tree", rootId],
    queryFn: () => api.getWorkItemTree(rootId),
    staleTime: 10_000,
  })
  const root = tree.data?.tree.root
  const below = idsBelow(nodeOf(root, item.id))
  const { reset } = move

  const close = () => {
    reset()
    setOpen(false)
  }
  const choose = (next: string | null) => move.mutate({ id: item.id, parentId: next }, { onSuccess: close })
  const content = (
    <ParentPicker
      itemId={item.id}
      parentId={parentId}
      below={below}
      pending={move.isPending}
      error={move.isError ? reparentErrorMessage(move.error, "Couldn't move the Todo") : null}
      sheet={mobile}
      onChoose={choose}
    />
  )

  return (
    <div className="relative">
      <RailRow quiet testId="rail-parent" label="Parent" onOpen={() => (open ? close() : setOpen(true))} open={open}>
        <CornerDownRight size={14} aria-hidden className="flex-none text-[var(--text-quaternary)]" />
        <ParentValue parentId={parentId} root={root} />
      </RailRow>
      {open && <ParentShell mobile={mobile} onClose={close}>{content}</ParentShell>}
    </div>
  )
}

/** The rail's own shell: a popover over the row on a desktop, a bottom sheet on a phone. */
function ParentShell({ mobile, onClose, children }: { mobile: boolean; onClose: () => void; children: React.ReactNode }) {
  if (mobile) return <PickerSheet title="Parent" onClose={onClose} testId="parent-picker">{children}</PickerSheet>
  return <PickerPopover label="Parent" onClose={onClose} autoFocusFirst={false} testId="parent-picker">{children}</PickerPopover>
}

function ParentValue({ parentId, root }: { parentId: string | null; root: WorkItemTreeNodeWire | undefined }) {
  if (!parentId) return <span className="text-[var(--text-tertiary)]">Top level</span>
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="text-[11px] text-[var(--text-tertiary)]" style={MONO}>{parentId}</span>
      <span className="min-w-0 truncate">{nodeOf(root, parentId)?.title}</span>
    </span>
  )
}

type Search = { results: WorkItemCompactWire[]; failed: boolean }

/** Recent Todos until two characters are typed, then a text search. A failed search is reported, not read as "no matches". */
function useParentSearch(itemId: string, query: string): Search {
  const [state, setState] = useState<Search>({ results: [], failed: false })
  useEffect(() => {
    const text = query.trim()
    let cancelled = false
    const timer = window.setTimeout(() => {
      const searching = text.length >= 2
      const page = searching ? api.searchWorkItems({ text, limit: 8 }) : api.listWorkItems({ limit: 8 })
      void page
        .then((found) => {
          // A closed Todo cannot take a sub-task: the recent list leaves it out, a search shows it as unavailable.
          const rows = found.workItems.filter((candidate) => candidate.id !== itemId && (searching || !isClosed(candidate.status)))
          if (!cancelled) setState({ results: rows, failed: false })
        })
        .catch(() => { if (!cancelled) setState({ results: [], failed: true }) })
    }, text ? 200 : 0)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [itemId, query])
  return state
}

function ParentPicker({ itemId, parentId, below, pending, error, sheet, onChoose }: {
  itemId: string
  parentId: string | null
  below: Set<string>
  pending: boolean
  error: string | null
  sheet: boolean
  onChoose: (parentId: string | null) => void
}) {
  const [query, setQuery] = useState("")
  const { results, failed } = useParentSearch(itemId, query)
  return (
    <>
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search for a parent Todo…"
        aria-label="Search for a parent Todo"
        data-testid="parent-search"
        className="mb-1 w-full rounded-full bg-[var(--fill-quaternary)] px-3 py-1.5 text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)]"
      />
      {parentId !== null && (
        <PickerRow testId="parent-detach" sheet={sheet} disabled={pending} label="Move to top level" onSelect={() => onChoose(null)} />
      )}
      {results.map((candidate) => (
        <CandidateRow
          key={candidate.id}
          candidate={candidate}
          sheet={sheet}
          current={candidate.id === parentId}
          disabled={pending || candidate.id === parentId || isClosed(candidate.status)}
          underItem={below.has(candidate.id)}
          onPick={() => onChoose(candidate.id)}
        />
      ))}
      {failed && <PickerNote>Couldn't search Todos. Try again.</PickerNote>}
      {below.size > 0 && <PickerNote>Its sub-tasks move with it.</PickerNote>}
      {error && (
        <div role="alert" data-testid="rail-parent-error" className="px-2.5 pb-1 pt-1 text-[length:var(--text-caption1)] text-[var(--system-red)]">
          {error}
        </div>
      )}
    </>
  )
}

function CandidateRow({ candidate, sheet, current, disabled, underItem, onPick }: {
  candidate: WorkItemCompactWire
  sheet: boolean
  current: boolean
  disabled: boolean
  /** The candidate sits below the Todo being moved: picking it asks the gateway, which refuses the loop. */
  underItem: boolean
  onPick: () => void
}) {
  return (
    <PickerRow
      testId={`parent-result-${candidate.id}`}
      sheet={sheet}
      checked={current}
      disabled={disabled}
      reason={isClosed(candidate.status) ? "Closed" : undefined}
      onSelect={onPick}
      glyph={<StatusCircle status={candidate.status} size={16} />}
      label={<><span className="mr-1.5 whitespace-nowrap text-[11px] text-[var(--text-tertiary)]" style={MONO}>{candidate.id}</span>{candidate.title}</>}
      trailing={underItem ? <span className="text-[11px] text-[var(--text-quaternary)]">sub-task</span> : undefined}
    />
  )
}
