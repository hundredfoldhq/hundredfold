import { act, fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const stt = vi.hoisted(() => ({
  state: "idle",
  analyser: null,
  error: null as string | null,
  unavailableReason: null as string | null,
  handleMicClick: vi.fn(),
  startRecording: vi.fn(),
  stopRecording: vi.fn<() => Promise<string | null>>(),
  cancelRecording: vi.fn(),
  dismissUnavailable: vi.fn(),
  dismissError: vi.fn(),
}))

const useSttMock = vi.hoisted(() => vi.fn(() => stt))

vi.mock("@/hooks/use-stt", () => ({ useStt: useSttMock }))

import { NoteMic } from "../note-mic"

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  stt.state = "idle"
  stt.error = null
  stt.unavailableReason = null
  stt.stopRecording.mockResolvedValue("dictated words")
})

afterEach(() => vi.useRealTimers())

describe("NoteMic", () => {
  it("hands the transcript callback to useStt", () => {
    const onTranscript = vi.fn()
    render(<NoteMic onTranscript={onTranscript} />)

    expect(useSttMock).toHaveBeenCalledWith(onTranscript)
  })

  it("renders a 52px bottom-centered control with press feedback and no send action", () => {
    render(<NoteMic onTranscript={vi.fn()} />)
    const button = screen.getByRole("button", { name: "Voice input" })
    expect(button.className).toContain("size-[52px]")
    expect(button.className).toContain("active:scale-[0.96]")
    expect(button.closest("[data-note-mic-anchor]")).toBeTruthy()
    expect(screen.queryByRole("button", { name: /send/i })).toBeNull()
  })

  it("expands into a recording waveform pill, with no language switch: the language is voice mode's", () => {
    stt.state = "recording"
    render(<NoteMic onTranscript={vi.fn()} />)

    const button = screen.getByRole("button", { name: "Stop recording" })
    expect(button.className).toContain("w-[136px]")
    expect(screen.queryByRole("button", { name: /transcription language/i })).toBeNull()
  })

  it("explains that dictation needs voice mode, and how to get there, when its speech engine is not ready", () => {
    stt.state = "unavailable"
    stt.unavailableReason = "Dictation uses voice mode's speech engine. Turn voice mode on in Settings to use it."
    render(<MemoryRouter><NoteMic onTranscript={vi.fn()} /></MemoryRouter>)

    expect(screen.getByRole("dialog", { name: "Dictation needs voice mode" })).toBeTruthy()
    expect(screen.getByText(/Turn voice mode on in Settings/)).toBeTruthy()
    expect(screen.getByRole("link", { name: "Open settings" }).getAttribute("href")).toBe("/settings")
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    expect(stt.dismissUnavailable).toHaveBeenCalledTimes(1)
  })

  it("uses quick tap to toggle and hold release to insert the returned transcript", async () => {
    const onTranscript = vi.fn()
    const { rerender } = render(<NoteMic onTranscript={onTranscript} />)
    const idle = screen.getByRole("button", { name: "Voice input" })

    fireEvent.pointerDown(idle, { pointerId: 1 })
    fireEvent.pointerUp(idle, { pointerId: 1 })
    expect(stt.handleMicClick).toHaveBeenCalledTimes(1)
    expect(stt.stopRecording).not.toHaveBeenCalled()

    stt.state = "recording"
    rerender(<NoteMic onTranscript={onTranscript} />)
    const recording = screen.getByRole("button", { name: "Stop recording" })
    fireEvent.pointerDown(recording, { pointerId: 2 })
    await act(async () => vi.advanceTimersByTimeAsync(400))
    fireEvent.pointerUp(recording, { pointerId: 2 })
    await act(async () => {})

    expect(stt.stopRecording).toHaveBeenCalledTimes(1)
    expect(onTranscript).toHaveBeenCalledWith("dictated words")
  })
})
