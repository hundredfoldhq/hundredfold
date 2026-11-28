import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { NativeGatewayProfilesSnapshot } from "@/lib/native-gateway-profiles"
import { WorkspaceTitle } from "./workspace-title"

const LONG = "Northwind Logistics — Regional Operations and Customer Success (EMEA, long-running programme)"

let snapshot: NativeGatewayProfilesSnapshot
const listeners = new Set<() => void>()
const dismissNotice = vi.fn()
const workspaces = vi.fn<() => { data?: Array<{ displayName: string; name: string; current: boolean }> }>()

vi.mock("@/lib/native-gateway-bootstrap", () => ({
  nativeGatewayProfiles: () => ({
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    snapshot: () => snapshot,
    dismissNotice,
  }),
}))
vi.mock("@/hooks/use-workspaces", () => ({ useWorkspaces: () => workspaces() }))

function native(activeId: string | undefined, notice?: string) {
  snapshot = {
    profiles: [
      { id: "a", origin: "http://127.0.0.1:7779", name: "Alpha", deviceId: "d1" },
      { id: "b", origin: "http://127.0.0.1:7780", name: LONG, deviceId: "d2" },
    ],
    activeId,
    generation: 1,
    status: "ready",
    activeReachable: true,
    notice,
  }
}

describe("WorkspaceTitle", () => {
  beforeEach(() => { dismissNotice.mockReset(); listeners.clear() })
  afterEach(() => { delete window.__HUNDREDFOLD_NATIVE__ })

  describe("in the native app", () => {
    beforeEach(() => { window.__HUNDREDFOLD_NATIVE__ = {} as never })

    it("names the active workspace and follows a switch", () => {
      native("a")
      render(<WorkspaceTitle />)
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Alpha")
      native("b")
      act(() => listeners.forEach((listener) => listener()))
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(LONG)
    })

    it("keeps a long name whole, wrapped on at most three lines, with the full name available", () => {
      native("b")
      render(<WorkspaceTitle />)
      const heading = screen.getByRole("heading", { level: 1 })
      expect(heading.textContent).toBe(LONG)
      expect(heading.getAttribute("title")).toBe(LONG)
      expect(heading.className).toMatch(/line-clamp-3/)
      expect(heading.className).toMatch(/overflow-wrap:anywhere/)
      expect(heading.className).not.toMatch(/\btruncate\b|whitespace-nowrap/)
    })

    it("shows nothing rather than a placeholder when no workspace is active", () => {
      native(undefined)
      const { container } = render(<WorkspaceTitle />)
      expect(container.textContent).toBe("")
    })

    it("tells the person when the app moved them to another workspace, and lets them dismiss it", () => {
      native("a", "Switched to Alpha because Beta was removed.")
      render(<WorkspaceTitle />)
      expect(screen.getByRole("status").textContent).toContain("Switched to Alpha because Beta was removed.")
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
      expect(dismissNotice).toHaveBeenCalledTimes(1)
    })
  })

  describe("in a browser", () => {
    it("names the current workspace from the gateway's list", () => {
      workspaces.mockReturnValue({ data: [
        { displayName: "Other", name: "other", current: false },
        { displayName: "Main company", name: "main", current: true },
      ] })
      render(<WorkspaceTitle />)
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Main company")
    })

    it("shows nothing while the list has not arrived", () => {
      workspaces.mockReturnValue({ data: undefined })
      const { container } = render(<WorkspaceTitle />)
      expect(container.textContent).toBe("")
    })
  })
})
