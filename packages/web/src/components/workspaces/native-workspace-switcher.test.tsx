import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkspaceInfo } from "@/lib/api"
import type { NativeGatewayProfilesSnapshot } from "@/lib/native-gateway-profiles"
import { NativeWorkspaceSwitcher } from "./native-workspace-switcher"

const select = vi.fn()
const remove = vi.fn()
const snapshot: NativeGatewayProfilesSnapshot = {
  profiles: [
    { id: "alpha", origin: "http://127.0.0.1:7799", name: "Alpha", deviceId: "device:alpha" },
    { id: "beta", origin: "http://127.0.0.1:7800", name: "Beta", deviceId: "device:beta" },
  ],
  activeId: "alpha",
  generation: 1,
  status: "ready",
  activeReachable: true,
}

vi.mock("@/lib/native-gateway-bootstrap", () => ({
  nativeGatewayProfiles: () => ({ subscribe: () => () => {}, snapshot: () => snapshot, select, remove }),
}))
vi.mock("@/components/auth/native-pairing-screen", () => ({ NativePairingDialog: () => null }))

function Launcher({ workspaces, onStart, onRemove, startError }: {
  workspaces: WorkspaceInfo[]
  onStart: (workspace: WorkspaceInfo) => void
  onRemove?: (workspace: WorkspaceInfo) => void
  startError?: { id: string; message: string } | null
}) {
  const beta = workspaces.find((workspace) => workspace.id === "beta")!
  return (
    <div>
      <button type="button" onClick={() => onStart(beta)}>start beta</button>
      <button type="button" onClick={() => onRemove?.(beta)}>remove beta</button>
      {startError && <p role="alert">{startError.message}</p>}
    </div>
  )
}

describe("NativeWorkspaceSwitcher", () => {
  beforeEach(() => {
    select.mockReset()
    remove.mockReset()
  })

  it("shows the shell's own reason when a switch rejects with a { code, message } object", async () => {
    select.mockRejectedValue({ code: "transport-failed", message: "The gateway request failed" })
    render(<NativeWorkspaceSwitcher Launcher={Launcher} />)
    fireEvent.click(screen.getByRole("button", { name: "start beta" }))
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("The gateway request failed"))
  })

  it("shows the shell's own reason when removing a gateway rejects with a { code, message } object", async () => {
    remove.mockRejectedValue({ code: "credential-store", message: "The OS credential store is unavailable" })
    render(<NativeWorkspaceSwitcher Launcher={Launcher} />)
    fireEvent.click(screen.getByRole("button", { name: "remove beta" }))
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("The OS credential store is unavailable"))
  })

  it("keeps the generic text for a rejection that carries no message", async () => {
    select.mockRejectedValue({ code: "x" })
    render(<NativeWorkspaceSwitcher Launcher={Launcher} />)
    fireEvent.click(screen.getByRole("button", { name: "start beta" }))
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Gateway is unreachable"))
  })
})
