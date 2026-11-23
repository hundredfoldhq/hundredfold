import { afterEach, describe, expect, it } from "vitest"

import { loadSettings } from "../settings"

afterEach(() => localStorage.clear())

describe("loadSettings", () => {
  it("drops the retired portalIcon from a saved copy and keeps the portal emoji", () => {
    localStorage.setItem("hundredfold-settings", JSON.stringify({ portalIcon: "★", portalEmoji: "🦊" }))

    const settings = loadSettings()

    expect(settings.portalEmoji).toBe("🦊")
    expect("portalIcon" in settings).toBe(false)
  })

  it("loads a saved copy from the retired floating assistant and ignores its keys", () => {
    localStorage.setItem(
      "hundredfold-settings",
      JSON.stringify({ talkOrb: true, talkOrbVariant: "ring", talkOrbIntensity: "lively", portalEmoji: "🦊", textScale: 1.1 }),
    )

    const settings = loadSettings()

    expect(settings.portalEmoji).toBe("🦊")
    expect(settings.textScale).toBe(1.1)
    for (const key of ["talkOrb", "talkOrbVariant", "talkOrbIntensity"]) expect(key in settings).toBe(false)
  })
})
