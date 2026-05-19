import {
  readPlacedOrderEvents,
  recordPlacedOrderEvent,
} from '../main/placedOrderLedger.js';
import type { BGClient } from '../bg/client.js';
import { logger } from '../shared/logger.js';

/** Only reconcile captures from the last 48h — older ones were handled by
 *  earlier passes, and this keeps each pass cheap. */
const RECONCILE_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * Worker-integrated ghost-order reconcile pass — the permanent safety net.
 *
 * The durable ledger records `orderid_captured` the instant a buy captures
 * an Amazon order id. The report path to BG is fragile (batched per job,
 * fired late, lost on reclaim), so a captured order can fail to reach BG —
 * a "ghost". This pass pushes every recent captured order to BG's
 * recover-order endpoint, which is idempotent + conflict-safe (it never
 * clobbers a real order id).
 *
 * A `reconcile_recovered` ledger marker is written per submission once BG
 * returns a verdict, so each capture is pushed exactly once. A transport
 * error leaves it unmarked → retried next pass.
 *
 * Fire-and-forget; never throws — a reconcile pass must not break the
 * worker.
 */
export async function reconcileLedgerToBG(bg: BGClient): Promise<void> {
  try {
    const events = readPlacedOrderEvents();

    const alreadyReconciled = new Set<string>();
    for (const e of events) {
      if (e.event === 'reconcile_recovered' && e.submissionId) {
        alreadyReconciled.add(e.submissionId);
      }
    }

    // Per-submission filler flag — a place_order_submitted breadcrumb from
    // filler mode carries the full cart (target + filler ASINs); single
    // mode carries just the one target ASIN. >1 ASIN ⇒ a filler buy.
    const viaFillerBySubmission = new Map<string, boolean>();
    for (const e of events) {
      if (e.event === 'place_order_submitted' && e.submissionId) {
        viaFillerBySubmission.set(
          e.submissionId,
          (e.cartAsins?.length ?? 0) > 1,
        );
      }
    }

    const cutoff = Date.now() - RECONCILE_WINDOW_MS;
    // One captured order per submissionId — recent, not yet reconciled.
    const todo = new Map<
      string,
      {
        jobId: string;
        profile: string;
        orderId: string;
        amazonPurchaseId: string | null;
        viaFiller: boolean;
      }
    >();
    for (const e of events) {
      if (
        e.event === 'orderid_captured' &&
        e.submissionId &&
        e.jobId &&
        e.orderId &&
        !alreadyReconciled.has(e.submissionId) &&
        new Date(e.ts).getTime() >= cutoff
      ) {
        todo.set(e.submissionId, {
          jobId: e.jobId,
          profile: e.profile,
          orderId: e.orderId,
          amazonPurchaseId: e.amazonPurchaseId ?? null,
          viaFiller: viaFillerBySubmission.get(e.submissionId) ?? false,
        });
      }
    }
    if (todo.size === 0) return;

    let healed = 0;
    let noop = 0;
    for (const [submissionId, c] of todo) {
      try {
        const res = await bg.recoverOrder(c.jobId, {
          amazonEmail: c.profile,
          orderId: c.orderId,
          amazonPurchaseId: c.amazonPurchaseId,
          viaFiller: c.viaFiller,
        });
        // BG returned a verdict (recovered / already-recorded / conflict /
        // job-not-found) — all definitive. Mark it so it's not re-pushed.
        recordPlacedOrderEvent({
          event: 'reconcile_recovered',
          submissionId,
          profile: c.profile,
          jobId: c.jobId,
          orderId: c.orderId,
          detail: res?.recovered
            ? 'recovered to BG'
            : `noop: ${res?.reason ?? 'unknown'}`,
        });
        if (res?.recovered) healed++;
        else noop++;
      } catch {
        // Transport / server error — leave unmarked, retry next pass.
      }
    }
    logger.info(
      'reconcile.ledger.done',
      { checked: todo.size, healed, noop },
      'worker',
    );
  } catch {
    // A reconcile pass must never break the worker.
  }
}
