import { describe, expect, it } from "vitest"
import { nativeErrorMessage } from "../native-error"

describe("nativeErrorMessage", () => {
  it("reads the message of a serialised native error", () => {
    expect(nativeErrorMessage({ code: "pair-rejected", message: "The pairing code is invalid or expired" }, "x"))
      .toBe("The pairing code is invalid or expired")
  })

  it("keeps Error messages and plain string rejections", () => {
    expect(nativeErrorMessage(new Error("boom"), "x")).toBe("boom")
    expect(nativeErrorMessage("denied", "x")).toBe("denied")
  })

  it("falls back only when the rejection carries no message", () => {
    for (const reason of [undefined, null, 42, {}, { code: "a" }, { message: "  " }, new Error(""), ""]) {
      expect(nativeErrorMessage(reason, "fallback")).toBe("fallback")
    }
  })
})
