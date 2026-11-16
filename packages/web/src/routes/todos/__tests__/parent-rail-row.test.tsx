import "@/test/preload-dialogs"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemDetailWire, WorkItemEventWire, WorkItemTreeNodeWire } from "@/lib/api"

/* The task rail's Parent row: the move between top level and sub-task level,
 * its refusals in the gateway's words, and how the history reads a move. */

const api = vi.hoisted(() => ({
  reparentWorkItem: vi.fn(),
  getWorkItemTree: vi.fn(),
  searchWorkItems: vi.fn(),
  listWorkItems: vi.fn(),
}))

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: { ...actual.api, ...api } }
})

const { ApiError } = await import("@/lib/api")
const { ParentRailRow } = await import("../task-page/parent-rail-row")
const { whisperOf } = await import("../task-page/whisper")
const { buildFeed } = await import("../task-page/activity-feed")

function node(id: string, title: string, children: WorkItemTreeNodeWire[] = [], parentId: string | null = null): WorkItemTreeNodeWire {
  return { id, title, parentId, rootId: "AAA-1", status: "backlog", children } as unknown as WorkItemTreeNodeWire
}

function detailOf(id: string, parentId: string | null): WorkItemDetailWire {
  return { workItem: { id, parentId, rootId: parentId ? "AAA-1" : id, title: id, status: "backlog" }, events: [] } as unknown as WorkItemDetailWire
}

function compact(id: string, title: string, status = "backlog") {
  return { id, title, status }
}

function renderRow(detail: WorkItemDetailWire) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const ui = (d: WorkItemDetailWire) => <QueryClientProvider client={qc}><ParentRailRow key={d.workItem.id} detail={d} /></QueryClientProvider>
  const view = render(ui(detail))
  return { qc, showTodo: (next: WorkItemDetailWire) => view.rerender(ui(next)) }
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  api.listWorkItems.mockResolvedValue({ workItems: [compact("AAA-1", "Plan"), compact("AAA-2", "Child"), compact("AAA-3", "Grandchild"), compact("AAA-9", "Other")] })
  api.searchWorkItems.mockResolvedValue({ workItems: [compact("AAA-9", "Other")] })
  api.reparentWorkItem.mockResolvedValue({ id: "AAA-2", parentId: "AAA-9", rootId: "AAA-9", depth: 1, version: 3, changed: true, moved: ["AAA-2", "AAA-3"] })
})

describe("the Parent row", () => {
  it("reads Top level for a root and moves it under the Todo that is picked", async () => {
    api.getWorkItemTree.mockResolvedValue({ tree: { root: node("AAA-9", "Other") } })
    renderRow(detailOf("AAA-9", null))
    expect(screen.getByTestId("rail-parent").textContent).toContain("Top level")
    fireEvent.click(screen.getByTestId("rail-parent"))
    expect(screen.queryByTestId("parent-detach")).toBeNull()
    fireEvent.click(await screen.findByTestId("parent-result-AAA-1"))
    await waitFor(() => expect(api.reparentWorkItem).toHaveBeenCalledWith("AAA-9", "AAA-1"))
    await waitFor(() => expect(screen.queryByTestId("parent-picker")).toBeNull())
  })

  it("names the parent of a sub-task and detaches it to top level", async () => {
    api.getWorkItemTree.mockResolvedValue({ tree: { root: node("AAA-1", "Plan", [node("AAA-2", "Child", [], "AAA-1")]) } })
    api.reparentWorkItem.mockResolvedValue({ id: "AAA-2", parentId: null, rootId: "AAA-2", depth: 0, version: 4, changed: true, moved: ["AAA-2"] })
    renderRow(detailOf("AAA-2", "AAA-1"))
    await waitFor(() => expect(screen.getByTestId("rail-parent").textContent).toContain("Plan"))
    expect(screen.getByTestId("rail-parent").textContent).toContain("AAA-1")
    fireEvent.click(screen.getByTestId("rail-parent"))
    fireEvent.click(screen.getByTestId("parent-detach"))
    await waitFor(() => expect(api.reparentWorkItem).toHaveBeenCalledWith("AAA-2", null))
  })

  it("never offers the Todo as its own parent, marks its sub-tasks, and does not re-pick the current parent", async () => {
    api.getWorkItemTree.mockResolvedValue({ tree: { root: node("AAA-1", "Plan", [node("AAA-2", "Child", [node("AAA-3", "Grandchild", [], "AAA-2")], "AAA-1")]) } })
    renderRow(detailOf("AAA-2", "AAA-1"))
    fireEvent.click(screen.getByTestId("rail-parent"))
    const below = await screen.findByTestId("parent-result-AAA-3")
    expect(below.textContent).toContain("sub-task")
    expect(screen.queryByTestId("parent-result-AAA-2")).toBeNull()
    expect(screen.getByTestId("parent-result-AAA-1").getAttribute("aria-disabled")).toBe("true")
    expect(screen.getByText("Its sub-tasks move with it.")).toBeTruthy()
  })

  it("shows a refused loop in the gateway's words, not a raw API error", async () => {
    api.getWorkItemTree.mockResolvedValue({ tree: { root: node("AAA-1", "Plan", [node("AAA-2", "Child", [node("AAA-3", "Grandchild", [], "AAA-2")], "AAA-1")]) } })
    api.reparentWorkItem.mockRejectedValue(new ApiError(400, "AAA-2 cannot become a sub-task of AAA-3, which is already beneath it"))
    renderRow(detailOf("AAA-2", "AAA-1"))
    fireEvent.click(screen.getByTestId("rail-parent"))
    fireEvent.click(await screen.findByTestId("parent-result-AAA-3"))
    const alert = await screen.findByTestId("rail-parent-error")
    expect(alert.textContent).toBe("AAA-2 cannot become a sub-task of AAA-3, which is already beneath it")
    expect(alert.textContent).not.toMatch(/API error|400/)
    // The picker stays open so another parent can be tried.
    expect(screen.getByTestId("parent-picker")).toBeTruthy()
  })

  it("falls back to a plain line for a failure that is not a refusal", async () => {
    api.getWorkItemTree.mockResolvedValue({ tree: { root: node("AAA-9", "Other") } })
    api.reparentWorkItem.mockRejectedValue(new ApiError(500, "boom: stack trace"))
    renderRow(detailOf("AAA-9", null))
    fireEvent.click(screen.getByTestId("rail-parent"))
    fireEvent.click(await screen.findByTestId("parent-result-AAA-1"))
    expect((await screen.findByTestId("rail-parent-error")).textContent).toBe("Couldn't move the Todo")
  })

  it("searches by text once two characters are typed", async () => {
    api.getWorkItemTree.mockResolvedValue({ tree: { root: node("AAA-9", "Other") } })
    renderRow(detailOf("AAA-9", null))
    fireEvent.click(screen.getByTestId("rail-parent"))
    fireEvent.change(screen.getByTestId("parent-search"), { target: { value: "oth" } })
    await waitFor(() => expect(api.searchWorkItems).toHaveBeenCalledWith({ text: "oth", limit: 8 }))
  })
})

describe("closing and resetting the picker", () => {
  const loopTree = () => api.getWorkItemTree.mockResolvedValue({ tree: { root: node("AAA-1", "Plan", [node("AAA-2", "Child", [node("AAA-3", "Grandchild", [], "AAA-2")], "AAA-1")]) } })

  it("closes on Escape from any row, not only from the search box, and drops a refusal with it", async () => {
    loopTree()
    api.reparentWorkItem.mockRejectedValue(new ApiError(400, "loop refused"))
    renderRow(detailOf("AAA-2", "AAA-1"))
    fireEvent.click(screen.getByTestId("rail-parent"))
    fireEvent.click(await screen.findByTestId("parent-result-AAA-3"))
    await screen.findByTestId("rail-parent-error")
    screen.getByTestId("parent-detach").focus()
    fireEvent.keyDown(screen.getByTestId("parent-detach"), { key: "Escape" })
    await waitFor(() => expect(screen.queryByTestId("parent-picker")).toBeNull())
    expect(screen.queryByTestId("rail-parent-error")).toBeNull()
    fireEvent.click(screen.getByTestId("rail-parent"))
    expect(screen.queryByTestId("rail-parent-error")).toBeNull()
  })

  it("closes on a press outside the picker", async () => {
    loopTree()
    renderRow(detailOf("AAA-2", "AAA-1"))
    fireEvent.click(screen.getByTestId("rail-parent"))
    await screen.findByTestId("parent-picker")
    fireEvent.pointerDown(document.body)
    await waitFor(() => expect(screen.queryByTestId("parent-picker")).toBeNull())
  })

  it("does not carry an open picker or a refusal over to another Todo", async () => {
    loopTree()
    api.reparentWorkItem.mockRejectedValue(new ApiError(400, "loop refused"))
    const { showTodo } = renderRow(detailOf("AAA-2", "AAA-1"))
    fireEvent.click(screen.getByTestId("rail-parent"))
    fireEvent.click(await screen.findByTestId("parent-result-AAA-3"))
    await screen.findByTestId("rail-parent-error")
    showTodo(detailOf("AAA-3", "AAA-2"))
    expect(screen.queryByTestId("parent-picker")).toBeNull()
    expect(screen.queryByTestId("rail-parent-error")).toBeNull()
  })

  it("invalidates every Todo cache and the trees after a move", async () => {
    api.getWorkItemTree.mockResolvedValue({ tree: { root: node("AAA-9", "Other") } })
    const { qc } = renderRow(detailOf("AAA-9", null))
    const invalidate = vi.spyOn(qc, "invalidateQueries")
    fireEvent.click(screen.getByTestId("rail-parent"))
    fireEvent.click(await screen.findByTestId("parent-result-AAA-1"))
    await waitFor(() => expect(api.reparentWorkItem).toHaveBeenCalled())
    await waitFor(() => {
      const keys = invalidate.mock.calls.map((call) => JSON.stringify((call[0] as { queryKey: unknown }).queryKey))
      for (const key of ['["work-items"]', '["work-item"]', '["work-item-preview"]', '["work-item-tree"]']) expect(keys).toContain(key)
    })
  })

  it("opens as a bottom sheet on a phone", async () => {
    api.getWorkItemTree.mockResolvedValue({ tree: { root: node("AAA-9", "Other") } })
    const original = window.matchMedia
    window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia
    try {
      renderRow(detailOf("AAA-9", null))
      fireEvent.click(screen.getByTestId("rail-parent"))
      expect(await screen.findByTestId("parent-picker")).toBeTruthy()
      expect(screen.getByRole("dialog", { name: "Parent" })).toBeTruthy()
      fireEvent.click(await screen.findByTestId("parent-result-AAA-1"))
      await waitFor(() => expect(api.reparentWorkItem).toHaveBeenCalledWith("AAA-9", "AAA-1"))
    } finally {
      window.matchMedia = original
    }
  })
})

describe("what the picker offers", () => {
  it("leaves closed Todos out of the recent list but shows them as unavailable in a search", async () => {
    api.getWorkItemTree.mockResolvedValue({ tree: { root: node("AAA-9", "Other") } })
    api.listWorkItems.mockResolvedValue({ workItems: [compact("AAA-4", "Shipped", "done"), compact("AAA-1", "Plan")] })
    api.searchWorkItems.mockResolvedValue({ workItems: [compact("AAA-4", "Shipped", "done")] })
    renderRow(detailOf("AAA-9", null))
    fireEvent.click(screen.getByTestId("rail-parent"))
    await screen.findByTestId("parent-result-AAA-1")
    expect(screen.queryByTestId("parent-result-AAA-4")).toBeNull()
    fireEvent.change(screen.getByTestId("parent-search"), { target: { value: "ship" } })
    const closed = await screen.findByTestId("parent-result-AAA-4")
    expect(closed.getAttribute("aria-disabled")).toBe("true")
    expect(closed.textContent).toContain("Closed")
  })

  it("says so when the search itself fails", async () => {
    api.getWorkItemTree.mockResolvedValue({ tree: { root: node("AAA-9", "Other") } })
    api.searchWorkItems.mockRejectedValue(new Error("offline"))
    renderRow(detailOf("AAA-9", null))
    fireEvent.click(screen.getByTestId("rail-parent"))
    fireEvent.change(screen.getByTestId("parent-search"), { target: { value: "oth" } })
    expect(await screen.findByText("Couldn't search Todos. Try again.")).toBeTruthy()
  })
})

describe("history lines for a move", () => {
  const event = (detail: Record<string, unknown>): WorkItemEventWire => ({
    id: "e", workItemId: "AAA-2", kind: "note", fromStatus: null, toStatus: null, actor: "operator", detail, createdAt: "2026-11-16T10:00:00.000Z",
  })

  it("reads a move under a parent, a detach, and the sub-tasks that came along", () => {
    expect(whisperOf(event({ reparented: { from: null, to: "AAA-1", rootFrom: "AAA-2", rootTo: "AAA-1", depth: 1 } })).text).toBe("made it a sub-task of AAA-1")
    expect(whisperOf(event({ reparented: { from: "AAA-1", to: null, rootFrom: "AAA-1", rootTo: "AAA-2", depth: 0 } })).text).toBe("moved it to top level, out of AAA-1")
    expect(whisperOf(event({ reparented: { with: "AAA-2", rootFrom: "AAA-1", rootTo: "AAA-2" } })).text).toBe("moved along with AAA-2")
  })

  it("reads a sub-task arriving at or leaving a parent", () => {
    expect(whisperOf(event({ childReparented: { child: "AAA-2", from: null, to: "AAA-1" } })).text).toBe("moved sub-task AAA-2 under AAA-1")
    expect(whisperOf(event({ childReparented: { child: "AAA-2", from: "AAA-1", to: null } })).text).toBe("moved sub-task AAA-2 to top level")
  })

  it("never folds a move into the quiet updates", () => {
    const quiet = (id: string, detail: Record<string, unknown> | null = null): WorkItemEventWire => ({ ...event({}), id, detail, createdAt: `2026-11-16T10:00:0${id}.000Z` })
    const blocks = buildFeed(
      [quiet("1", { updatedFields: ["a"] }), quiet("2", { reparented: { from: null, to: "AAA-1" } }), quiet("3", { updatedFields: ["b"] }), quiet("4", { updatedFields: ["c"] })],
      [],
      [],
    )
    expect(blocks.some((block) => block.kind === "event" && block.event.id === "2")).toBe(true)
  })

  it("keeps the older note readings", () => {
    expect(whisperOf(event({ assignee: "someone" })).text).toBe("assigned someone")
    expect(whisperOf(event({})).text).toBe("added a note")
  })
})
