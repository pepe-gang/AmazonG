/**
 * Pure parsers + signal classifier for the cancel_fillers worker.
 *
 * Splits "what HTML did Amazon return?" from "what state-machine
 * signal does that map to?", so each can be unit-tested with
 * fixtures (per AGENTS.md §Testing — every production bug gets a
 * fixture + test).
 *
 * The signals match BG's `FillerCancelSignal` union exactly so the
 * worker can pass classifier output straight through to the report
 * payload.
 */

import { JSDOM } from 'jsdom';

export type CancelFillerSignal =
  | 'cancel_confirmed'
  | 'cancel_unable'
  | 'order_already_cancelled'
  | 'order_shipped_detected'
  | 'order_not_found'
  | 'transient_error'
  | 'danger_target_in_order';

export type OrderProbeOutcome = {
  signal: CancelFillerSignal;
  /** Tracking codes scraped when shipped — caller forwards to BG. */
  trackingIds?: string[];
  /** Detail captured for logs / lastError. */
  detail?: string;
};

/**
 * Classify the order-details page HTML into a signal. Order:
 *
 *   1. order_not_found      — Amazon "we couldn't find that order"
 *   2. order_already_cancelled — "This order has been cancelled" banner
 *      scoped to <div data-component="cancelled">
 *   3. order_shipped_detected — any `[data-component]` referencing a
 *      shipment (shipmentTracking, shippedItem) OR a ship-track link
 *      OR an "Unable to cancel" / "View return options" copy
 *   4. fall-through          — order is presumably still cancellable
 *
 * Pure DOM input — caller does the fetch.
 */
export function classifyOrderDetailsHtml(html: string): OrderProbeOutcome {
  const errMatch = html.match(
    /(We(?:'|’)re unable to load your order(?: details)?|We can(?:'|’)t (?:find|display|retrieve) (?:that|this|your) order|Sorry,?\s*something went wrong|order you (?:requested|specified) (?:could not be|cannot be) found)/i,
  );
  if (errMatch) {
    return {
      signal: 'order_not_found',
      detail: errMatch[0].slice(0, 120),
    };
  }

  // Same scoped match the existing verifyOrder uses — only true when
  // the cancellation banner appears INSIDE the data-component="cancelled"
  // wrapper (Amazon renders an empty wrapper on every page; the inner
  // text is the actual signal).
  const cancelledRe =
    /<div[^>]+data-component=["']cancelled["'][^>]*>[\s\S]{0,3000}?This order has been cancell?ed/i;
  if (cancelledRe.test(html)) {
    return { signal: 'order_already_cancelled' };
  }

  // "Unable to cancel" copy — Amazon refuses pre-ship cancellation
  // because the order has progressed into fulfillment. Treat as shipped
  // for state-machine purposes (the order will ship; we want to enter
  // tracking-fetch mode).
  if (
    /Unable to cancel(?: requested items)?|cannot be cancell?ed|cannot cancel this order/i.test(
      html,
    )
  ) {
    return {
      signal: 'cancel_unable',
      detail: 'Amazon refused pre-ship cancel',
    };
  }

  // Shipped detection — tracking link OR explicit ship-track URL.
  const trackingIds = extractTrackingIdsFromOrderHtml(html);
  if (
    trackingIds.length > 0 ||
    /href="[^"]*\/gp\/your-account\/ship-track[^"]*"/i.test(html) ||
    /Track package|View shipment|Shipment\s+\d+\s+of/i.test(html)
  ) {
    return {
      signal: 'order_shipped_detected',
      ...(trackingIds.length > 0 ? { trackingIds } : {}),
    };
  }

  // None of the above triggered — order is presumably still in the
  // cancellable window. Caller falls through to attempting the cancel
  // form.
  return { signal: 'transient_error', detail: 'order-details page indeterminate' };
}

/**
 * Defensive ASIN check — returns true when any anchor on the order-
 * details page links to /dp/<targetAsin>. The cancel worker calls
 * this BEFORE clicking Cancel; a true result triggers the
 * `danger_target_in_order` signal (catastrophic-loss prevention if
 * a parser bug ever classified the user's actual deal order as a
 * filler). Cheap O(N) scan.
 */
export function orderContainsAsin(html: string, targetAsin: string): boolean {
  if (!targetAsin) return false;
  // /dp/B0XYZ123 or /gp/product/B0XYZ123 — both on order-details rows.
  const re = new RegExp(
    `/(?:dp|gp/product)/${escapeRegex(targetAsin)}\\b`,
    'i',
  );
  return re.test(html);
}

/**
 * Extract carrier tracking IDs from the order-details page. Reuses
 * the same `data-component="shipmentTracking"` blocks the existing
 * shipTrack flow scrapes. Best-effort — returns empty array when no
 * codes are visible (shipment progress beacon hasn't issued yet).
 *
 * Distinct from `actions/fetchTracking.ts`'s flow (which makes
 * separate per-shipment HTTP calls to ship-track URLs) — this one
 * reads codes that are inline on the order-details HTML, when
 * Amazon happens to surface them there. The cancel worker prefers
 * inline because each filler order is a single round-trip; the
 * fetchTracking-style sub-fetches are a fallback when needed.
 */
export function extractTrackingIdsFromOrderHtml(html: string): string[] {
  const ids = new Set<string>();
  // Amazon's ship-track URL has the carrier tracking id in
  // ?shipmentId= or ?packageIndex= — but we extract the tracking
  // number from the visible "Tracking ID: TBA123..." copy instead,
  // since that's stable across templates.
  const dom = new JSDOM(html);
  const text = dom.window.document.body?.textContent ?? '';
  // Common carrier patterns. Order matters: most-specific first.
  const patterns: RegExp[] = [
    /\bTBA\d{10,15}\b/g, // Amazon Logistics
    /\b1Z[A-Z0-9]{16}\b/g, // UPS
    /\b9\d{15,21}\b/g, // USPS
    /\b\d{12,14}\b/g, // FedEx (broad — last to avoid shadowing)
  ];
  for (const re of patterns) {
    const matches = text.match(re);
    if (matches) for (const m of matches) ids.add(m);
  }
  return [...ids];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Translate cancelFillerOrder result → signal. Used by the worker
 * after running the cancel form. Order:
 *   1. r.ok                                          → cancel_confirmed
 *   2. /unable to cancel/                            → cancel_unable
 *   3. /not on cancel-items page/                    → caller probes
 *      order-details for ground truth (could mean already-cancelled
 *      OR shipped) — return null so caller does the deeper probe.
 *   4. anything else                                 → transient_error
 */
export function cancelFormResultToSignal(
  ok: boolean,
  reason?: string,
): CancelFillerSignal | null {
  if (ok) return 'cancel_confirmed';
  const r = (reason ?? '').toLowerCase();
  if (/unable to cancel/.test(r)) return 'cancel_unable';
  if (/not on cancel-items page/.test(r)) return null; // ambiguous — probe further
  return 'transient_error';
}
