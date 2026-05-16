import { appendFileSync } from 'node:fs';
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
   * order_confirmed   — confirmation page reached; an order IS placed
   *                     on Amazon. The bulletproof "this exists" line.
   * orderid_captured  — the post-buy scan resolved the orderId(s).
   * orderid_missing   — the post-buy scan came up empty.
   */
  event: 'order_confirmed' | 'orderid_captured' | 'orderid_missing';
  profile: string;
  jobId?: string | null;
  dealId?: string | null;
  productUrl?: string | null;
  url?: string;
  orderId?: string | null;
  amazonPurchaseId?: string | null;
  detail?: string;
};

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
