import type { GatewayProfile } from "./gateway-transport"
import { LEGACY_STORAGE_KEYS } from "@hundredfold/legacy-names"

const STORAGE_KEY = "hundredfold.native.gateway-profiles.v1"
const LEGACY_ACTIVE_ORIGIN_KEY = LEGACY_STORAGE_KEYS.activeOrigin

export interface NativeGatewayProfile extends GatewayProfile {
  name: string
  deviceId: string
}

export interface PersistedProfiles {
  version: 1
  /** Counts every change to `activeId` or `profiles`, so the newer of two copies can be told apart. */
  revision: number
  activeId?: string
  profiles: NativeGatewayProfile[]
}

export interface LoadedProfiles extends PersistedProfiles {
  /** Read from the pre-profile storage key: the new key has to be written for it to stick. */
  migrated: boolean
  /** The record named an active workspace that is not among its profiles. */
  lostActive: boolean
}

export function canonicalNativeGatewayOrigin(raw: string): string {
  const url = new URL(raw)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Invalid native gateway origin")
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("Native gateway profiles require a bare origin")
  }
  return url.origin
}

export function nativeGatewayProfileId(origin: string): string {
  return `native:${origin}`
}

/** A stored record, or undefined when it is not one this version can read. */
export function parseNativeGatewayRecord(raw: string): LoadedProfiles | undefined {
  try {
    const value = JSON.parse(raw) as Partial<PersistedProfiles>
    if (value?.version !== 1 || !Array.isArray(value.profiles)) return undefined
    const profiles = value.profiles.filter(isNativeGatewayProfile)
    const known = profiles.some((profile) => profile.id === value.activeId)
    return {
      version: 1,
      revision: typeof value.revision === "number" && Number.isFinite(value.revision) ? value.revision : 0,
      activeId: known ? value.activeId : undefined,
      profiles,
      migrated: false,
      lostActive: typeof value.activeId === "string" && !known,
    }
  } catch {
    return undefined
  }
}

export function loadNativeGatewayProfiles(storage: Storage): LoadedProfiles {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (raw) {
      const record = parseNativeGatewayRecord(raw)
      if (record) return record
    }
    const legacyOrigin = storage.getItem(LEGACY_ACTIVE_ORIGIN_KEY)
    if (legacyOrigin) return migrateLegacyOrigin(legacyOrigin)
  } catch {
    // Invalid persisted state is treated as empty; pairing can repair it.
  }
  return { version: 1, revision: 0, profiles: [], migrated: false, lostActive: false }
}

export function serializeNativeGatewayProfiles(value: Omit<PersistedProfiles, "version">): string {
  return JSON.stringify({ version: 1, ...value } satisfies PersistedProfiles)
}

export function persistNativeGatewayProfiles(
  storage: Storage,
  value: Omit<PersistedProfiles, "version">,
): string {
  const document = serializeNativeGatewayProfiles(value)
  storage.setItem(STORAGE_KEY, document)
  storage.removeItem(LEGACY_ACTIVE_ORIGIN_KEY)
  return document
}

/**
 * Take the shell's copy of the record into `storage` when it is newer. The shell
 * writes its copy to disk before a selection completes, while the WebView writes
 * `localStorage` behind the page, so after the app was killed the shell's copy can
 * be the only one that holds the last change. Returns the document the shell should
 * hold when its own is missing or older, so the caller can bring it up to date.
 */
export function adoptNewerNativeRecord(storage: Storage, shellRecord: string | null): { adopted: boolean; refresh?: string } {
  const shell = shellRecord ? parseNativeGatewayRecord(shellRecord) : undefined
  const local = readStoredRecord(storage)
  const localRecord = local ? parseNativeGatewayRecord(local) : undefined
  if (shell && isNewer(shell, localRecord)) return { adopted: tryStore(storage, shellRecord!) }
  if (local && localRecord && localRecord.profiles.length > 0 && isNewer(localRecord, shell)) return { adopted: false, refresh: local }
  return { adopted: false }
}

function readStoredRecord(storage: Storage): string | null {
  try { return storage.getItem(STORAGE_KEY) } catch { return null } // unreadable storage: the shell's copy is the only one
}

function tryStore(storage: Storage, record: string): boolean {
  try { storage.setItem(STORAGE_KEY, record); return true } catch { return false }
}

/** Whether `candidate` is a later state of the record than `other`; a missing copy is older than any. */
function isNewer(candidate: LoadedProfiles, other: LoadedProfiles | undefined): boolean {
  return !other || candidate.revision > other.revision
}

function isNativeGatewayProfile(entry: NativeGatewayProfile): entry is NativeGatewayProfile {
  return typeof entry?.id === "string"
    && typeof entry.origin === "string"
    && typeof entry.name === "string"
    && typeof entry.deviceId === "string"
}

function migrateLegacyOrigin(rawOrigin: string): LoadedProfiles {
  const origin = canonicalNativeGatewayOrigin(rawOrigin)
  const profile = {
    id: nativeGatewayProfileId(origin),
    origin,
    name: new URL(origin).host,
    deviceId: "",
  }
  return { version: 1, revision: 0, activeId: profile.id, profiles: [profile], migrated: true, lostActive: false }
}
