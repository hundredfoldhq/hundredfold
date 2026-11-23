import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const getVoiceConfig = vi.fn()
const transcribeRecording = vi.fn()
const recordingToPcm16 = vi.fn()

vi.mock("@/lib/api", () => ({
  api: {
    getVoiceConfig: () => getVoiceConfig(),
    transcribeRecording: (pcm: Int16Array) => transcribeRecording(pcm),
  },
}))
vi.mock("@/lib/recording-pcm", () => ({
  recordingToPcm16: (blob: Blob) => recordingToPcm16(blob),
}))

const READY = { enabled: true, available: true, stt: { provider: "local", status: { available: true } } }
const PCM = new Int16Array([1, 2, 3])

import { useStt } from "../use-stt"

class FakeAudioContext {
  state: AudioContextState = "running"
  close = vi.fn(async () => {
    this.state = "closed"
  })
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn() }))
  createAnalyser = vi.fn(() => ({
    fftSize: 0,
  }))
}

class FakeMediaRecorder {
  static isTypeSupported = vi.fn((type: string) => type === "audio/webm;codecs=opus")

  state: RecordingState = "inactive"
  mimeType = "audio/webm;codecs=opus"
  ondataavailable: ((event: BlobEvent) => void) | null = null
  onstop: ((event: Event) => void) | null = null

  constructor(
    _stream: MediaStream,
    opts?: MediaRecorderOptions,
  ) {
    if (opts?.mimeType) this.mimeType = opts.mimeType
  }

  start() {
    this.state = "recording"
  }

  stop() {
    this.state = "inactive"
    this.ondataavailable?.({ data: new Blob(["voice"], { type: this.mimeType }) } as BlobEvent)
    this.onstop?.(new Event("stop"))
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createFakeStream() {
  const track = { stop: vi.fn() }
  const stream = {
    getTracks: () => [track],
  } as unknown as MediaStream
  return { stream, track }
}

function installMediaMocks(options?: { getUserMedia?: () => Promise<MediaStream> }) {
  const { stream, track } = createFakeStream()
  const getUserMedia = vi.fn(options?.getUserMedia ?? (() => Promise.resolve(stream)))
  const audioSession = { type: "auto" }

  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia },
    configurable: true,
  })
  Object.defineProperty(navigator, "audioSession", {
    value: audioSession,
    configurable: true,
  })
  Object.defineProperty(window, "AudioContext", {
    value: FakeAudioContext,
    configurable: true,
  })
  Object.defineProperty(window, "MediaRecorder", {
    value: FakeMediaRecorder,
    configurable: true,
  })
  Object.defineProperty(globalThis, "MediaRecorder", {
    value: FakeMediaRecorder,
    configurable: true,
  })

  return { track, stream, getUserMedia, audioSession }
}

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  vi.clearAllMocks()
  getVoiceConfig.mockResolvedValue(READY)
  recordingToPcm16.mockResolvedValue(PCM)
  transcribeRecording.mockResolvedValue({ text: "hello" })
})

describe("useStt", () => {
  it("acknowledges a mic request before the voice config resolves", async () => {
    const status = deferred<unknown>()
    getVoiceConfig.mockReturnValue(status.promise)
    installMediaMocks()
    const { result } = renderHook(() => useStt())

    let start!: ReturnType<typeof result.current.handleMicClick>
    act(() => {
      start = result.current.handleMicClick()
    })

    expect(result.current.state).toBe("starting")

    status.resolve({ enabled: false })
    await act(async () => {
      await start
    })
    expect(result.current.state).toBe("unavailable")
    expect(result.current.unavailableReason).toMatch(/turn voice mode on/i)
  })

  it("says why when voice mode is on but its speech engine is not ready", async () => {
    getVoiceConfig.mockResolvedValue({ enabled: true, available: false, stt: { status: { available: false, reason: "Local speech is installing" } } })
    installMediaMocks()
    const { result } = renderHook(() => useStt())

    await act(async () => {
      await result.current.handleMicClick()
    })

    expect(result.current.state).toBe("unavailable")
    expect(result.current.unavailableReason).toContain("Local speech is installing")

    act(() => result.current.dismissUnavailable())
    expect(result.current.state).toBe("idle")
    expect(result.current.unavailableReason).toBeNull()
  })

  it("records when only the text-to-speech half of voice mode is down", async () => {
    getVoiceConfig.mockResolvedValue({ enabled: true, available: false, reason: "Voice speaker is not ready", stt: { status: { available: true } } })
    installMediaMocks()
    const { result } = renderHook(() => useStt())

    await act(async () => {
      await result.current.handleMicClick()
    })

    expect(result.current.state).toBe("recording")
  })

  it("stays in the starting state until microphone capture is live", async () => {
    const permission = deferred<MediaStream>()
    const { stream, getUserMedia } = installMediaMocks({
      getUserMedia: () => permission.promise,
    })
    const { result } = renderHook(() => useStt())

    let start!: ReturnType<typeof result.current.handleMicClick>
    act(() => {
      start = result.current.handleMicClick()
    })
    await act(flushMicrotasks)

    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(result.current.state).toBe("starting")

    permission.resolve(stream)
    await act(async () => {
      await start
    })
    expect(result.current.state).toBe("recording")
  })

  it("ignores rapid repeated starts while one attempt is pending", async () => {
    const status = deferred<unknown>()
    getVoiceConfig.mockReturnValue(status.promise)
    installMediaMocks()
    const { result } = renderHook(() => useStt())

    let first!: ReturnType<typeof result.current.handleMicClick>
    let second!: ReturnType<typeof result.current.handleMicClick>
    act(() => {
      first = result.current.handleMicClick()
      second = result.current.handleMicClick()
    })

    expect(getVoiceConfig).toHaveBeenCalledTimes(1)

    status.resolve({ enabled: false })
    await act(async () => {
      await Promise.all([first, second])
    })
  })

  it("stops a stream that resolves after the pending start was cancelled", async () => {
    const permission = deferred<MediaStream>()
    const { stream, track } = createFakeStream()
    installMediaMocks({ getUserMedia: () => permission.promise })
    const { result } = renderHook(() => useStt())

    let start!: ReturnType<typeof result.current.handleMicClick>
    act(() => {
      start = result.current.handleMicClick()
    })
    await act(flushMicrotasks)

    await act(async () => {
      expect(await result.current.stopRecording()).toBeNull()
    })
    expect(result.current.state).toBe("idle")

    permission.resolve(stream)
    await act(async () => {
      await start
    })

    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(result.current.state).toBe("idle")
  })

  it("reports microphone permission denial instead of returning silently to idle", async () => {
    installMediaMocks({
      getUserMedia: () => Promise.reject(new DOMException("denied", "NotAllowedError")),
    })
    const { result } = renderHook(() => useStt())

    await act(async () => {
      await result.current.handleMicClick()
    })

    expect(result.current.state).toBe("error")
    expect(result.current.error).toMatch(/microphone access was denied/i)
  })

  it("surfaces a failed availability check as an error", async () => {
    getVoiceConfig.mockRejectedValueOnce(new Error("offline"))
    installMediaMocks()
    const { result } = renderHook(() => useStt())

    await act(async () => {
      await result.current.handleMicClick()
    })
    expect(result.current.state).toBe("error")
    expect(result.current.error).toMatch(/speech engine is ready/i)
  })

  it("cancels recording without transcribing captured audio", async () => {
    const { track, audioSession } = installMediaMocks()
    const { result } = renderHook(() => useStt())

    await act(async () => {
      await result.current.handleMicClick()
    })
    expect(result.current.state).toBe("recording")
    expect(audioSession.type).toBe("play-and-record")

    act(() => {
      result.current.cancelRecording()
    })
    await flushMicrotasks()

    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(transcribeRecording).not.toHaveBeenCalled()
    expect(result.current.state).toBe("idle")
    expect(audioSession.type).toBe("auto")
  })

  it("transcribes on stop and releases the iOS audio session", async () => {
    const { track, audioSession } = installMediaMocks()
    const { result } = renderHook(() => useStt())

    await act(async () => {
      await result.current.handleMicClick()
    })

    let transcript: string | null = null
    await act(async () => {
      transcript = await result.current.stopRecording()
    })
    await flushMicrotasks()

    expect(transcript).toBe("hello")
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(recordingToPcm16).toHaveBeenCalledWith(expect.any(Blob))
    expect(transcribeRecording).toHaveBeenCalledTimes(1)
    expect(transcribeRecording).toHaveBeenCalledWith(PCM)
    expect(result.current.state).toBe("idle")
    expect(audioSession.type).toBe("auto")
  })

  it("reports a failed transcription, in the gateway's words, as an error", async () => {
    transcribeRecording.mockRejectedValueOnce(new Error("Transcription failed: the speech engine fell over"))
    installMediaMocks()
    const { result } = renderHook(() => useStt())

    await act(async () => {
      await result.current.handleMicClick()
    })
    await act(async () => {
      expect(await result.current.stopRecording()).toBeNull()
    })

    expect(result.current.state).toBe("error")
    expect(result.current.error).toBe("Transcription failed: the speech engine fell over")
  })

  it("does not transcribe when the hook unmounts mid-recording", async () => {
    const { track, audioSession } = installMediaMocks()
    const { result, unmount } = renderHook(() => useStt())

    await act(async () => {
      await result.current.handleMicClick()
    })

    unmount()
    await flushMicrotasks()

    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(transcribeRecording).not.toHaveBeenCalled()
    expect(audioSession.type).toBe("auto")
  })
})
