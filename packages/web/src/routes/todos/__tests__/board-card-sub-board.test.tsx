import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import "@/test/preload-menus"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemCompactWire, WorkItemListWire, WorkItemStatusWire, WorkItemTreeWire } from "@/lib/api"
import { clearBoardScrollCache } from "../board/board-route"
import TodosTabView from "../board/todos-tab-view"
import { clearTodosTabLocationMemory } from "../board/todos-tab-location"

/* "View as board" from a card, on the boards a person actually reaches: the Todos tab of the chat layout (desktop and
 * phone), where the route is the chat's. The routed board has its own file (board-card-menu.test.tsx). */

vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))

const preload = vi.hoisted(() => vi.fn())
vi.mock("../board/sub-board-dialog-lazy", () => ({
  LazySubBoardDialog: ({ rootId, onClose, closeOnOpenTodo }: { rootId: string; onClose: () => void; closeOnOpenTodo?: boolean }) => (
    <div data-testid="sub-board-dialog" data-root={rootId} data-close-on-open={String(closeOnOpenTodo)}>
      <button type="button" onClick={onClose}>Close pop-up</button>
      {/* Two callers closing in one tick (a double click, a second onClose caller), before the first close has landed. */}
      <button type="button" onClick={() => { onClose(); onClose() }}>Close pop-up twice</button>
    </div>
  ),
  preloadSubBoardDialog: preload,
}))

const listWorkItems = vi.fn()
const getWorkItemTrees = vi.fn()
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      listWorkItems: (...args: unknown[]) => listWorkItems(...args),
      getWorkItemTrees: (...args: unknown[]) => getWorkItemTrees(...args),
      getWorkItems: vi.fn().mockResolvedValue({ workItems: [] }),
      getDepartments: vi.fn().mockResolvedValue({ departments: [{ slug: "platform", prefix: "TSK", createdAt: "2026-07-01", todoCount: 2 }] }),
      getOrg: vi.fn().mockResolvedValue({ departments: ["platform"], employees: [] }),
      createWorkItem: vi.fn(),
      assignWorkItem: vi.fn(),
      setWorkItemStatus: vi.fn(),
      updateWorkItem: vi.fn(),
    },
  }
})
vi.mock("@/lib/sprint-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sprint-api")>()
  return { ...actual, sprintApi: { ...actual.sprintApi, listSprints: vi.fn().mockResolvedValue({ sprints: [] }) } }
})

function compact(id: string, status: WorkItemStatusWire): WorkItemCompactWire {
  return {
    id, version: 1, title: `Item ${id}`, status, assignee: null, department: "platform", source: "human", sourceRef: null,
    createdBy: "operator", parentId: null, rootId: id, depth: 0, dueAt: null, labels: [], blocked: false,
    updatedAt: "2026-07-31T08:00:00.000Z", rank: null,
  }
}

/** TSK-3 has a sub-Todo; TSK-4 has none. */
function tree(item: WorkItemCompactWire, children: number): WorkItemTreeWire {
  return {
    root: { ...item, rank: null, body: null, priority: 2, rounds: 0, budgetUsd: null, createdAt: item.updatedAt, closedAt: null, children: [] },
    totals: { [item.status]: 1, ...(children ? { backlog: children } : {}) },
    spendUsd: 0,
  }
}

let rows: Partial<Record<WorkItemStatusWire, WorkItemCompactWire[]>> = {}

function Probe() {
  const { pathname, key } = useLocation()
  const navigate = useNavigate()
  return (
    <>
      <span data-testid="where" data-path={pathname} data-key={key} />
      <button type="button" data-testid="history-back" onClick={() => navigate(-1)} />
    </>
  )
}

/** The tab inside the chat route (/chat), one entry after another page, so a back that leaves the board is visible. */
function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/before", "/chat"]} initialIndex={1}>
        <Probe />
        <Routes>
          <Route
            path="/chat"
            element={
              <>
                {/* The same Todo on another board that is also on the page, ahead of this one in the document. */}
                <div data-testid="other-board"><button type="button" data-board-card="TSK-3">other copy</button></div>
                <TodosTabView />
              </>
            }
          />
          <Route path="/before" element={<span />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const originalMatchMedia = window.matchMedia
function setViewport(mobile: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query === "(max-width: 700px)" ? mobile : false,
      media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  sessionStorage.clear()
  clearBoardScrollCache()
  clearTodosTabLocationMemory()
  setViewport(false)
  rows = { backlog: [compact("TSK-4", "backlog")], executing: [compact("TSK-3", "executing")] }
  listWorkItems.mockImplementation((params: { status?: WorkItemStatusWire; needsAttentionFor?: string }) => {
    const items = params.needsAttentionFor ? [] : rows[params.status!] ?? []
    return Promise.resolve({ workItems: items, total: items.length, nextOffset: null, totals: { [params.status!]: items.length } } as WorkItemListWire)
  })
  getWorkItemTrees.mockImplementation((ids: string[]) => {
    const items = Object.values(rows).flat().filter((item): item is WorkItemCompactWire => !!item)
    return Promise.resolve({ trees: Object.fromEntries(ids.map((id) => [id, tree(items.find((item) => item.id === id)!, id === "TSK-3" ? 1 : 0)])) })
  })
})
afterEach(() => {
  Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia })
})

const boardCard = (id: string) => within(screen.getByTestId("todo-board-scroll")).getByTestId(`board-card-${id}`)

async function openFromMenu(id: string) {
  await screen.findByTestId(`board-card-${id}`)
  await waitFor(() => expect(screen.getByTestId(`board-rollup-${id}`)).toBeTruthy())
  fireEvent.contextMenu(screen.getByTestId(`board-card-${id}`), { clientX: 120, clientY: 90 })
  fireEvent.click(await screen.findByTestId("board-card-view-board"))
  return screen.findByTestId("sub-board-dialog")
}

describe("View as board in the Todos tab", () => {
  it("holds the pop-up in memory over the chat route: no history entry, a Todo it opens closes it, focus goes back to this board's card", async () => {
    renderTab()
    const key = () => screen.getByTestId("where").getAttribute("data-key")
    await screen.findByTestId("board-card-TSK-3")
    const before = key()

    const dialog = await openFromMenu("TSK-3")

    expect(dialog.getAttribute("data-root")).toBe("TSK-3")
    // The chat route is not the pop-up's to write; and a Todo chosen inside it closes it before the hand-off.
    expect(key()).toBe(before)
    expect(dialog.getAttribute("data-close-on-open")).toBe("true")
    expect(preload).toHaveBeenCalled()

    // The menu's own refocus (keyboard opens) is not what this is: nothing has focus when the pop-up closes.
    ;(document.activeElement as HTMLElement | null)?.blur()
    fireEvent.click(screen.getByText("Close pop-up"))

    await waitFor(() => expect(screen.queryByTestId("sub-board-dialog")).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(boardCard("TSK-3")))
    expect(document.activeElement).not.toBe(within(screen.getByTestId("other-board")).getByRole("button"))
    expect(key()).toBe(before)
  })

  it("has no row on a card without sub-Todos", async () => {
    renderTab()
    await screen.findByTestId("board-card-TSK-4")
    await waitFor(() => expect(screen.getByTestId("board-rollup-TSK-3")).toBeTruthy())
    fireEvent.contextMenu(screen.getByTestId("board-card-TSK-4"), { clientX: 120, clientY: 90 })
    await screen.findByTestId("board-card-menu")
    expect(screen.queryByTestId("board-card-view-board")).toBeNull()
  })

  it("on a phone, pushes a history entry that Back closes, and a double close does not leave the board", async () => {
    setViewport(true)
    renderTab()
    await screen.findByTestId("board-card-TSK-3")
    await waitFor(() => expect(screen.getByTestId("board-rollup-TSK-3")).toBeTruthy())
    const entry = screen.getByTestId("where").getAttribute("data-key")

    fireEvent.pointerDown(screen.getByTestId("board-move-TSK-3"), { button: 0, ctrlKey: false })
    fireEvent.click(screen.getByTestId("board-move-TSK-3"))
    const row = await screen.findByTestId("board-view-board-TSK-3")
    // Fetched as the menu opens, before the tap that chooses the row.
    expect(preload).toHaveBeenCalled()
    fireEvent.click(row)
    const dialog = await screen.findByTestId("sub-board-dialog")

    expect(dialog.getAttribute("data-close-on-open")).toBe("false")
    expect(screen.getByTestId("where").getAttribute("data-key")).not.toBe(entry)

    // A second close before the first has landed would go back past the board.
    fireEvent.click(screen.getByText("Close pop-up twice"))

    await waitFor(() => expect(screen.queryByTestId("sub-board-dialog")).toBeNull())
    await waitFor(() => expect(screen.getByTestId("where").getAttribute("data-key")).toBe(entry))
    expect(screen.getByTestId("where").getAttribute("data-path")).toBe("/chat")

    // And the browser's Back closes it as well.
    fireEvent.pointerDown(screen.getByTestId("board-move-TSK-3"), { button: 0, ctrlKey: false })
    fireEvent.click(screen.getByTestId("board-move-TSK-3"))
    fireEvent.click(await screen.findByTestId("board-view-board-TSK-3"))
    await screen.findByTestId("sub-board-dialog")
    fireEvent.click(screen.getByTestId("history-back"))
    await waitFor(() => expect(screen.queryByTestId("sub-board-dialog")).toBeNull())
    expect(screen.getByTestId("where").getAttribute("data-path")).toBe("/chat")
  })
})
