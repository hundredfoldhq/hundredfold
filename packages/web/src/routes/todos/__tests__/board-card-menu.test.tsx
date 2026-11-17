import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import "@/test/preload-menus"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom"
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

function renderBoard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/todos/b/platform"]}>
        <Routes>
          <Route path="/todos/b/:board" element={<TodoBoardPage />} />
          <Route path="/todos/:todoId" element={<TaskProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
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
})
