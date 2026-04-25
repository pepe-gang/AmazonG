import type { AmazonDeal } from '../shared/ipc.js';
import type { JobAttempt } from '../shared/types.js';
import { loadSettings, saveSettings } from './settings.js';
import { listAttempts } from './jobStore.js';
import { createBGClient } from '../bg/client.js';
import { logger } from '../shared/logger.js';

/**
 * Outcome of a single tick. Held in memory only — exposed to the
 * renderer via getAutoEnqueueStatus() so the user can see what just
 * happened. `runAt` is the wall-clock time the tick started; `error`
 * is non-null only when the deal-fetch itself blew up (not when
 * individual triggerDealJob calls fail — those count under `failed`).
 */
export type AutoEnqueueResult = {
  runAt: number;
  queued: number;
  skipped: number;
  failed: number;
  error: string | null;
};

const TICK_MS = 60_000;

let tickHandle: NodeJS.Timeout | null = null;
let initialKickoff: NodeJS.Timeout | null = null;
let lastResult: AutoEnqueueResult | null = null;
// Single-flight guard. Ticks are rare and short, but if the user has a
// slow link a second tick could start before the first finishes.
let inFlight = false;

type Deps = {
  /** Reads current AutoG bearer. Captured as a closure so the scheduler
   *  always sees the live key even after connect/disconnect cycles. */
  getApiKey: () => string | null;
};

export function startAutoEnqueueScheduler(deps: Deps): void {
  if (tickHandle) return;
  tickHandle = setInterval(() => {
    void tick(deps);
  }, TICK_MS);
  // First tick fires shortly after start so a freshly-enabled schedule
  // doesn't make the user wait a full minute to see something happen.
  initialKickoff = setTimeout(() => {
    void tick(deps);
  }, 5_000);
}

export function stopAutoEnqueueScheduler(): void {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
  if (initialKickoff) {
    clearTimeout(initialKickoff);
    initialKickoff = null;
  }
}

export async function getAutoEnqueueStatus(): Promise<{
  enabled: boolean;
  intervalHours: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
  lastResult: AutoEnqueueResult | null;
}> {
  const s = await loadSettings();
  const intervalH = clampInterval(s.autoEnqueueIntervalHours);
  const intervalMs = intervalH * 3_600_000;
  const lastRunAt = s.autoEnqueueLastRunAt;
  const nextRunAt = s.autoEnqueueEnabled
    ? lastRunAt
      ? lastRunAt + intervalMs
      : Date.now()
    : null;
  return {
    enabled: s.autoEnqueueEnabled,
    intervalHours: intervalH,
    lastRunAt,
    nextRunAt,
    lastResult,
  };
}

// ───────────────────────────── pure helpers ─────────────────────────────
//
// These are the testable surface of the scheduler. Kept side-effect-free
// so unit tests can exercise edge cases (boundary margin values, expiry
// rollover, dedup window math) without mocking fetch / BG client / fs.

/**
 * Margin = (payout - retail) / retail * 100. Mirrors the Deals UI's
 * margin column, so what the user sees and what the schedule filters
 * on are the same number. Returns null if payout is missing entirely;
 * 0 if retail is missing or zero (BG convention: "no retail recorded"
 * means payout == retail for display purposes).
 */
export function marginPct(deal: Pick<AmazonDeal, 'price' | 'oldPrice'>): number | null {
  const price = parseDecimal(deal.price);
  if (price === null) return null;
  const oldPrice = parseDecimal(deal.oldPrice);
  if (oldPrice === null || oldPrice === 0) return 0;
  // Round to 4 decimal places so a user-entered floor like -3.5 isn't
  // tripped by a FP artefact such as -3.5000000000000004 from the
  // canonical (p-r)/r*100 chain. The Deals UI only renders 1 decimal
  // place anyway, so 4 is plenty of headroom for any meaningful
  // comparison the user could make.
  const raw = ((price - oldPrice) / oldPrice) * 100;
  return Math.round(raw * 10_000) / 10_000;
}

function parseDecimal(v: string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Has this deal expired by the time the tick runs? `expiryDay` is BG's
 * "MM-DD-YYYY" string; null means "no expiry on file" (always active).
 * A malformed string is treated as active so a parse failure on BG's
 * side doesn't silently drop the user's eligible deals — the trigger
 * endpoint will reject server-side if the deal really is dead.
 */
export function isDealActive(
  deal: Pick<AmazonDeal, 'expiryDay'>,
  now: Date = new Date(),
): boolean {
  if (!deal.expiryDay) return true;
  const parts = deal.expiryDay.split('-').map((n) => parseInt(n, 10));
  const [mm, dd, yyyy] = parts;
  if (!mm || !dd || !yyyy) return true;
  // Compare end-of-day in local time so a deal expiring "today" is
  // still active right up until midnight, matching how the Deals page
  // shows it.
  const expiry = new Date(yyyy, mm - 1, dd, 23, 59, 59).getTime();
  return expiry >= now.getTime();
}

/**
 * Ship-to filter check. Empty `shipToStates` means "ships anywhere"
 * per BG's schema, so it always passes. 'all' as the filter disables
 * the check entirely.
 */
export function passesShipTo(
  deal: Pick<AmazonDeal, 'shipToStates'>,
  filter: string,
): boolean {
  const f = filter.toLowerCase();
  if (f === 'all') return true;
  if (deal.shipToStates.length === 0) return true;
  return deal.shipToStates.some((s) => s.toLowerCase() === f);
}

export type SelectInput = {
  deals: AmazonDeal[];
  attempts: Pick<JobAttempt, 'phase' | 'dealKey' | 'createdAt'>[];
  shipToFilter: string;
  minMarginPct: number;
  intervalHours: number;
  maxPerTick: number;
  now: number;
};

export type SelectOutput = {
  /** Deals that passed every filter and the cap — the tick should
   *  enqueue these in order. */
  todo: AmazonDeal[];
  /** Eligible deals dropped because they were already attempted within
   *  the dedup window. */
  skippedDup: number;
  /** Eligible deals dropped because the cap was reached this tick. */
  skippedCap: number;
};

/**
 * Decide what to enqueue this tick. Pure function over (current deal
 * catalog, attempt history, settings, wall-clock). The scheduler's
 * tick() wraps this with the side effects (fetch, trigger, persist).
 *
 * Filter pipeline:
 * 1. Active (not expired)
 * 2. Ship-to match
 * 3. Margin >= floor (inclusive)
 * 4. No buy attempt for the same dealKey within max(intervalHours, 24)h
 * 5. Cap at maxPerTick
 *
 * The dedup window floor of 24h is critical when intervalHours < 24:
 * without it a 1-hour schedule would re-buy the same deal 24x/day even
 * though the previous attempt is sitting right there in the ring
 * buffer — the lookback would be only 1 hour wide.
 */
export function selectDealsForTick(input: SelectInput): SelectOutput {
  const today = new Date(input.now);
  const eligible = input.deals.filter((d) => {
    if (!isDealActive(d, today)) return false;
    if (!passesShipTo(d, input.shipToFilter)) return false;
    const m = marginPct(d);
    // null margin means we couldn't compute one (no payout) — drop it
    // because the user's threshold can't be evaluated.
    if (m === null) return false;
    return m >= input.minMarginPct;
  });

  const dedupWindowH = Math.max(clampInterval(input.intervalHours), 24);
  const cutoff = input.now - dedupWindowH * 3_600_000;
  const recentDealKeys = new Set<string>();
  for (const a of input.attempts) {
    if (a.phase !== 'buy') continue;
    if (!a.dealKey) continue;
    const ts = Date.parse(a.createdAt);
    if (Number.isFinite(ts) && ts >= cutoff) recentDealKeys.add(a.dealKey);
  }

  const survivors: AmazonDeal[] = [];
  let skippedDup = 0;
  for (const d of eligible) {
    if (recentDealKeys.has(d.dealKey)) {
      skippedDup++;
      continue;
    }
    survivors.push(d);
  }

  const cap = clampMaxPerTick(input.maxPerTick);
  const todo = survivors.slice(0, cap);
  const skippedCap = survivors.length > cap ? survivors.length - cap : 0;
  return { todo, skippedDup, skippedCap };
}

export function clampInterval(h: number): number {
  if (!Number.isFinite(h)) return 24;
  return Math.max(1, Math.min(168, Math.floor(h)));
}

export function clampMaxPerTick(n: number): number {
  if (!Number.isFinite(n)) return 25;
  return Math.max(1, Math.min(1000, Math.floor(n)));
}

// ───────────────────────────── tick ─────────────────────────────────────

async function tick(deps: Deps): Promise<void> {
  if (inFlight) return;

  const settings = await loadSettings().catch(() => null);
  if (!settings || !settings.autoEnqueueEnabled) return;

  const intervalMs = clampInterval(settings.autoEnqueueIntervalHours) * 3_600_000;
  const lastRunAt = settings.autoEnqueueLastRunAt ?? 0;
  const now = Date.now();
  if (now - lastRunAt < intervalMs) return;

  const apiKey = deps.getApiKey();
  // Not connected → skip silently and try again on the next tick. We
  // don't stamp lastRunAt so the schedule isn't penalised for the user
  // being offline at the moment a tick happened to fire.
  if (!apiKey) return;

  inFlight = true;
  const result: AutoEnqueueResult = {
    runAt: now,
    queued: 0,
    skipped: 0,
    failed: 0,
    error: null,
  };
  try {
    const url = new URL('/api/public/deals/amazon', settings.bgBaseUrl).toString();
    const r = await fetch(url, { headers: { 'x-api-key': 'pepe-gang' } });
    if (!r.ok) {
      throw new Error(`deals fetch failed: HTTP ${r.status} ${r.statusText}`);
    }
    const data = (await r.json()) as unknown;
    if (!Array.isArray(data)) throw new Error('deals fetch failed: expected an array');
    const deals = data as AmazonDeal[];

    const attempts = await listAttempts().catch(() => []);
    const { todo, skippedDup, skippedCap } = selectDealsForTick({
      deals,
      attempts,
      shipToFilter: settings.autoEnqueueShipToFilter,
      minMarginPct: settings.autoEnqueueMinMarginPct,
      intervalHours: settings.autoEnqueueIntervalHours,
      maxPerTick: settings.autoEnqueueMaxPerTick,
      now,
    });
    result.skipped = skippedDup + skippedCap;

    const bg = createBGClient(settings.bgBaseUrl, apiKey);
    for (const d of todo) {
      try {
        await bg.triggerDealJob(d.dealId);
        result.queued++;
      } catch (err) {
        result.failed++;
        logger.warn('autoEnqueue.trigger.error', {
          dealId: d.dealId,
          dealKey: d.dealKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Stamp the run AFTER the work is done so a long-running tick
    // doesn't double-fire. Re-load settings to merge against any UI
    // edits that happened mid-tick (the user may have toggled the
    // schedule off, changed interval, etc.).
    const fresh = await loadSettings();
    await saveSettings({ ...fresh, autoEnqueueLastRunAt: now });

    lastResult = result;
    logger.info('autoEnqueue.run', {
      queued: result.queued,
      skipped: result.skipped,
      skippedDup,
      skippedCap,
      failed: result.failed,
      total: deals.length,
    });
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    lastResult = result;
    logger.warn('autoEnqueue.error', { error: result.error });
    // Don't stamp lastRunAt — a network failure shouldn't burn the
    // interval. We'll retry on the next minute tick.
  } finally {
    inFlight = false;
  }
}
