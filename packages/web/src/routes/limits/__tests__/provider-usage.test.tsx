/** Limits page — the provider's own usage on an opencode card, and why it says "unavailable" instead of 0%. */
import { describe, it, expect, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import type { EngineLimitAccountSnapshot, EngineLimitEngineSnapshot, EngineLimitsResponse, ProviderUsage } from "@/lib/api"

vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

const now = Date.parse("2026-11-22T12:00:00.000Z")
let state: { data: EngineLimitsResponse | null; phase: "ready"; refreshing: boolean; error: string | null; now: number; refresh: () => void }
vi.mock("../use-engine-limits", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../use-engine-limits")>()
  return { ...actual, useEngineLimits: () => state }
})
import LimitsPage from "../page"

const HOUR = 3_600_000
const iso = (ms: number) => new Date(now + ms).toISOString()
const engine = (over: Partial<EngineLimitEngineSnapshot> = {}): EngineLimitEngineSnapshot => ({
  name: "opencode", available: true, status: "snapshot", source: "x", refreshedAt: iso(0), models: [], ...over,
})
const account = (over: Partial<EngineLimitAccountSnapshot> = {}): EngineLimitAccountSnapshot => ({
  ...engine(), account: "go-a", label: "Go account", location: { kind: "local" }, employees: [], provider: "opencode-go", ...over,
})
const win = (name: string, mins: number, pct: number, over: object = {}) => ({ name, windowDurationMins: mins, usedPercent: pct, resetsAtIso: iso(2 * HOUR), ...over })
const OK: ProviderUsage = {
  provider: "opencode-go",
  source: "OpenCode Go usage API", status: "ok", fetchedAt: iso(0),
  windows: [win("5h", 300, 30), win("7d", 10080, 100, { limited: true }), win("30d", 43200, 50)],
}
const UNAVAILABLE: ProviderUsage = {
  provider: "opencode-go",
  source: "OpenCode Go usage API", status: "unavailable", fetchedAt: iso(0),
  unavailable: { code: "forbidden", message: "OpenCode Go refused the request (403): the key is not covered or the region is restricted." },
}
// What the ledger meters when opencode 2.x records $0 a turn: a window that would read as a measured 0%.
const LEDGER = [{ id: "opencode-go/flash", windows: [win("5h", 300, 0), win("7d", 10080, 0), win("30d", 43200, 0)] }]

function show(engineOver: Partial<EngineLimitEngineSnapshot>, accounts?: EngineLimitAccountSnapshot[]) {
  state = {
    phase: "ready", refreshing: false, error: null, now, refresh: () => {},
    data: { generatedAt: iso(0), default: "claude", engines: { opencode: engine(engineOver) }, ...(accounts ? { accounts: { opencode: accounts } } : {}) },
  }
  return render(<LimitsPage />)
}
const card = (title: string) => screen.getByRole("heading", { level: 2, name: title }).closest("article") as HTMLElement

describe("LimitsPage — provider-reported opencode usage", () => {
  it("shows an account's provider windows with their percentages and resets, and leaves out the ledger's zero beside them", () => {
    show({}, [account({ providerUsage: OK, buckets: LEDGER })])
    const panel = within(card("Go account")).getByTestId("provider-usage")
    expect(panel.textContent).toContain("30%")
    expect(panel.textContent).toContain("100%")
    expect(panel.textContent).toContain("50%")
    expect(panel.textContent).toContain("resets in 2h")
    expect(within(card("Go account")).queryByTestId("model-buckets")).toBeNull()
  })

  it("prices the month in dollars only when the gateway sent them", () => {
    show({}, [account({ providerUsage: { ...OK, monthlyLimitUsd: 60, consumedUsd: 30, remainingUsd: 30 } })])
    expect(within(card("Go account")).getByTestId("usage-dollars").textContent).toBe("$30 of $60 used this month · $30 left")
  })

  it("has no dollar line for a reading without an allowance", () => {
    show({}, [account({ providerUsage: OK })])
    expect(within(card("Go account")).queryByTestId("usage-dollars")).toBeNull()
  })

  it("says usage is unavailable, and why, instead of showing the ledger's 0% as a reading", () => {
    show({}, [account({ status: "snapshot", providerUsage: UNAVAILABLE, buckets: LEDGER })])
    const c = card("Go account")
    expect(within(c).getByTestId("usage-unavailable").textContent).toContain("region is restricted")
    expect(c.textContent).toContain("Usage unavailable")
    // The ledger's figures stay, named as an estimate, never as the provider's.
    expect(within(c).getByTestId("local-estimate").textContent).toContain("Local estimate")
    expect(within(c).queryByTestId("provider-usage")).toBeNull()
  })

  it("shows the unavailable reason alone when there is no ledger to fall back on", () => {
    show({}, [account({ status: "unsupported", providerUsage: UNAVAILABLE, buckets: [] })])
    const c = card("Go account")
    expect(within(c).getByTestId("usage-unavailable")).toBeTruthy()
    expect(within(c).queryByTestId("local-estimate")).toBeNull()
    expect(c.textContent).not.toContain("0%")
  })

  it("renders the engine's own card from its provider reading when no account covers the provider, keeping other providers' buckets", () => {
    show({
      defaultModel: "opencode-go/flash", providerUsage: OK,
      buckets: [...LEDGER, { id: "openrouter/x", windows: [win("30d", 43200, 7)] }],
    })
    const c = card("opencode")
    expect(within(c).getByTestId("provider-usage").textContent).toContain("30%")
    const buckets = Array.from(c.querySelectorAll("[data-bucket]")).map((el) => el.getAttribute("data-bucket"))
    expect(buckets).toEqual(["openrouter/x"])
  })

  it("badges the card as usage unavailable, and drops the engine's own not-metered copy, when the reading failed", () => {
    show({ status: "unsupported", defaultModel: "opencode-go/flash", providerUsage: UNAVAILABLE, unsupportedReason: "No allowance is configured to meter this." })
    const c = card("opencode")
    expect(within(c).getAllByText("Usage unavailable")).toHaveLength(1)
    expect(within(c).queryByText(/No allowance is configured/)).toBeNull()
  })

  it("keeps showing the ledger buckets of a card with no provider reading at all", () => {
    show({ buckets: LEDGER, windows: LEDGER[0]!.windows })
    const c = card("opencode")
    expect(Array.from(c.querySelectorAll("[data-bucket]")).map((el) => el.getAttribute("data-bucket"))).toEqual(["opencode-go/flash"])
    expect(within(c).queryByTestId("provider-usage")).toBeNull()
  })
})
