/** The voice slice of the `api` object. Split out of api.ts, which is at its size baseline. */

export interface VoiceHttp {
  get: <T>(path: string) => Promise<T>
  post: <T>(path: string, body?: unknown) => Promise<T>
}

export function createVoiceApi({ get, post }: VoiceHttp) {
  return {
    getVoiceConfig: () => get<unknown>("/api/voice/config"),
    installVoice: () => post<unknown>("/api/voice/install", {}),
  }
}
