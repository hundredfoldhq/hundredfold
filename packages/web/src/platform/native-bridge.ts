export interface NativeGatewayTarget { origin: string }
export interface NativeHeader { name: string; value: string }
export interface NativeRequestInput {
  target: NativeGatewayTarget
  method: string
  path: string
  headers: NativeHeader[]
  bodyBase64?: string
}
export interface NativeResponsePayload {
  status: number
  headers: NativeHeader[]
  bodyBase64: string
}
export type NativeStreamInput =
  | { action: "open"; target: NativeGatewayTarget; path: string }
  | { action: "send"; streamId: string; text?: string; bytesBase64?: string }
  | { action: "close"; streamId: string }
export type NativeStreamEvent =
  | { event: "opened"; streamId: string }
  | { event: "message"; streamId: string; text?: string; bytesBase64?: string }
  | { event: "closed"; streamId: string; code?: number; reason: string }
  | { event: "failed"; streamId: string; code: string; message: string }

/** Why `voice_start` refused. The shell answers with one of these codes, as a string or `{ code }`. */
export type NativeVoiceErrorCode = "permission_denied" | "not_paired" | "unsupported"
export interface NativeVoiceStartInput {
  target: NativeGatewayTarget
  sessionId: string
  mode: "hands-free" | "push-to-talk"
}

export interface HundredfoldNativeBridge {
  readonly runtime: "tauri"
  pair(input: { target: NativeGatewayTarget; code: string }): Promise<{ origin: string; device: { id: string; name: string } }>
  request(input: NativeRequestInput): Promise<NativeResponsePayload>
  stream(input: NativeStreamInput, onEvent: (event: NativeStreamEvent) => void): Promise<{ streamId: string }>
  forget(input: { target: NativeGatewayTarget }): Promise<{ localRemoved: boolean; remoteRevoked: boolean }>
  /**
   * Native voice mode (the mobile shell only; absent elsewhere, where the web
   * client handles audio itself). Capture and playback run in native code, so
   * audio never passes through JavaScript; the gateway's JSON frames come back
   * to `onFrame` as they were sent. Contract: contracts/native-voice.md.
   */
  voiceStart?(input: NativeVoiceStartInput, onFrame: (frame: unknown) => void): Promise<{ ok: boolean }>
  voiceStop?(): Promise<{ ok: boolean }>
  voicePtt?(input: { down: boolean }): Promise<{ ok: boolean }>
  voiceStatus?(): Promise<{ running: boolean; state: string }>
}

declare global {
  interface Window { __HUNDREDFOLD_NATIVE__?: HundredfoldNativeBridge }
}

export function nativeBridge(): HundredfoldNativeBridge | undefined {
  return typeof window === "undefined" ? undefined : window.__HUNDREDFOLD_NATIVE__
}
