/**
 * Per-account read/write lock for the streaming scheduler.
 *
 * Phase-aware semantics from proposal-scheduler-redesign.md §3:
 *   - `buy` phase mutates the BrowserContext's cart + cookies +
 *     /spc session. Two parallel buys against the same account
 *     would race on cart state and risk a duplicate or wrong
 *     order. Hold an exclusive WRITE lock.
 *   - `verify` and `fetch_tracking` are HTTP-only reads via
 *     `ctx.request.get` (verifyOrder.ts:80, fetchTracking.ts:57).
 *     Idempotent reads. Multiple in flight against the same
 *     account is safe.
 *
 * Two policy variants, selected per call site:
 *
 *   acquireWrite:    waits for any in-flight readers OR writer.
 *                    Used for `buy` phase tuples.
 *
 *   acquireRead:     waits only for an in-flight writer. Multiple
 *                    readers concurrent on the same key.
 *
 *   acquireRead_conservative:
 *                    waits for readers AND writer. Same as
 *                    acquireWrite. Phase 1 lock policy — matches
 *                    today's "drain lifecycle before buy" behavior.
 *                    Aggressive policy (acquireRead) deferred to
 *                    Phase 2 lock-policy decision after empirical
 *                    confirmation that verify-during-buy on the
 *                    same account doesn't trip Amazon anti-bot
 *                    heuristics.
 *
 * Critical invariant: lock is acquired BEFORE any Amazon HTTP/page
 * work in the tuple (proposal §9 risk row #1). A wrong lock impl
 * risks duplicate orders. This file is unit-tested directly with
 * the semantics covered.
 */

export type AccountKey = string;

/** Returned by `acquire*` — call to release the held lock. */
export type ReleaseFn = () => void;

export class AccountLock {
  private writers = new Map<AccountKey, Promise<void>>();
  private readers = new Map<AccountKey, Set<Promise<void>>>();

  /**
   * Exclusive lock — held by `buy`-phase tuples. Waits for any in-flight
   * readers OR writer on the same key. Different keys never block.
   *
   * Returns a release function. **Must be called in a `finally` so a
   * thrown handler doesn't leak the lock.**
   */
  async acquireWrite(k: AccountKey): Promise<ReleaseFn> {
    while (this.writers.has(k) || (this.readers.get(k)?.size ?? 0) > 0) {
      const wait: Promise<unknown>[] = [];
      const w = this.writers.get(k);
      if (w) wait.push(w);
      const rs = this.readers.get(k);
      if (rs) wait.push(...rs);
      // Race ALL holders — we wake when any one releases. Loop re-checks
      // both maps; another candidate may still be holding when we wake.
      await Promise.race(wait).catch(() => undefined);
    }
    let release!: () => void;
    const p = new Promise<void>((r) => (release = r));
    this.writers.set(k, p);
    return () => {
      this.writers.delete(k);
      release();
    };
  }

  /**
   * Shared lock — Phase 2 aggressive policy. Waits only for an in-flight
   * writer; concurrent readers on the same key are allowed.
   *
   * **Currently unused by production code.** The Phase 1 scheduler
   * always calls `acquireWrite` (and `acquireRead_conservative` is a
   * thin alias to `acquireWrite`). Kept here so Phase 2 can flip the
   * policy with a single call-site swap once the empirical test in
   * proposal §14 open question #1 confirms it's safe.
   */
  async acquireRead(k: AccountKey): Promise<ReleaseFn> {
    while (this.writers.has(k)) {
      await this.writers.get(k)!.catch(() => undefined);
    }
    let release!: () => void;
    const p = new Promise<void>((r) => (release = r));
    let bag = this.readers.get(k);
    if (!bag) {
      bag = new Set();
      this.readers.set(k, bag);
    }
    bag.add(p);
    return () => {
      bag!.delete(p);
      if (bag!.size === 0) this.readers.delete(k);
      release();
    };
  }

  /**
   * Conservative read lock — equivalent to a write lock. Used in Phase 1
   * to mirror today's behavior (verify drains before buy starts at
   * pollAndScrape.ts:762-764). Switching to `acquireRead` is gated on
   * the empirical test in proposal §14 open question #1.
   */
  async acquireRead_conservative(k: AccountKey): Promise<ReleaseFn> {
    return this.acquireWrite(k);
  }

  /** Inspection helpers used by the consumer's skip-blocked dispatch. */

  isWriteHeld(k: AccountKey): boolean {
    return this.writers.has(k);
  }

  isReadHeld(k: AccountKey): boolean {
    return (this.readers.get(k)?.size ?? 0) > 0;
  }

  isAnyHeld(k: AccountKey): boolean {
    return this.isWriteHeld(k) || this.isReadHeld(k);
  }
}
