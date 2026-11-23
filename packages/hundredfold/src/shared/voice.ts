/**
 * The config shapes for speech-to-text input and read-aloud TTS output.
 * `HundredfoldConfig` in config-types.ts imports them.
 */

export interface SttConfig {
  enabled?: boolean;
  model?: string;
  /** @deprecated Use `languages` instead. Kept for backwards compat. */
  language?: string;
  languages?: string[];
}

/** Read-aloud TTS (`/api/tts`). Only `kokoro` is read; a config that still carries the retired
 *  orchestrator keys (`enabled`, `engine`, `orchestratorModel`) loads and ignores them. */
export interface TalkConfig {
  kokoro?: {
    voice?: string;
    modelDir?: string;
    sidecarPort?: number;
  };
}
