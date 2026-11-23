import { describe, expect, it } from "vitest"
import { legacyChatRedirectTarget } from "../legacy-chat-redirect"

describe("legacyChatRedirectTarget", () => {
  it("sends an old /chat/<id> link to the selected-chat route", () => {
    expect(legacyChatRedirectTarget("session-7")).toBe("/?session=session-7")
  })

  it("encodes the id", () => {
    expect(legacyChatRedirectTarget("session 7")).toBe("/?session=session%207")
  })

  it("trims surrounding whitespace", () => {
    expect(legacyChatRedirectTarget("  session-7 ")).toBe("/?session=session-7")
  })

  it("sends a missing, empty or blank id to the chat home", () => {
    expect(legacyChatRedirectTarget(undefined)).toBe("/")
    expect(legacyChatRedirectTarget("")).toBe("/")
    expect(legacyChatRedirectTarget("   ")).toBe("/")
  })
})
