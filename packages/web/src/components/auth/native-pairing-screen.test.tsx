import "@/test/preload-dialogs"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { NativeGatewayProfilesSnapshot } from "@/lib/native-gateway-profiles"
import { NativePairingDialog, NativePairingScreen } from "./native-pairing-screen"

const pairAndInstall = vi.fn()
const pairProfile = vi.fn()
const select = vi.fn()
const remove = vi.fn()
const retry = vi.fn()
let snapshot: NativeGatewayProfilesSnapshot | undefined

vi.mock("@/lib/native-gateway-bootstrap", () => ({
  pairAndInstallNativeGateway: (...args: unknown[]) => pairAndInstall(...args),
  pairNativeGatewayProfile: (...args: unknown[]) => pairProfile(...args),
  nativeGatewayProfiles: () => (snapshot
    ? { subscribe: () => () => {}, snapshot: () => snapshot, select, remove, retry }
    : undefined),
}))

const alpha = { id: "alpha", origin: "http://127.0.0.1:7799", name: "Alpha", deviceId: "device:alpha" }
const beta = { id: "beta", origin: "http://127.0.0.1:7800", name: "Beta", deviceId: "device:beta" }

describe("NativePairingScreen", () => {
  beforeEach(() => {
    snapshot = undefined
    for (const spy of [pairAndInstall, pairProfile, select, remove, retry]) spy.mockReset()
  })

  it("pairs an explicit gateway origin and code", async () => {
    pairAndInstall.mockResolvedValue("http://127.0.0.1:7779")
    const onPaired = vi.fn()
    render(<NativePairingScreen onPaired={onPaired} />)
    fireEvent.change(screen.getByLabelText("Pair code"), { target: { value: "ABCD-EFGH" } })
    fireEvent.click(screen.getByRole("button", { name: "Pair gateway" }))
    await waitFor(() => expect(onPaired).toHaveBeenCalledWith("http://127.0.0.1:7779"))
    expect(pairAndInstall).toHaveBeenCalledWith("http://127.0.0.1:7779", "ABCD-EFGH")
  })

  it("shows the shell's own reason when pairing rejects with a { code, message } object", async () => {
    pairAndInstall.mockRejectedValue({ code: "pair-rejected", message: "The pairing code is invalid or expired" })
    render(<NativePairingScreen />)
    fireEvent.change(screen.getByLabelText("Pair code"), { target: { value: "ABCD-EFGH" } })
    fireEvent.click(screen.getByRole("button", { name: "Pair gateway" }))
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("The pairing code is invalid or expired"))
  })

  it("keeps the generic message only for a rejection that carries none", async () => {
    pairAndInstall.mockRejectedValue(undefined)
    render(<NativePairingScreen />)
    fireEvent.change(screen.getByLabelText("Pair code"), { target: { value: "ABCD-EFGH" } })
    fireEvent.click(screen.getByRole("button", { name: "Pair gateway" }))
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("The gateway did not answer"))
  })

  it("offers the other paired gateways when the remembered one stopped answering", async () => {
    snapshot = {
      profiles: [alpha, beta],
      activeId: alpha.id,
      generation: 1,
      status: "unreachable",
      failedProfileId: alpha.id,
      error: "connection refused",
      activeReachable: false,
    }
    select.mockResolvedValue(undefined)
    render(<NativePairingScreen />)

    expect(screen.getByRole("heading", { name: "Cannot reach Alpha" })).toBeTruthy()
    expect(screen.getByRole("alert").textContent).toContain("connection refused")
    expect(screen.getByLabelText("Gateway origin")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Use" }))
    await waitFor(() => expect(select).toHaveBeenCalledWith(beta.id))

    fireEvent.click(screen.getByRole("button", { name: "Remove Beta" }))
    await waitFor(() => expect(remove).toHaveBeenCalledWith(beta.id))
  })

  it("retries the active gateway rather than switching away from it", async () => {
    snapshot = {
      profiles: [alpha],
      activeId: alpha.id,
      generation: 1,
      status: "unreachable",
      failedProfileId: alpha.id,
      activeReachable: false,
    }
    retry.mockResolvedValue(undefined)
    render(<NativePairingScreen />)

    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() => expect(retry).toHaveBeenCalled())
    expect(select).not.toHaveBeenCalled()
  })

  it("keeps naming the unreachable active gateway after a switch to another one fails", () => {
    snapshot = {
      profiles: [alpha, beta],
      activeId: alpha.id,
      generation: 1,
      status: "unreachable",
      // The later failed switch overwrote the record of alpha's own failure.
      failedProfileId: beta.id,
      error: "connection refused",
      activeReachable: false,
    }
    render(<NativePairingScreen />)

    expect(screen.getByRole("heading", { name: "Cannot reach Alpha" })).toBeTruthy()
  })

  it("says why no workspace is open when the saved one is no longer paired, and lists the others to choose from", () => {
    snapshot = {
      profiles: [alpha, beta],
      generation: 0,
      status: "ready",
      activeReachable: false,
      notice: "The workspace you last used is no longer paired. Choose a workspace to continue.",
    }
    render(<NativePairingScreen />)

    expect(screen.getByRole("status").textContent).toContain("no longer paired")
    expect(screen.getByText("Alpha")).toBeTruthy()
    expect(screen.getByText("Beta")).toBeTruthy()
  })

  it("waits on the connecting state while the remembered gateway is being checked", () => {
    snapshot = { profiles: [alpha], activeId: alpha.id, generation: 0, status: "checking", activeReachable: false }
    render(<NativePairingScreen />)
    expect(screen.getByText("Connecting to Alpha...")).toBeTruthy()
    expect(screen.queryByLabelText("Pair code")).toBeNull()
  })
})

describe("NativePairingScreen on a phone", () => {
  beforeEach(() => {
    snapshot = undefined
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15")
  })
  afterEach(() => vi.restoreAllMocks())

  it("starts with an empty origin and asks for an HTTPS address, not this device's loopback", () => {
    render(<NativePairingScreen />)
    const origin = screen.getByLabelText("Gateway origin") as HTMLInputElement
    expect(origin.value).toBe("")
    expect(origin.placeholder).toMatch(/^https:\/\//)
    expect(document.body.textContent).not.toMatch(/127\.0\.0\.1|Mac\b/)
    expect(document.body.textContent).toContain("HTTPS address")
  })

  it("does not pair until an origin is typed", () => {
    render(<NativePairingScreen />)
    fireEvent.change(screen.getByLabelText("Pair code"), { target: { value: "ABCD-EFGH" } })
    expect((screen.getByRole("button", { name: "Pair gateway" }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe("NativePairingDialog", () => {
  beforeEach(() => { pairProfile.mockReset() })
  afterEach(() => vi.restoreAllMocks())

  async function openDialog() {
    render(<NativePairingDialog open onOpenChange={() => {}} />)
    fireEvent.change(await screen.findByLabelText("Pair code"), { target: { value: "ABCD-EFGH" } })
    fireEvent.click(screen.getByRole("button", { name: "Pair gateway" }))
  }

  it("shows the shell's own reason when pairing rejects with a { code, message } object", async () => {
    pairProfile.mockRejectedValue({ code: "insecure-origin", message: "HTTP gateways are allowed only on literal loopback addresses" })
    await openDialog()
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("HTTP gateways are allowed only on literal loopback addresses"))
  })

  it("falls back to Pairing failed when the rejection carries no message", async () => {
    pairProfile.mockRejectedValue({ code: "x" })
    await openDialog()
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Pairing failed"))
  })

  it("starts empty on a phone", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/130 Mobile")
    render(<NativePairingDialog open onOpenChange={() => {}} />)
    expect(((await screen.findByLabelText("Gateway origin")) as HTMLInputElement).value).toBe("")
  })
})
