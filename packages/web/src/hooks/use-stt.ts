import { useState, useRef, useCallback, useEffect } from "react"
import { api } from "@/lib/api"
import { recordingToPcm16 } from "@/lib/recording-pcm"

type AudioSessionType =
  | "auto"
  | "playback"
  | "transient"
  | "transient-solo"
  | "ambient"
  | "play-and-record"

interface AudioSessionLike {
  type: AudioSessionType
}

interface NavigatorWithAudioSession extends Navigator {
  audioSession?: AudioSessionLike
}

export type SttState =
  | "idle"           // mic not active
  | "starting"       // availability check/capture startup is pending
  | "unavailable"    // voice mode's speech engine is off or not ready; say so
  | "recording"      // actively recording
  | "transcribing"   // audio sent, waiting for result
  | "error"          // transcription failed

export interface UseSttReturn {
  state: SttState
  analyser: AnalyserNode | null
  /** Error message when state is "error" */
  error: string | null
  /** Why dictation cannot run, when state is "unavailable" */
  unavailableReason: string | null
  handleMicClick: () => Promise<void>
  startRecording: () => Promise<void>
  stopRecording: () => Promise<string | null>
  cancelRecording: () => void
  /** Close the "unavailable" notice */
  dismissUnavailable: () => void
  dismissError: () => void
}

/** The longest recording the gateway takes. */
const MAX_RECORDING_MS = 20 * 60_000

interface StartAttempt {
  cancelled: boolean
}

function microphoneStartError(error: unknown): string {
  if (
    error instanceof DOMException
    && (error.name === "NotAllowedError" || error.name === "SecurityError")
  ) {
    return "Microphone access was denied. Allow access in your browser settings and try again."
  }
  if (error instanceof DOMException && error.name === "NotFoundError") {
    return "No microphone was found."
  }
  return "Could not start voice input."
}

function setAudioSessionType(type: AudioSessionType): AudioSessionLike | null {
  if (typeof navigator === "undefined") return null
  const audioSession = (navigator as NavigatorWithAudioSession).audioSession
  if (!audioSession) return null
  try {
    audioSession.type = type
    return audioSession
  } catch {
    return null
  }
}

function releaseCaptureAudioSession() {
  const audioSession = setAudioSessionType("ambient")
  if (!audioSession) return
  queueMicrotask(() => {
    try {
      audioSession.type = "auto"
    } catch {
      /* noop */
    }
  })
}

function createAudioContext(): AudioContext {
  const Ctor: typeof AudioContext =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  return new Ctor()
}

const TURN_VOICE_ON = "Dictation uses voice mode's speech engine. Turn voice mode on in Settings to use it."

/** Whether voice mode's speech-to-text can take a recording now, and if not, why in words a person can act on. */
async function dictationReason(): Promise<string | null> {
  const config = (await api.getVoiceConfig()) as { enabled?: unknown; stt?: { status?: { available?: unknown; reason?: unknown } } } | null
  if (!config || config.enabled !== true) return TURN_VOICE_ON
  const status = config.stt?.status
  if (status && status.available === false) {
    return typeof status.reason === "string" && status.reason
      ? `Voice mode's speech engine is not ready: ${status.reason}`
      : "Voice mode's speech engine is not ready."
  }
  return null
}

export function useStt(onAutoTranscript?: (text: string) => void): UseSttReturn {
  const [state, setState] = useState<SttState>("idle")
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startAttemptRef = useRef<StartAttempt | null>(null)
  // Resolve function for the stop promise — allows timeout to also trigger transcription
  const stopResolveRef = useRef<((text: string | null) => void) | null>(null)
  const mountedRef = useRef(true)
  const onAutoTranscriptRef = useRef(onAutoTranscript)
  onAutoTranscriptRef.current = onAutoTranscript

  const cleanup = useCallback((opts?: { updateAnalyser?: boolean }) => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    const audioContext = audioContextRef.current
    let closePromise: Promise<void> | null = null
    if (audioContext && audioContext.state !== "closed") {
      closePromise = audioContext.close().catch(() => {})
    }
    audioContextRef.current = null
    if (opts?.updateAnalyser !== false && mountedRef.current) setAnalyser(null)
    mediaRecorderRef.current = null
    if (closePromise) {
      void closePromise.finally(releaseCaptureAudioSession)
    } else {
      releaseCaptureAudioSession()
    }
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      mountedRef.current = false
      if (startAttemptRef.current) startAttemptRef.current.cancelled = true
      startAttemptRef.current = null
      const recorder = mediaRecorderRef.current
      if (recorder) {
        recorder.ondataavailable = null
        recorder.onstop = null
        if (recorder.state === "recording") {
          try { recorder.stop() } catch { /* noop */ }
        }
      }
      cleanup({ updateAnalyser: false })
      chunksRef.current = []
      stopResolveRef.current?.(null)
      stopResolveRef.current = null
    }
  }, [cleanup])

  const startRecordingInner = useCallback(async (attempt: StartAttempt) => {
    try {
      setAudioSessionType("play-and-record")
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (
        startAttemptRef.current !== attempt
        || attempt.cancelled
        || !mountedRef.current
      ) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      streamRef.current = stream

      const audioCtx = createAudioContext()
      audioContextRef.current = audioCtx
      const source = audioCtx.createMediaStreamSource(stream)
      const analyserNode = audioCtx.createAnalyser()
      analyserNode.fftSize = 128
      source.connect(analyserNode)
      setAnalyser(analyserNode)

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/mp4")
        ? "audio/mp4"
        : ""
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      mediaRecorderRef.current = recorder
      chunksRef.current = []

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }

      // Attach onstop at creation time so it fires whether stopped
      // by user click, timeout, or any other reason
      recorder.onstop = async () => {
        cleanup()
        if (!mountedRef.current) {
          chunksRef.current = []
          stopResolveRef.current?.(null)
          stopResolveRef.current = null
          return
        }
        setState("transcribing")

        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        })
        chunksRef.current = []

        if (blob.size === 0) {
          setState("idle")
          stopResolveRef.current?.(null)
          stopResolveRef.current = null
          return
        }

        try {
          const result = await api.transcribeRecording(await recordingToPcm16(blob))
          const text = result.text || null
          setState("idle")
          setError(null)
          if (stopResolveRef.current) {
            stopResolveRef.current(text)
            stopResolveRef.current = null
          } else if (text && onAutoTranscriptRef.current) {
            // Timeout-triggered stop — no stopRecording() was called
            onAutoTranscriptRef.current(text)
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Transcription failed"
          setError(msg)
          setState("error")
          if (stopResolveRef.current) {
            stopResolveRef.current(null)
            stopResolveRef.current = null
          }
        }
      }

      recorder.start(5000)
      startAttemptRef.current = null
      setState("recording")

      // Auto-stop after max duration (will trigger onstop → transcription)
      timeoutRef.current = setTimeout(() => {
        if (mediaRecorderRef.current?.state === "recording") {
          mediaRecorderRef.current.stop()
        }
      }, MAX_RECORDING_MS)
    } catch (err) {
      if (startAttemptRef.current !== attempt || attempt.cancelled || !mountedRef.current) return
      startAttemptRef.current = null
      cleanup()
      setError(microphoneStartError(err))
      setState("error")
    }
  }, [cleanup])

  const handleMicClick = useCallback(async () => {
    if (startAttemptRef.current || state === "recording" || state === "transcribing") return

    const attempt: StartAttempt = { cancelled: false }
    startAttemptRef.current = attempt
    setError(null)
    setState("starting")

    try {
      const reason = await dictationReason()
      if (startAttemptRef.current !== attempt || attempt.cancelled || !mountedRef.current) return
      if (reason) {
        startAttemptRef.current = null
        setUnavailableReason(reason)
        setState("unavailable")
        return
      }
      await startRecordingInner(attempt)
    } catch {
      if (startAttemptRef.current !== attempt || attempt.cancelled || !mountedRef.current) return
      startAttemptRef.current = null
      setError("Could not check whether voice mode's speech engine is ready.")
      setState("error")
    }
  }, [state, startRecordingInner])

  const startRecording = useCallback(async () => {
    if (startAttemptRef.current || state === "recording" || state === "transcribing") return
    const attempt: StartAttempt = { cancelled: false }
    startAttemptRef.current = attempt
    setError(null)
    setState("starting")
    await startRecordingInner(attempt)
  }, [state, startRecordingInner])

  const cancelStartAttempt = useCallback(() => {
    const attempt = startAttemptRef.current
    if (!attempt) return false
    attempt.cancelled = true
    startAttemptRef.current = null
    return true
  }, [])

  const stopRecording = useCallback(async (): Promise<string | null> => {
    cancelStartAttempt()
    if (!mediaRecorderRef.current || mediaRecorderRef.current.state === "inactive") {
      setState("idle")
      return null
    }

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }

    return new Promise((resolve) => {
      // The onstop handler was attached in startRecordingInner.
      // It will call stopResolveRef when transcription is done.
      stopResolveRef.current = resolve

      if (mediaRecorderRef.current?.state === "recording") {
        mediaRecorderRef.current.stop()
      } else {
        cleanup()
        setState("idle")
        stopResolveRef.current = null
        resolve(null)
      }
    })
  }, [cancelStartAttempt, cleanup])

  const cancelRecording = useCallback(() => {
    cancelStartAttempt()
    const recorder = mediaRecorderRef.current
    if (recorder) {
      recorder.ondataavailable = null
      recorder.onstop = null
      if (recorder.state === "recording") {
        try { recorder.stop() } catch { /* noop */ }
      }
    }
    cleanup()
    chunksRef.current = []
    stopResolveRef.current?.(null)
    stopResolveRef.current = null
    setState("idle")
  }, [cancelStartAttempt, cleanup])

  const dismissUnavailable = useCallback(() => {
    setState("idle")
    setUnavailableReason(null)
  }, [])

  const dismissError = useCallback(() => {
    setState("idle")
    setError(null)
  }, [])

  return {
    state,
    analyser,
    error,
    unavailableReason,
    handleMicClick,
    startRecording,
    stopRecording,
    cancelRecording,
    dismissUnavailable,
    dismissError,
  }
}
