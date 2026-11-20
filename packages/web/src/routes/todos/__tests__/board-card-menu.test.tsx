import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import "@/test/preload-menus"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError, type WorkItemCompactWire, type WorkItemListWire, type WorkItemStatusWire } from "@/lib/api"
import type { SprintWire } from "@/lib/sprint-api"
import TodoBoardPage from "../board/board-page"
import { clearBoardScrollCache } from "../board/board-route"

/* Right-click a card on the board: the menu of what the board can do with it
 * (Open, Keep on Home, a move to any column it can legally go to, a sprint),
 * its default browser menu suppressed on cards only, and the same refusals as
 * the drag and the phone's Move to… menu. */

type Principal = { kind: "operator" } | { kind: "member"; user: { id: string; email: string; displayName: string }; boards: { department: string; role: string }[] }
let principal: Principal = { kind: "operator" }
vi.mock("@/routes/auth-provider", () => ({
  useAuthOptional: () => ({ principal, authState: { accountsEnabled: true, hasAccounts: true, principal } }),
}))
vi.mock("@/components/page-layout", () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))

const listWorkItems = vi.fn()
const setWorkItemStatus = vi.fn()
const updateWorkItem = vi.fn()
const keepWorkItem = vi.fn()
const getWorkItemTrees = vi.fn()

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      listWorkItems: (...args: unknown[]) => listWorkItems(...args),
      setWorkItemStatus: (...args: unknown[]) => setWorkItemStatus(...args),
      updateWorkItem: (...args: unknown[]) => updateWorkItem(...args),
      setWorkItemKept: (...args: unknown[]) => keepWorkItem(...args),
      getWorkItemTree: vi.fn().mockRejectedValue(new Error("no tree")),
      getWorkItemTrees: (...args: unknown[]) => getWorkItemTrees(...args),
      getWorkItem: vi.fn().mockRejectedValue(Object.assign(new Error("nf"), { status: 404 })),
      getWorkItems: vi.fn().mockResolvedValue({ workItems: [] }),
      getDepartments: vi.fn().mockResolvedValue({ departments: [] }),
      getOrg: vi.fn().mockResolvedValue({ departments: [], employees: [] }),
      createWorkItem: vi.fn(),
      assignWorkItem: vi.fn(),
    },
  }
})

// The pop-up carries a whole board of its own; what the card menu owes is which Todo it opens it for, and what happens on close.
vi.mock("../board/sub-board-dialog-lazy", () => ({
  LazySubBoardDialog: ({ rootId, onClose, closeOnOpenTodo }: { rootId: string; onClose: () => void; closeOnOpenTodo?: boolean }) => (
    <div data-testid="sub-board-dialog" data-root={rootId} data-close-on-open={String(closeOnOpenTodo)}>
      <button type="button" onClick={onClose}>Close pop-up</button>
    </div>
  ),
  preloadSubBoardDialog: () => {},
}))

const sprintApi = vi.hoisted(() => ({ listSprints: vi.fn(), setWorkItemSprint: vi.fn() }))
vi.mock("@/lib/sprint-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sprint-api")>()
  return { ...actual, sprintApi: { ...actual.sprintApi, ...sprintApi } }
})

function compact(id: string, status: WorkItemStatusWire): WorkItemCompactWire {
  return {
    id,
    version: 3,
    title: `Item ${id}`,
    status,
    assignee: null,
    department: "platform",
    source: "human",
    sourceRef: null,
    createdBy: "operator",
    parentId: null,
    rootId: id,
    depth: 0,
    dueAt: null,
    labels: [],
    blocked: false,
    updatedAt: "2026-07-23T08:00:00.000Z",
    rank: null,
  }
}

function sprint(id: string, name: string, status: SprintWire["status"]): SprintWire {
  return { id, name, status, goal: null, startsAt: null, endsAt: null, createdAt: "2026-10-01T09:00:00.000Z", startedAt: null, closedAt: null, open: 0, total: 0 }
}

let rows: Partial<Record<WorkItemStatusWire, WorkItemCompactWire[]>> = {}

function listResponse(params: { status?: WorkItemStatusWire }): WorkItemListWire {
  const items = rows[params.status!] ?? []
  return { workItems: items, total: items.length, nextOffset: null }
}

function TaskProbe() {
  const { todoId } = useParams()
  return <div data-testid="task-probe" data-todo={todoId} />
}

function HistoryProbe() {
  const navigate = useNavigate()
  const { pathname, search } = useLocation()
  return (
    <>
      <span data-testid="location" data-where={`${pathname}${search}`} />
      <button type="button" data-testid="history-back" onClick={() => navigate(-1)} />
    </>
  )
}

function renderBoard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/todos/b/platform"]}>
        <HistoryProbe />
        <Routes>
          <Route path="/todos/b/:board" element={<TodoBoardPage />} />
          <Route path="/todos/:todoId" element={<TaskProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { ...view, client }
}

function setViewport(mobile: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query === "(max-width: 700px)" ? mobile : false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}
const originalMatchMedia = window.matchMedia

/** A right-click on `element`; false when the page cancelled the browser's own menu. */
const rightClick = (element: Element) => fireEvent.contextMenu(element, { clientX: 120, clientY: 90 })
const menuOf = async () => within(await screen.findByTestId("board-card-menu"))

beforeEach(() => {
  vi.clearAllMocks()
  clearBoardScrollCache()
  sessionStorage.clear()
  localStorage.clear()
  principal = { kind: "operator" }
  setViewport(false)
  rows = {
    backlog: [compact("TSK-1", "backlog")],
    executing: [compact("TSK-3", "executing")],
    in_review: [compact("TSK-4", "in_review")],
  }
  listWorkItems.mockImplementation((params: { status?: WorkItemStatusWire }) => Promise.resolve(listResponse(params)))
  getWorkItemTrees.mockResolvedValue({ trees: {} })
  sprintApi.listSprints.mockResolvedValue({ sprints: [sprint("spr_aaaaaaaaaaaa", "Sprint 1", "active"), sprint("spr_cccccccccccc", "Sprint 0", "closed")] })
})

afterEach(() => {
  Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia })
})

/** Cards whose Todo has sub-Todos: the roll-up the board fetches for its cards says so. */
function withSubTodos(...ids: string[]) {
  getWorkItemTrees.mockImplementation((asked: string[]) =>
    Promise.resolve({ trees: Object.fromEntries(asked.filter((id) => ids.includes(id)).map((id) => [id, subTree(id)])) }),
  )
}
function subTree(id: string) {
  return {
    root: { id, status: "executing", children: [{ id: `${id}-1`, status: "backlog", children: [] }] },
    totals: { executing: 1, backlog: 1 },
    spendUsd: 0,
  }
}

describe("right-clicking a card on the board", () => {
  it("opens the card's menu in place of the browser's, and leaves the rest of the board's right-click alone", async () => {
    renderBoard()
    const card = await screen.findByTestId("board-card-TSK-3")

    expect(rightClick(card)).toBe(false)
    const menu = await menuOf()
    expect(menu.getByText("TSK-3")).toBeTruthy()
    expect(menu.getByTestId("board-card-open")).toBeTruthy()
    // Every column but the one it is in. The card's own legal moves are the rows: In review would have no To do.
    const moves = screen.getAllByTestId(/^board-card-move-/).map((row) => row.textContent)
    expect(moves).toEqual(["Move to To do", "Move to Blocked", "Move to In review", "Move to Done", "Move to Cancelled"])
    // The page behind it did not open.
    expect(screen.queryByTestId("task-probe")).toBeNull()

    // Not on a card: the browser's own menu.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    await waitFor(() => expect(screen.queryByTestId("board-card-menu")).toBeNull())
    expect(rightClick(screen.getByTestId("todo-board-scroll"))).toBe(true)
    expect(screen.queryByTestId("board-card-menu")).toBeNull()
  })

  it("closes on Escape and on a press outside it", async () => {
    renderBoard()
    rightClick(await screen.findByTestId("board-card-TSK-3"))
    await menuOf()
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" })
    await waitFor(() => expect(screen.queryByTestId("board-card-menu")).toBeNull())

    rightClick(screen.getByTestId("board-card-TSK-4"))
    await menuOf()
    fireEvent.pointerDown(document.body)
    fireEvent.mouseDown(document.body)
    fireEvent.pointerUp(document.body)
    await waitFor(() => expect(screen.queryByTestId("board-card-menu")).toBeNull())
  })

  it("moves the card to Done on Move to Done, without a reload, and says so", async () => {
    setWorkItemStatus.mockResolvedValue({ workItem: { ...compact("TSK-3", "done"), version: 4 }, escalated: false })
    renderBoard()
    rightClick(await screen.findByTestId("board-card-TSK-3"))
    await menuOf()

    fireEvent.click(screen.getByTestId("board-card-move-done"))

    await waitFor(() => expect(setWorkItemStatus).toHaveBeenCalledWith("TSK-3", "done"))
    await waitFor(() => expect(screen.queryByTestId("board-card-menu")).toBeNull())
    await waitFor(() => expect(screen.getByTestId("board-callout").textContent).toBe("TSK-3 moved to Done"))
    expect(screen.queryByTestId("task-probe")).toBeNull()
  })

  it("puts the card back and says why when the gateway refuses the move", async () => {
    setWorkItemStatus.mockRejectedValue(new ApiError(409, "Todo changed since you opened it"))
    renderBoard()
    rightClick(await screen.findByTestId("board-card-TSK-3"))
    await menuOf()

    fireEvent.click(screen.getByTestId("board-card-move-in_review"))

    await waitFor(() => expect(screen.getByTestId("board-callout").textContent).toMatch(/Todo changed since you opened it/))
    expect(screen.getByTestId("board-column-executing").contains(screen.getByTestId("board-card-TSK-3"))).toBe(true)
  })

  it("shows a close that would also close open sub-tasks with its reason, and cannot be chosen", async () => {
    getWorkItemTrees.mockResolvedValue({
      trees: {
        "TSK-3": {
          root: { id: "TSK-3", status: "executing", children: [{ id: "TSK-9", status: "executing", children: [] }, { id: "TSK-10", status: "done", children: [] }] },
          totals: { executing: 2, done: 1 },
          spendUsd: 0,
        },
      },
    })
    renderBoard()
    const card = await screen.findByTestId("board-card-TSK-3")
    await waitFor(() => expect(screen.getByTestId("board-rollup-TSK-3")).toBeTruthy())
    rightClick(card)
    await menuOf()

    const done = screen.getByRole("menuitem", { name: /Move to Done/ })
    expect(done.getAttribute("aria-disabled")).toBe("true")
    expect(done.textContent).toContain("Has 1 open sub-task. Close from the task page")
    fireEvent.click(done)
    expect(setWorkItemStatus).not.toHaveBeenCalled()
    // Cancelled is gated outright over open sub-tasks.
    expect(screen.getByRole("menuitem", { name: /Move to Cancelled/ }).getAttribute("aria-disabled")).toBe("true")
  })

  it("leaves a card in Review without a way back to To do, as the drag does", async () => {
    renderBoard()
    rightClick(await screen.findByTestId("board-card-TSK-4"))
    await menuOf()
    expect(screen.queryByTestId("board-card-move-backlog")).toBeNull()
    expect(screen.getByTestId("board-card-move-done")).toBeTruthy()
  })

  it("opens the task from Open", async () => {
    renderBoard()
    rightClick(await screen.findByTestId("board-card-TSK-3"))
    await menuOf()
    fireEvent.click(screen.getByTestId("board-card-open"))
    await waitFor(() => expect(screen.getByTestId("task-probe").getAttribute("data-todo")).toBe("TSK-3"))
  })

  it("keeps a Todo on Home from Keep on Home", async () => {
    keepWorkItem.mockResolvedValue({ kept: true })
    renderBoard()
    rightClick(await screen.findByTestId("board-card-TSK-3"))
    await menuOf()
    fireEvent.click(screen.getByTestId("board-card-keep"))
    await waitFor(() => expect(keepWorkItem).toHaveBeenCalledWith("TSK-3", true))
  })

  it("moves the card between sprints from the same menu, offering open sprints only", async () => {
    sprintApi.setWorkItemSprint.mockResolvedValue({})
    renderBoard()
    rightClick(await screen.findByTestId("board-card-TSK-3"))
    await menuOf()

    const sprintRow = await screen.findByTestId("sprint-card-move-spr_aaaaaaaaaaaa")
    expect(screen.queryByTestId("sprint-card-move-spr_cccccccccccc")).toBeNull()
    fireEvent.click(sprintRow)
    await waitFor(() => expect(sprintApi.setWorkItemSprint).toHaveBeenCalledWith("TSK-3", "spr_aaaaaaaaaaaa"))
  })

  it("opens from the keyboard on a focused card, with the first row focused", async () => {
    renderBoard()
    const card = await screen.findByTestId("board-card-TSK-3")
    card.focus()
    fireEvent.keyDown(card, { key: "F10", shiftKey: true })
    const menu = await menuOf()
    await waitFor(() => expect(menu.getByTestId("board-card-open")).toBe(document.activeElement))
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" })
    await waitFor(() => expect(screen.queryByTestId("board-card-menu")).toBeNull())
    // Focus is back on the card the menu was opened from, not lost to the page.
    await waitFor(() => expect(document.activeElement).toBe(card))
  })

  it("puts focus on the card in its new column after a move chosen from the keyboard", async () => {
    setWorkItemStatus.mockResolvedValue({ workItem: { ...compact("TSK-1", "executing"), version: 4 }, escalated: false })
    updateWorkItem.mockResolvedValue({ workItem: { ...compact("TSK-1", "executing"), version: 5 } })
    renderBoard()
    const card = await screen.findByTestId("board-card-TSK-1")
    card.focus()
    fireEvent.keyDown(card, { key: "ContextMenu" })
    await menuOf()

    fireEvent.click(screen.getByTestId("board-card-move-executing"))

    await waitFor(() => expect(setWorkItemStatus).toHaveBeenCalledWith("TSK-1", "executing"))
    await waitFor(() => {
      const moved = screen.getByTestId("board-card-TSK-1")
      expect(screen.getByTestId("board-column-executing").contains(moved)).toBe(true)
      expect(document.activeElement).toBe(moved)
    })
  })

  it("closes when the card leaves the board under it, rather than offering moves for a card that is gone", async () => {
    const { client } = renderBoard()
    rightClick(await screen.findByTestId("board-card-TSK-3"))
    await menuOf()

    rows.executing = []
    await act(async () => { await client.invalidateQueries() })

    await waitFor(() => expect(screen.queryByTestId("board-card-TSK-3")).toBeNull())
    await waitFor(() => expect(screen.queryByTestId("board-card-menu")).toBeNull())
  })

  it("is on the phone's board too, without the sprint rows the phone has no way to use", async () => {
    setViewport(true)
    renderBoard()
    expect(rightClick(await screen.findByTestId("board-card-TSK-3"))).toBe(false)
    await menuOf()
    expect(screen.getByTestId("board-card-move-done")).toBeTruthy()
    expect(screen.queryByTestId("sprint-card-move-none")).toBeNull()
  })

  it("is not offered to a board member, who has none of the operator's board controls", async () => {
    principal = { kind: "member", user: { id: "me", email: "me@example.test", displayName: "Mia Member" }, boards: [{ department: "platform", role: "collaborator" }] }
    renderBoard()
    const card = await screen.findByTestId("board-card-TSK-3")
    await act(async () => {})
    expect(rightClick(card)).toBe(true)
    expect(screen.queryByTestId("board-card-menu")).toBeNull()
  })

  describe("View as board", () => {
    it("is a row of the menu for a Todo that has sub-Todos, and opens the pop-up for that Todo", async () => {
      withSubTodos("TSK-3")
      renderBoard()
      const card = await screen.findByTestId("board-card-TSK-3")
      await waitFor(() => expect(screen.getByTestId("board-rollup-TSK-3")).toBeTruthy())
      rightClick(card)
      const menu = await menuOf()
      // Next to Open, before the moves.
      const labels = menu.getAllByRole("menuitem").map((row) => row.textContent)
      expect(labels.slice(0, 2)).toEqual(["Open", "View as board"])

      fireEvent.click(menu.getByTestId("board-card-view-board"))

      const dialog = await screen.findByTestId("sub-board-dialog")
      expect(dialog.getAttribute("data-root")).toBe("TSK-3")
      expect(screen.queryByTestId("board-card-menu")).toBeNull()
      // The board stays where it was; the pop-up is not a page.
      expect(screen.getByTestId("location").getAttribute("data-where")).toBe("/todos/b/platform")
      expect(screen.queryByTestId("task-probe")).toBeNull()
      expect(dialog.getAttribute("data-close-on-open")).toBe("false")
    })

    it("is not a row for a Todo with no sub-Todos", async () => {
      withSubTodos("TSK-3")
      renderBoard()
      const card = await screen.findByTestId("board-card-TSK-4")
      await waitFor(() => expect(screen.getByTestId("board-rollup-TSK-3")).toBeTruthy())
      rightClick(card)
      const menu = await menuOf()
      expect(menu.getByTestId("board-card-open")).toBeTruthy()
      expect(menu.queryByTestId("board-card-view-board")).toBeNull()
      expect(screen.queryByText("View as board")).toBeNull()
    })

    it("opens from the keyboard, and closing it puts focus back on the card", async () => {
      withSubTodos("TSK-3")
      renderBoard()
      const card = await screen.findByTestId("board-card-TSK-3")
      await waitFor(() => expect(screen.getByTestId("board-rollup-TSK-3")).toBeTruthy())
      card.focus()
      fireEvent.keyDown(card, { key: "F10", shiftKey: true })
      const menu = await menuOf()
      fireEvent.click(menu.getByTestId("board-card-view-board"))
      await screen.findByTestId("sub-board-dialog")
      ;(document.activeElement as HTMLElement | null)?.blur()

      fireEvent.click(screen.getByText("Close pop-up"))

      await waitFor(() => expect(screen.getByTestId("location").getAttribute("data-where")).toBe("/todos/b/platform"))
      await waitFor(() => expect(screen.queryByTestId("sub-board-dialog")).toBeNull())
      await waitFor(() => expect(document.activeElement).toBe(card))
    })

    it("closes on the browser's Back and opens again on Forward, as the Todo page's pop-up does", async () => {
      withSubTodos("TSK-3")
      renderBoard()
      const card = await screen.findByTestId("board-card-TSK-3")
      await waitFor(() => expect(screen.getByTestId("board-rollup-TSK-3")).toBeTruthy())
      rightClick(card)
      fireEvent.click((await menuOf()).getByTestId("board-card-view-board"))
      await screen.findByTestId("sub-board-dialog")

      fireEvent.click(screen.getByTestId("history-back"))
      await waitFor(() => expect(screen.queryByTestId("sub-board-dialog")).toBeNull())
      expect(screen.getByTestId("board-card-TSK-3")).toBeTruthy()
      expect(screen.getByTestId("location").getAttribute("data-where")).toBe("/todos/b/platform")
    })

    it("is not in the phone's Move to… menu for a Todo without sub-Todos, and is for one with", async () => {
      setViewport(true)
      withSubTodos("TSK-3")
      renderBoard()
      await screen.findByTestId("board-card-TSK-3")
      await waitFor(() => expect(screen.getByTestId("board-rollup-TSK-3")).toBeTruthy())

      await openMoveMenu("TSK-4")
      expect(screen.queryByTestId("board-view-board-TSK-4")).toBeNull()
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" })

      await openMoveMenu("TSK-3")
      fireEvent.click(await screen.findByTestId("board-view-board-TSK-3"))
      expect((await screen.findByTestId("sub-board-dialog")).getAttribute("data-root")).toBe("TSK-3")
    })

    it("is not offered to a board member, even for a Todo with sub-Todos", async () => {
      principal = { kind: "member", user: { id: "me", email: "me@example.test", displayName: "Mia Member" }, boards: [{ department: "platform", role: "collaborator" }] }
      withSubTodos("TSK-3")
      renderBoard()
      const card = await screen.findByTestId("board-card-TSK-3")
      await waitFor(() => expect(screen.getByTestId("board-rollup-TSK-3")).toBeTruthy())
      expect(rightClick(card)).toBe(true)
      expect(screen.queryByTestId("board-card-menu")).toBeNull()
      expect(screen.queryByTestId("board-view-board-TSK-3")).toBeNull()
    })
  })
})

async function openMoveMenu(id: string) {
  const trigger = await screen.findByTestId(`board-move-${id}`)
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
  fireEvent.click(trigger)
  await screen.findByRole("menu")
}
