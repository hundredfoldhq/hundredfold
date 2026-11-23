import { useEffect, useRef } from "react"
import { LoaderCircle, Mic } from "@/components/ui/icon"
import { useStt } from "@/hooks/use-stt"
import { MicWaveform } from "@/components/chat/mic-waveform"
import { DictationUnavailableModal } from "@/components/stt/dictation-unavailable-modal"
import { classifyMicGesture, MIC_HOLD_THRESHOLD_MS } from "@/lib/mic-gesture"
import { cn } from "@/lib/utils"

export function NoteMic({ onTranscript }: { onTranscript: (text: string) => void }) {
  const stt = useStt(onTranscript)
  const downAtRef = useRef<number | null>(null)
  const toggleActiveRef = useRef(false)

  useEffect(() => {
    if (stt.state === "idle" || stt.state === "unavailable" || stt.state === "error") {
      toggleActiveRef.current = false
    }
  }, [stt.state])

  async function transcribe() {
    const text = await stt.stopRecording()
    if (text) onTranscript(text)
  }

  function handlePointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    event.stopPropagation()
    if (stt.state === "transcribing") return
    if (stt.state === "starting") {
      downAtRef.current = null
      stt.cancelRecording()
      return
    }
    if (toggleActiveRef.current || stt.state === "recording") {
      toggleActiveRef.current = false
      downAtRef.current = null
      void transcribe()
      return
    }

    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* unavailable */ }
    downAtRef.current = Date.now()
    void stt.handleMicClick()
  }

  function handlePointerUp() {
    const downAt = downAtRef.current
    if (downAt === null) return
    downAtRef.current = null
    if (stt.state === "unavailable" || stt.state === "transcribing") return
    if (classifyMicGesture(downAt, Date.now(), MIC_HOLD_THRESHOLD_MS) === "hold") {
      void transcribe()
    } else {
      toggleActiveRef.current = true
    }
  }

  function handlePointerCancel(event: React.PointerEvent<HTMLButtonElement>) {
    event.stopPropagation()
    downAtRef.current = null
    toggleActiveRef.current = false
    stt.cancelRecording()
  }

  const recording = stt.state === "recording"
  const busy = stt.state === "starting" || stt.state === "transcribing"
  const label = recording
    ? "Stop recording"
    : stt.state === "starting"
      ? "Starting voice input…"
      : stt.state === "transcribing"
        ? "Transcribing…"
        : "Voice input"

  return (
    <>
      <div
        data-note-mic-anchor
        className="pointer-events-none absolute bottom-7 left-1/2 z-20 flex -translate-x-1/2 items-center justify-center lg:bottom-6"
      >
        <button
          type="button"
          aria-label={label}
          aria-busy={busy}
          data-state={stt.state}
          title={recording ? "Stop recording" : "Hold to talk · tap to toggle"}
          disabled={stt.state === "transcribing"}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          className={cn(
            "pointer-events-auto flex h-[52px] items-center justify-center rounded-full border-0 touch-none select-none transition-[width,scale,background-color,color,opacity] duration-150 [transition-timing-function:var(--ease-snappy)] active:scale-[0.96]",
            recording
              ? "w-[136px] gap-2.5 bg-[var(--system-red)] px-[18px] text-[var(--bg-secondary)] shadow-[var(--shadow-overlay)]"
              : "glass-tint size-[52px] text-[var(--text-primary)]",
            stt.state === "transcribing" && "cursor-wait",
          )}
        >
          {busy ? (
            <LoaderCircle size={21} className="animate-spin" aria-hidden />
          ) : recording ? (
            <>
              {stt.analyser ? (
                <MicWaveform analyser={stt.analyser} cssWidth={42} cssHeight={22} barCount={7} />
              ) : (
                <span aria-hidden className="flex h-[22px] items-center gap-[3px]">
                  {[8, 14, 20, 11, 18, 13, 7].map((height, index) => (
                    <span key={index} className="w-0.5 rounded-full bg-current" style={{ height }} />
                  ))}
                </span>
              )}
              <span className="text-[length:var(--text-footnote)] font-[var(--weight-semibold)]">Listening</span>
            </>
          ) : (
            <Mic size={23} className="translate-x-[0.75px]" aria-hidden />
          )}
        </button>
        {stt.error && (
          <div className="pointer-events-auto absolute bottom-[calc(100%+10px)] left-1/2 w-max max-w-[min(320px,calc(100vw-32px))] -translate-x-1/2 rounded-[var(--radius-lg)] glass-tint px-3 py-2 text-pretty text-center text-[length:var(--text-footnote)] text-[var(--system-red)]">
            {stt.error}
            <button type="button" onClick={stt.dismissError} className="ml-2 min-h-10 font-[var(--weight-semibold)] text-[var(--text-primary)]">Dismiss</button>
          </div>
        )}
      </div>
      <DictationUnavailableModal
        open={stt.state === "unavailable"}
        reason={stt.unavailableReason}
        onClose={stt.dismissUnavailable}
      />
    </>
  )
}
