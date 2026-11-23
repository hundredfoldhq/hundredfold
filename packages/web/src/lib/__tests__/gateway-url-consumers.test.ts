import { afterEach, describe, expect, it, vi } from "vitest"
import { api } from "../api"
import { createBrowserGatewayTransport, installGatewayTransport } from "../gateway-transport"

let restoreTransport: (() => void) | null = null

afterEach(() => {
  restoreTransport?.()
  restoreTransport = null
})

describe("gateway URL consumers", () => {
  it("builds attachment URLs from the active profile", () => {
    restoreTransport = installGatewayTransport(createBrowserGatewayTransport({
      origin: "https://qa-a.example:7779",
      request: vi.fn(),
      navigate: vi.fn(),
    }))

    expect(api.workItemAttachmentUrl("TSK-12", "attachment 1")).toBe(
      "https://qa-a.example:7779/api/work-items/TSK-12/attachments/attachment%201",
    )
  })
})
