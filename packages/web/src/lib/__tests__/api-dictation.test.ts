import { describe, expect, it, vi } from "vitest"
import { createDictationApi } from "../api-dictation"

const PCM = new Int16Array([1, -2, 3])

describe("transcribeRecording", () => {
  it("posts the samples as a raw body to the gateway's voice transcribe route", async () => {
    const authFetch = vi.fn(async () => new Response(JSON.stringify({ text: "hello" }), { status: 200 }))
    const result = await createDictationApi({ authFetch }).transcribeRecording(PCM)

    expect(result).toEqual({ text: "hello" })
    const [path, init] = authFetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe("/api/voice/transcribe")
    expect(init.method).toBe("POST")
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/octet-stream")
    expect((init.body as Blob).size).toBe(PCM.byteLength)
  })

  it("rejects with the gateway's own message when voice mode cannot transcribe", async () => {
    const authFetch = vi.fn(async () => new Response(JSON.stringify({ error: "Dictation uses voice mode's speech engine; turn voice mode on in Settings first" }), { status: 409 }))
    await expect(createDictationApi({ authFetch }).transcribeRecording(PCM)).rejects.toThrow("turn voice mode on in Settings first")
  })

  it("falls back to the status code when the error body is not JSON", async () => {
    const authFetch = vi.fn(async () => new Response("<html>", { status: 502 }))
    await expect(createDictationApi({ authFetch }).transcribeRecording(PCM)).rejects.toThrow("API error: 502")
  })
})
