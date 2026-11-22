import type { MemberPrincipal } from "./runtime.js";

/**
 * Whether a member may send messages to a session: the one question voice mode
 * asks about a member, at the upgrade and again on every sweep.
 *
 * No member may today. The board-members design gives chat, and anything that
 * starts or wakes an agent, to the operator alone (docs/design/board-members.md,
 * Roles), so a member has no chat for a voice session to attach to. When member
 * chat exists it answers here, and voice follows without another change.
 */
export type MemberMessagePredicate = (principal: MemberPrincipal, sessionId: string) => boolean;

export const memberMaySendMessages: MemberMessagePredicate = () => false;
