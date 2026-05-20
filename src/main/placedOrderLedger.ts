import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

/**
 * Append-only, fully durable ledger of order placements.
 *
 * WHY THIS EXISTS — the ghost-order bug. A buy can place a real order
 * on Amazon and then leave zero trace in AmazonG: no attempt row in
 * job-attempts.json, no job-log file, nothing in BG. Every other
 * record path (jobStore, the disk-log sink) is debounced / buffered /
 * cache-backed, so a busy run, a crash, or a restart can drop the
 * record while the order is already live on Amazon.
 *
 * This ledger is the one record that CANNOT be lost:
 *   - `appendFileSync` — the line is on disk before the next
 *     statement runs. No debounce, no in-memory cache, no batching.
 *   - written from INSIDE the buy flow the instant the confirmation
 *     page is reached — before orderId capture, before any reporting,
 *     before anything downstream can fail.
 *
 * On disk: userData/placed-orders.jsonl — one JSON object per line.
 *
 * Diagnostic use: after a ghost, diff this file against
 * job-attempts.json and BG. An `order_confirmed` line with no
 * matching attempt row pinpoints the loss to the record/report
 * stage. NO `order_confirmed` line means the buy flow never reached
 * confirmation on this machine at all.
 *
 * Lazy electron load via createRequire so importing this module is
 * harmless in non-electron contexts (tests): there it resolves to a
 * silent no-op rather than throwing.
 */

const nodeRequire = createRequire(import.meta.url);

export type PlacedOrderEvent = {
  /**
   * place_order_submitted — written SYNCHRONOUSLY immediately before the
   *                     Place Order click, so a placed order has a
   *                     durable record even if the run dies / the
   *                     confirmation never resolves. The reconciliation
   *                     pass pairs this against a TERMINAL event by
   *                     `submissionId`; an unpaired one is a ghost
   *                     candidate. Carries `cartAsins` + `preBuyOrderIds`
   *                     so reconciliation can run an airtight diff-mode
   *                     order-history scan with no buy-flow state.
   * order_confirmed   — confirmation page reached; an order IS placed
   *                     on Amazon. NOT terminal on its own.
   * orderid_captured  — the post-buy scan resolved the orderId(s).
   *                     TERMINAL — the buy fully tracked the order.
   * orderid_missing   — the post-buy scan came up empty. NOT terminal:
   *                     an order may simply not have propagated to
   *                     order history yet — reconciliation must retry.
   * reported_to_bg    — the buy bundle's status report was POSTed to BG.
   *                     `detail` carries the outcome (ok / the error).
   *                     NOT terminal — records delivery, not resolution.
   *                     Closes the "captured but never reached BG" gap.
   * reconcile_recovered — the reconciliation pass found + handled a
   *                     previously-unrecorded order. TERMINAL.
   * reconcile_abandoned — reconciliation retried past its time budget
   *                     and gave up (no order ever appeared). TERMINAL.
   */
  event:
    | 'place_order_submitted'
    | 'order_confirmed'
    | 'orderid_captured'
    | 'orderid_missing'
    | 'reported_to_bg'
    | 'reconcile_recovered'
    | 'reconcile_abandoned';
  /** Correlates a place_order_submitted with its terminal event. */
  submissionId?: string;
  profile: string;
  jobId?: string | null;
  dealId?: string | null;
  productUrl?: string | null;
  url?: string;
  orderId?: string | null;
  amazonPurchaseId?: string | null;
  /** Full cart ASIN list (target + fillers) — set on place_order_submitted. */
  cartAsins?: string[];
  /** Pre-buy order-history snapshot — set on place_order_submitted so
   *  reconciliation's scan is a clean diff (can't false-match an old order). */
  preBuyOrderIds?: string[];
  /** Cashback % the buy locked in on /spc. Set on `orderid_captured`
   *  (and the equivalent `order_confirmed` recovery path) so a
   *  ghost-recovery pass can populate the BG purchase row's CB column.
   *  Without it, reconciler-healed orders show "—" in the dashboard
   *  and Profit can't compute. */
  placedCashbackPct?: number | null;
  /** Final/retail price as a "$N.NN" string (the confirmation page's
   *  reading, falling back to the PDP price). Forwarded by
   *  ghost-recovery so the BG purchase row gets the real placed price
   *  instead of the dashboard fallback to deal.maxPrice. */
  placedPrice?: string | null;
  detail?: string;
};

/** A ledger event as read back from disk — carries the write timestamp. */
export type StoredPlacedOrderEvent = PlacedOrderEvent & { ts: string };

function ledgerPath(): string | null {
  try {
    const electron = nodeRequire('electron') as typeof import('electron');
    return join(electron.app.getPath('userData'), 'placed-orders.jsonl');
  } catch {
    return null;
  }
}

/**
 * Append one placement event to the durable ledger. Best-effort and
 * fully self-contained — never throws, never blocks, and a write
 * failure is swallowed (a buy must not break on a ledger write).
 */
export function recordPlacedOrderEvent(evt: PlacedOrderEvent): void {
  const path = ledgerPath();
  if (!path) return;
  try {
    appendFileSync(
      path,
      JSON.stringify({ ts: new Date().toISOString(), ...evt }) + '\n',
    );
  } catch {
    // never break a buy on a ledger write
  }
}

/**
 * Read the whole ledger back. Used by the reconciliation pass to find
 * `place_order_submitted` breadcrumbs that never got a terminal event.
 * Best-effort — a missing file or a malformed line yields [] / skips
 * the line rather than throwing.
 */
export function readPlacedOrderEvents(): StoredPlacedOrderEvent[] {
  const path = ledgerPath();
  if (!path) return [];
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const out: StoredPlacedOrderEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as StoredPlacedOrderEvent);
    } catch {
      // skip a torn / malformed line
    }
  }
  return out;
}

/** Events that terminally resolve a submission — the buy captured the
 *  orderId, or reconciliation recovered it / gave up. A buy-time
 *  `orderid_missing` is deliberately NOT here: the order may simply not
 *  have propagated to order history yet, so reconciliation must retry. */
const TERMINAL_EVENTS: ReadonlySet<PlacedOrderEvent['event']> = new Set([
  'orderid_captured',
  'reconcile_recovered',
  'reconcile_abandoned',
]);

/**
 * Pure pairing logic — given the full event list, return every
 * `place_order_submitted` breadcrumb with NO terminal event sharing its
 * `submissionId`. Extracted from `unreconciledSubmissions` so it's
 * unit-testable without touching the filesystem.
 */
export function findUnreconciledSubmissions(
  events: StoredPlacedOrderEvent[],
): StoredPlacedOrderEvent[] {
  const resolved = new Set<string>();
  for (const e of events) {
    if (e.submissionId && TERMINAL_EVENTS.has(e.event)) {
      resolved.add(e.submissionId);
    }
  }
  return events.filter(
    (e) =>
      e.event === 'place_order_submitted' &&
      !!e.submissionId &&
      !resolved.has(e.submissionId),
  );
}

/**
 * Every `place_order_submitted` breadcrumb that has NO terminal event
 * sharing its `submissionId` — i.e. an order that may be live on Amazon
 * but was never fully recorded. Returns the breadcrumb itself (carries
 * profile / cartAsins / preBuyOrderIds / ts) so the reconciliation pass
 * can drive recovery with no buy-flow state.
 */
export function unreconciledSubmissions(): StoredPlacedOrderEvent[] {
  return findUnreconciledSubmissions(readPlacedOrderEvents());
}
