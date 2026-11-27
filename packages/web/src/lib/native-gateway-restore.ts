import type { HundredfoldNativeBridge } from "@/platform/native-bridge"
import { adoptNewerNativeRecord } from "./native-gateway-profile-storage"

/** The longest startup waits for the shell's copy of the record before opening on the page's own. */
export const SHELL_RECORD_TIMEOUT_MS = 2500

export type NativeRecordRestore = "adopted" | "page-copy" | "unavailable"

/**
 * Bring the page's copy of the paired-workspace record up to date with the
 * shell's before the app reads it.
 *
 * The page's `localStorage` is written behind the page, so after the app was
 * killed it can lack the last selection that the shell's file still holds. The
 * shell's copy wins only when it is newer. A shell that does not answer, is
 * slow, or fails leaves the page's copy in charge: opening on the last record
 * the page has is better than not opening, and the next change rewrites the
 * shell's copy anyway.
 */
export async function restoreNativeGatewayRecord(
  bridge: HundredfoldNativeBridge,
  storage: Storage,
  timeoutMs = SHELL_RECORD_TIMEOUT_MS,
): Promise<NativeRecordRestore> {
  if (!bridge.readWorkspaceState || !bridge.writeWorkspaceState) return "unavailable"
  const read = bridge.readWorkspaceState()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs) })
  let shellRecord: string | null
  try {
    const answer = await Promise.race([read, timeout])
    if (answer === "timeout") {
      // Left to finish on its own; its answer is not waited for.
      read.catch(() => {})
      return "page-copy"
    }
    shellRecord = answer
  } catch {
    return "page-copy"
  } finally {
    clearTimeout(timer)
  }
  const { adopted, refresh } = adoptNewerNativeRecord(storage, shellRecord)
  if (refresh) await bridge.writeWorkspaceState({ document: refresh }).catch(() => {})
  return adopted ? "adopted" : "page-copy"
}
