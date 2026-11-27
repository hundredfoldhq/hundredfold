import type { HundredfoldNativeBridge } from "@/platform/native-bridge"
import {
  GATEWAY_SOCKET_CLOSED,
  type GatewaySocketConnection,
  type GatewayTransport,
} from "./gateway-transport"
import { GuardedSocket, StaleGatewayGenerationError } from "./native-gateway-socket"
import { nativeErrorMessage } from "./native-error"
import { createNativeGatewayTransport, pairNativeGateway } from "./native-gateway-transport"
import {
  canonicalNativeGatewayOrigin,
  loadNativeGatewayProfiles,
  nativeGatewayProfileId,
  persistNativeGatewayProfiles,
  type NativeGatewayProfile,
} from "./native-gateway-profile-storage"

/** The longest a switch waits for the shell to confirm its copy of the record is on disk. */
const DURABLE_WRITE_TIMEOUT_MS = 1500
/** The longest one write to the shell may take before the next is let through behind it. */
const DURABLE_WRITE_ABANDON_MS = 5000

export type { NativeGatewayProfile } from "./native-gateway-profile-storage"
export { StaleGatewayGenerationError } from "./native-gateway-socket"

export type NativeGatewayStatus = "ready" | "checking" | "switching" | "unreachable"

export interface NativeGatewayProfilesSnapshot {
  profiles: NativeGatewayProfile[]
  activeId?: string
  generation: number
  status: NativeGatewayStatus
  /** The profile a switch is reaching for. Distinct from the one it failed on. */
  switchingProfileId?: string
  /** The profile the last failure was about, whichever kind. Whether the ACTIVE gateway answers is `activeReachable`, never this. */
  failedProfileId?: string
  error?: string
  /**
   * Something the app did to the selection that the person did not directly ask
   * for, said once so it is never a silent switch. Cleared by the next selection
   * or by `dismissNotice`.
   */
  notice?: string
  /** Whether the ACTIVE gateway has answered since it became active. Storage remembers which gateway was open last, never that it still runs. */
  activeReachable: boolean
}

interface NativeGatewayProfilesOptions {
  bridge: HundredfoldNativeBridge
  storage: Storage
  beforeCommit?: () => void | Promise<void>
  /** Where a second copy of the record goes, to a place that survives the app being killed. */
  durable?: (document: string) => Promise<void>
}

/** Settles with `work`, or rejects once `ms` have passed; the work is left to finish on its own. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), ms) })
  try {
    return await Promise.race([work, expired])
  } finally {
    clearTimeout(timer)
  }
}

function recordKey(activeId: string | undefined, profiles: NativeGatewayProfile[]): string {
  return JSON.stringify({ activeId, profiles })
}

function stale(manager: NativeGatewayProfiles, generation: number): boolean {
  return manager.snapshot().generation !== generation
}

export class NativeGatewayProfiles {
  readonly transport: GatewayTransport
  readonly #listeners = new Set<() => void>()
  readonly #sockets = new Set<GatewaySocketConnection>()
  #snapshot: NativeGatewayProfilesSnapshot
  #revision: number
  /** What the last write held, so a status change that leaves the record alone writes nothing. */
  #written: string
  #durable: Promise<void> = Promise.resolve()

  constructor(private readonly options: NativeGatewayProfilesOptions) {
    const stored = loadNativeGatewayProfiles(options.storage)
    this.#snapshot = {
      profiles: stored.profiles,
      activeId: stored.activeId,
      generation: 0,
      status: "ready",
      activeReachable: false,
      notice: stored.lostActive
        ? "The workspace you last used is no longer paired. Choose a workspace to continue."
        : undefined,
    }
    this.#revision = stored.revision
    this.#written = recordKey(stored.activeId, stored.profiles)
    this.transport = this.#createTransport()
    // Loading must not write: a record that could not be read would otherwise be
    // replaced by the empty one. Only a record read from the old key has to be saved.
    if (stored.migrated) this.#persist()
  }

  snapshot = (): NativeGatewayProfilesSnapshot => this.#snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async pair(rawOrigin: string, code: string, options: { activate?: boolean } = {}): Promise<NativeGatewayProfile> {
    const origin = canonicalNativeGatewayOrigin(rawOrigin)
    const receipt = await pairNativeGateway(origin, code, this.options.bridge)
    const transport = createNativeGatewayTransport(receipt.origin, this.options.bridge)
    const state = await this.#authState(transport)
    const name = await this.#gatewayName(transport, state.instance)
    const profile: NativeGatewayProfile = {
      id: nativeGatewayProfileId(receipt.origin),
      origin: receipt.origin,
      name,
      deviceId: receipt.device.id,
    }
    const profiles = [...this.#snapshot.profiles.filter((entry) => entry.id !== profile.id), profile]
    this.#update({ ...this.#snapshot, profiles })
    if (options.activate || !this.#snapshot.activeId) await this.#commit(profile.id)
    else await this.#flushDurable()
    return profile
  }

  async select(id: string): Promise<void> {
    if (id === this.#snapshot.activeId) return
    const profile = this.#profile(id)
    this.#update({ ...this.#snapshot, status: "switching", switchingProfileId: id, failedProfileId: undefined, error: undefined, notice: undefined })
    await this.#commit(id, false)
    const generation = this.#snapshot.generation
    try {
      await this.#authState(createNativeGatewayTransport(profile.origin, this.options.bridge))
      // Validation is asynchronous: removal wins if it landed while the candidate answered.
      this.#profile(id)
      if (stale(this, generation)) throw new StaleGatewayGenerationError()
      this.#update({ ...this.#snapshot, status: "ready", switchingProfileId: undefined, activeReachable: true })
    } catch (error) {
      const reason = nativeErrorMessage(error, "Gateway is unreachable")
      if (!stale(this, generation)) {
        this.#update({ ...this.#snapshot, status: "unreachable", switchingProfileId: undefined, failedProfileId: id, error: reason, activeReachable: false })
      }
      throw error
    }
  }

  /**
   * Prove the remembered last-active gateway still answers before the app mounts
   * against it, so a gateway that is simply gone reads as an honest native state
   * that still offers the other paired gateways, not as an unpaired browser.
   */
  async verifyActive(): Promise<void> {
    const id = this.#snapshot.activeId
    if (!id) return
    const generation = this.#snapshot.generation
    this.#update({ ...this.#snapshot, status: "checking", switchingProfileId: undefined, failedProfileId: undefined, error: undefined })
    try {
      await this.#authState(createNativeGatewayTransport(this.#profile(id).origin, this.options.bridge))
      // The answer is about the gateway that was active when it was asked. If the
      // selection moved on meanwhile, it says nothing about the one now active.
      if (stale(this, generation)) return
      this.#update({ ...this.#snapshot, status: "ready", failedProfileId: undefined, error: undefined, activeReachable: true })
    } catch (error) {
      if (stale(this, generation)) return
      const reason = nativeErrorMessage(error, "Gateway is unreachable")
      this.#update({ ...this.#snapshot, status: "unreachable", failedProfileId: id, error: reason, activeReachable: false })
    }
  }

  async remove(id: string): Promise<void> {
    const profile = this.#profile(id)
    const remaining = this.#snapshot.profiles.filter((entry) => entry.id !== id)
    const wasActive = id === this.#snapshot.activeId
    let fallback: NativeGatewayProfile | undefined
    if (wasActive) {
      fallback = remaining[0]
      if (fallback) await this.select(fallback.id)
      else await this.#commit(undefined)
    }
    const failed = this.#snapshot.failedProfileId === id ? undefined : this.#snapshot.failedProfileId
    this.#update({
      ...this.#snapshot,
      profiles: remaining,
      failedProfileId: failed,
      error: failed ? this.#snapshot.error : undefined,
      status: !failed && this.#snapshot.activeReachable ? "ready" : this.#snapshot.status,
      // Removing the workspace in use moves the app to another one. Say so.
      notice: fallback ? `Switched to ${fallback.name} because ${profile.name} was removed.` : this.#snapshot.notice,
    })
    await this.#flushDurable()
    await this.options.bridge.forget({ target: { origin: profile.origin } })
  }

  /**
   * Re-check the ACTIVE gateway. Selection commits before its reachability
   * probe, so an unreachable chosen profile owns Retry and this reaches it.
   */
  async retry(): Promise<void> {
    const id = this.#snapshot.activeId
    if (!id) return
    const profile = this.#profile(id)
    await this.#authState(createNativeGatewayTransport(profile.origin, this.options.bridge))
    this.#update({ ...this.#snapshot, status: "ready", failedProfileId: undefined, error: undefined, activeReachable: true })
  }

  dismissNotice(): void {
    if (this.#snapshot.notice) this.#update({ ...this.#snapshot, notice: undefined })
  }

  /** Resolves once the shell has the latest record on disk, or after a bounded wait if it cannot say. */
  flush(): Promise<void> {
    return this.#flushDurable()
  }

  #createTransport(): GatewayTransport {
    const manager = this
    return {
      get profile() { return manager.#activeTransport().profile },
      httpUrl(path) { return manager.#activeTransport().httpUrl(path) },
      socketUrl(path) { return manager.#activeTransport().socketUrl(path) },
      openSocket(path) {
        const generation = manager.#snapshot.generation
        const inner = manager.#activeTransport().openSocket(path)
        let socket!: GuardedSocket
        socket = new GuardedSocket(
          inner,
          () => !stale(manager, generation),
          () => manager.#sockets.delete(socket),
        )
        manager.#sockets.add(socket)
        return socket
      },
      async request(path, init) {
        const generation = manager.#snapshot.generation
        const response = await manager.#activeTransport().request(path, init)
        if (stale(manager, generation)) throw new StaleGatewayGenerationError()
        return response
      },
      navigate() {
        throw new Error("Native workspace switching must select a paired profile")
      },
    }
  }

  #activeTransport(): GatewayTransport {
    const id = this.#snapshot.activeId
    if (!id) throw new Error("No native gateway profile is active")
    return createNativeGatewayTransport(this.#profile(id).origin, this.options.bridge)
  }

  #profile(id: string): NativeGatewayProfile {
    const profile = this.#snapshot.profiles.find((entry) => entry.id === id)
    if (!profile) throw new Error(`Unknown native gateway profile: ${id}`)
    return profile
  }

  async #authState(transport: GatewayTransport): Promise<{ authenticated: boolean; instance?: string }> {
    const response = await transport.request("/api/auth/state", { method: "GET" })
    if (!response.ok) throw new Error(`Gateway access check failed (${response.status})`)
    const state = await response.json() as { authenticated?: boolean; authRequired?: boolean; instance?: string }
    if (state.authRequired && !state.authenticated) throw new Error("Gateway is not paired")
    return { authenticated: state.authenticated === true || state.authRequired === false, instance: state.instance }
  }

  async #gatewayName(transport: GatewayTransport, instance?: string): Promise<string> {
    try {
      const response = await transport.request("/api/onboarding", { method: "GET" })
      if (response.ok) {
        const onboarding = await response.json() as { portalName?: string; companyName?: string }
        const configured = onboarding.portalName?.trim() || onboarding.companyName?.trim()
        if (configured) return configured
      }
    } catch {
      // Identity enrichment is optional; the authenticated instance is enough.
    }
    return instance?.trim() || new URL(transport.profile.origin).host
  }

  async #commit(activeId: string | undefined, activeReachable = activeId !== undefined): Promise<void> {
    await this.options.beforeCommit?.()
    if (activeId) this.#profile(activeId)
    this.#snapshot = {
      ...this.#snapshot,
      activeId,
      generation: this.#snapshot.generation + 1,
      status: activeId !== undefined && !activeReachable ? "switching" : "ready",
      switchingProfileId: activeReachable ? undefined : activeId,
      failedProfileId: undefined,
      error: undefined,
      activeReachable,
    }
    for (const socket of this.#sockets) {
      if (socket.readyState !== GATEWAY_SOCKET_CLOSED) socket.close(1000, "Gateway profile changed")
    }
    this.#sockets.clear()
    this.#persist()
    // The selection is what the person will find on the next launch, so it is on
    // disk before the app shows it as made.
    await this.#flushDurable()
    this.#emit()
  }

  #update(snapshot: NativeGatewayProfilesSnapshot): void {
    this.#snapshot = snapshot
    this.#persist()
    this.#emit()
  }

  #persist(): void {
    const key = recordKey(this.#snapshot.activeId, this.#snapshot.profiles)
    if (key === this.#written) return
    this.#written = key
    const document = persistNativeGatewayProfiles(this.options.storage, {
      revision: ++this.#revision,
      activeId: this.#snapshot.activeId,
      profiles: this.#snapshot.profiles,
    })
    const durable = this.options.durable
    if (!durable) return
    // One write at a time, in order, so a slow earlier write can never land after a later one.
    this.#durable = this.#durable.then(() => withTimeout(durable(document), DURABLE_WRITE_ABANDON_MS)).catch((error: unknown) => {
      console.warn("[native-gateway] the shell could not save the workspace record", error)
    })
  }

  async #flushDurable(): Promise<void> {
    if (!this.options.durable) return
    await withTimeout(this.#durable, DURABLE_WRITE_TIMEOUT_MS).catch(() => {})
  }

  #emit(): void {
    for (const listener of this.#listeners) listener()
  }
}

export function createNativeGatewayProfiles(options: NativeGatewayProfilesOptions): NativeGatewayProfiles {
  return new NativeGatewayProfiles(options)
}
