/**
 * The voice hub: every live attachment, who holds which session, the limits,
 * and the gateway events that reach them (data-model.md `VoiceAttachment`,
 * contracts/voice-socket.md). The conversation itself is `VoiceAttachment`.
 *
 * One attachment per session. The same principal taking over detaches the old
 * socket; another principal is refused 4409; the cap refuses 4429. A client
 * that vanishes without saying goodbye (a phone locking) leaves its attachment
 * suspended for `RESUME_WINDOW_MS`, collecting replies.
 */
import { VOICE_CLOSE } from "../shared/gateway-events.js";
import { VoiceAttachment } from "./attachment.js";
import {
  samePrincipal, type CancelTimer, type VoiceHubDeps, type VoicePrincipal, type VoiceProviderSet, type VoiceSocket,
} from "./hub-types.js";
import type { ResolvedVoiceConfig } from "../shared/voice-config.js";

/** How long a suspended attachment waits for its client to come back. */
export const RESUME_WINDOW_MS = 10 * 60 * 1000;

/** The events the hub reads; the rest of the gateway's chatter is ignored at the door. */
const SESSION_EVENTS = new Set([
  "session:started", "session:delta", "session:completed", "session:interrupted", "session:compacted",
  "session:background", "session:deleted", "session:stopped",
  // A reply the engine wrote on its own (the CLI re-invoked after background work), stored by the transcript sync.
  "session:external-turn",
]);

export interface AttachRequest {
  sessionId: string;
  principal: VoicePrincipal;
}

export class VoiceHub {
  private readonly attachments = new Map<string, VoiceAttachment>();
  private readonly expiries = new Map<string, CancelTimer>();
  private providers: { config: ResolvedVoiceConfig; set: VoiceProviderSet } | null = null;
  /** Providers of a config that was replaced while attachments still used them; closed once none do. */
  private retired: VoiceProviderSet[] = [];

  constructor(private readonly deps: VoiceHubDeps) {}

  /** How many attachments hold a session now, suspended ones included. */
  size(): number {
    return this.attachments.size;
  }

  /** Whether any attachment is open: lets the tee skip all work when nobody is listening. */
  active(): boolean {
    return this.attachments.size > 0;
  }

  /** The attachment on a session, for the member sweep and tests. */
  get(sessionId: string): VoiceAttachment | undefined {
    return this.attachments.get(sessionId);
  }

  /**
   * A socket the upgrade route accepted. Returns the attachment that now owns
   * it, or null when it was refused (closed with 4409 or 4429) or voice is off.
   */
  attach(socket: VoiceSocket, request: AttachRequest): VoiceAttachment | null {
    const config = this.deps.config();
    if (!config) {
      // Voice was switched off between the upgrade and here: say so as an attached client would hear it, not as a missing chat.
      if (socket.readyState === 1) socket.send(JSON.stringify({ type: "detached", reason: "disabled" }));
      socket.close(1000, "disabled");
      return null;
    }
    const existing = this.attachments.get(request.sessionId);
    if (existing) return this.replace(existing, socket, request);
    if (this.attachments.size >= config.limits.maxConcurrentAttachments) {
      socket.close(VOICE_CLOSE.limit, "limit");
      return null;
    }
    return this.create(socket, request, config);
  }

  /** A gateway event; cheap for the many that are no concern of voice. */
  onEvent(event: string, payload: unknown): void {
    if (event === "config:reloaded") return this.checkConfig();
    if (this.attachments.size === 0 || !SESSION_EVENTS.has(event)) return;
    const record = payload as Record<string, unknown> | null;
    const sessionId = typeof record?.sessionId === "string" ? record.sessionId : undefined;
    if (sessionId) this.attachments.get(sessionId)?.onSessionEvent(event, record!);
  }

  /** Voice turned off while attached: every attachment ends with a reason. */
  checkConfig(): void {
    if (this.deps.config()) return;
    for (const attachment of [...this.attachments.values()]) attachment.detach("disabled");
    this.closeProviders();
  }

  /** A principal lost access to a session: their attachment there ends, with `access_lost`. Another principal's is left alone, and so is another sign-in of the same member. */
  revoke(sessionId: string, principal: VoicePrincipal): void {
    const attachment = this.attachments.get(sessionId);
    if (!attachment || !samePrincipal(attachment.principal, principal)) return;
    const held = attachment.principal;
    if (held.kind === "member" && principal.kind === "member" && held.userSessionId !== principal.userSessionId) return;
    attachment.detach("access_lost");
  }

  shutdown(): void {
    for (const attachment of [...this.attachments.values()]) attachment.detach("shutdown");
    this.closeProviders();
  }

  // ── attaching ──────────────────────────────────────────────────────────────

  private replace(existing: VoiceAttachment, socket: VoiceSocket, request: AttachRequest): VoiceAttachment | null {
    if (!samePrincipal(existing.principal, request.principal)) {
      socket.close(VOICE_CLOSE.inUse, "in_use");
      return null;
    }
    if (existing.suspended) {
      this.cancelExpiry(request.sessionId);
      existing.adopt(socket, request.principal);
      return existing;
    }
    existing.detach("taken_over");
    const config = this.deps.config();
    return config ? this.create(socket, request, config) : null;
  }

  private create(socket: VoiceSocket, request: AttachRequest, config: ResolvedVoiceConfig): VoiceAttachment {
    const attachment = new VoiceAttachment({
      id: this.deps.newId(),
      sessionId: request.sessionId,
      principal: request.principal,
      socket,
      config,
      providers: this.providersFor(config),
      deps: this.deps,
      onEnd: (ended) => this.remove(ended),
    });
    this.attachments.set(request.sessionId, attachment);
    return attachment;
  }

  /** The socket of an attachment closed: it ends or waits for its client. */
  socketClosed(attachment: VoiceAttachment, socket: VoiceSocket, code: number): void {
    attachment.onSocketClosed(socket, code);
    if (attachment.suspended && this.attachments.get(attachment.sessionId) === attachment) {
      this.cancelExpiry(attachment.sessionId);
      this.expiries.set(attachment.sessionId, this.deps.clock.setTimeout(() => attachment.expire(), RESUME_WINDOW_MS));
    }
  }

  private remove(attachment: VoiceAttachment): void {
    if (this.attachments.get(attachment.sessionId) === attachment) this.attachments.delete(attachment.sessionId);
    this.cancelExpiry(attachment.sessionId);
    if (this.attachments.size === 0) this.closeRetired();
  }

  private cancelExpiry(sessionId: string): void {
    this.expiries.get(sessionId)?.();
    this.expiries.delete(sessionId);
  }

  private providersFor(config: ResolvedVoiceConfig): VoiceProviderSet {
    if (this.providers?.config === config) return this.providers.set;
    this.retire();
    const set = this.deps.providers(config);
    this.providers = { config, set };
    return set;
  }

  /** Set the current providers aside: closed now when nobody uses them, else when the last attachment ends. */
  private retire(): void {
    if (this.providers) this.retired.push(this.providers.set);
    this.providers = null;
    if (this.attachments.size === 0) this.closeRetired();
  }

  private closeProviders(): void {
    this.retire();
    this.closeRetired();
  }

  private closeRetired(): void {
    for (const set of this.retired.splice(0)) {
      set.stt.close?.();
      set.tts.close?.();
    }
  }
}
