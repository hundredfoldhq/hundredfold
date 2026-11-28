import { beforeEach, describe, expect, it } from "vitest";
import { createParent, dbModule, registry, resetCallbackState } from "./helpers/callback-harness.js";
import { stalledSendPayload, type WaitingSends } from "../lateral-send-watch.js";
import { LATERAL_STALL_DELIVERY_KIND, staleLateralNoticeReason } from "../../sessions/lateral-notice-staleness.js";
import { enqueueQueueItem } from "../../sessions/queue-item-registry.js";

beforeEach(resetCallbackState);

/**
 * A notice parked on the sender's queue is dropped before its turn only when
 * it has nothing left to say. These pin what it must never take with it.
 */
describe("judging a parked undelivered-messages notice", () => {
  const setStatus = (id: string, status: string) => dbModule.initDb().prepare("UPDATE queue_items SET status = ? WHERE id = ?").run(status, id);

  /** A message row on the target, and a notice row on the sender's queue carrying the given deliveries. */
  function park(opts: { sends: (rows: { a: string; b: string }) => WaitingSends; otherKind?: boolean; folded?: boolean }) {
    const sender = createParent("sender");
    const target = createParent("target");
    const rows = { a: enqueueQueueItem(target.id, target.sessionKey!, "plan A", { internal: true }), b: enqueueQueueItem(target.id, target.sessionKey!, "plan B", { internal: true }) };
    const noticeRow = enqueueQueueItem(sender.id, sender.sessionKey!, "notice", { internal: true, ...(opts.folded ? { dispatch: { attachments: [], speechDerived: false, foldedMessageIds: ["an-operator-message"] } } : {}) });
    const claim = (kind: string, sourceId: string, payload: ReturnType<typeof stalledSendPayload>) => {
      const { delivery } = registry.claimSessionDelivery({
        targetSessionId: sender.id, sourceKind: "session", sourceId, sourceAttempt: "stalled:x", sourceOutcome: "stalled", sourceVersion: 1, deliveryKind: kind, payload,
      });
      dbModule.initDb().prepare("UPDATE callback_deliveries SET queue_item_id = ?, status = 'accepted' WHERE id = ?").run(noticeRow, delivery.id);
    };
    claim(LATERAL_STALL_DELIVERY_KIND, target.id, stalledSendPayload({ targetSessionId: target.id, waitedMinutes: 16, targetStatus: "running", turn: { kind: "silent", silentMinutes: 16 }, sends: opts.sends(rows) }));
    // Another kind of delivery, even one whose payload happens to look like a notice's.
    if (opts.otherKind) claim("parent-completion", "a-child", { ...stalledSendPayload({ targetSessionId: target.id, waitedMinutes: 1, targetStatus: "idle", turn: { kind: "other", laneRunning: false }, sends: opts.sends(rows) }), message: "child done" });
    return { rows, noticeRow };
  }

  it("is stale once every message it reported as waiting has run or been withdrawn, and not before", () => {
    const { rows, noticeRow } = park({ sends: ({ a, b }) => ({ queued: [a, b], unowned: [], dropped: [] }) });
    expect(staleLateralNoticeReason(noticeRow)).toBeNull();
    setStatus(rows.a, "completed");
    expect(staleLateralNoticeReason(noticeRow)).toBeNull();
    setStatus(rows.b, "cancelled");
    expect(staleLateralNoticeReason(noticeRow)).toMatch(/has since run or been withdrawn/);
  });

  it("keeps a notice that also reports a dropped message: that stays news", () => {
    const { rows, noticeRow } = park({ sends: ({ a, b }) => ({ queued: [a], unowned: [], dropped: [b] }) });
    setStatus(rows.b, "cancelled");
    setStatus(rows.a, "completed");
    expect(staleLateralNoticeReason(noticeRow)).toBeNull();
  });

  it("never drops a row that also carries another delivery", () => {
    const { rows, noticeRow } = park({ sends: ({ a }) => ({ queued: [a], unowned: [], dropped: [] }), otherKind: true });
    setStatus(rows.a, "completed");
    expect(staleLateralNoticeReason(noticeRow)).toBeNull();
  });

  it("never drops a row a message was folded into", () => {
    const { rows, noticeRow } = park({ sends: ({ a }) => ({ queued: [a], unowned: [], dropped: [] }), folded: true });
    setStatus(rows.a, "completed");
    expect(staleLateralNoticeReason(noticeRow)).toBeNull();
  });

  it("leaves any other row alone", () => {
    const sender = createParent("plain");
    expect(staleLateralNoticeReason(enqueueQueueItem(sender.id, sender.sessionKey!, "hello"))).toBeNull();
    expect(staleLateralNoticeReason(undefined)).toBeNull();
  });
});
