import { app } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from './atomicJson.js';
import type { FillerPool, Settings } from '../shared/ipc.js';

const DEFAULTS: Settings = {
  headless: true,
  bgBaseUrl: process.env.BG_BASE_URL ?? 'https://betterbg.vercel.app',
  // Default to Live mode — fresh installs should buy for real. Flip to true
  // via Settings if you want the dry-run preview (no Place Order click).
  buyDryRun: false,
  minCashbackPct: 6,
  // Matches the house-number prefixes AutoG hardcoded for BG's warehouses
  // (e.g. "13132 NE Portland Way" — prefix "13132"). Users can override via
  // the Settings UI if they ship to a different set.
  allowedAddressPrefixes: ['13132', '13130', '1146'],
  autoStartWorker: false,
  jobsColumnOrder: [],
  jobsColumnHidden: [],
  jobsStatusFilter: [],
  snapshotOnFailure: false,
  snapshotGroups: [],
  buyWithFillers: false,
  fillerCount: 8,
  // One eero attempt by default — no retries. Users add attempts (and
  // pick each one's pool) via the Filler Attempts UI.
  fillerAttempts: ['eero'],
  failedHiddenBeforeTs: null,
  hiddenAttemptIds: [],
  autoEnqueueEnabled: false,
  autoEnqueueIntervalHours: 24,
  autoEnqueueShipToFilter: 'oregon',
  // Default floor: -3.5% lets through every deal where the cashback
  // closes most of the retail-vs-payout gap. BG-side reactor commits at
  // -5% so this is a conservative inset that filters obvious losers
  // without rejecting marginal deals the user might still want.
  autoEnqueueMinMarginPct: -3.5,
  autoEnqueueMaxPerTick: 75,
  autoEnqueueLastRunAt: null,
  // How many Amazon accounts run a single deal in parallel. Each
  // account opens its own Chrome window — 3 is the safe default for
  // typical Apple Silicon Macs. Customers on older / fanless laptops
  // can dial down to 1.
  maxConcurrentBuys: 3,
  // Single daily fire time for Chase auto-redeem, shared across every
  // Chase profile that has `autoRedeem.enabled = true`. Pre-v0.13.42
  // each profile carried its own time; users found this surprising
  // and wanted one schedule that drives all accounts. HH:MM 24h, local
  // timezone. Default 15:00 (3 PM local) — matches the legacy default
  // on per-profile time so first-load behavior is unchanged for
  // anyone who never customised the time.
  chaseAutoRedeemTime: '15:00',
  // BG1/BG2 address-name toggle for cashback recovery — on by default
  // so existing installs behave the same as before this setting
  // existed. Operators on dial it off via Settings → Accounts when the
  // toggle is wasted time (structurally-ineligible account/deal pairs)
  // or when they want to manage the suffix manually on Amazon.
  bgNameToggleEnabled: true,
  // Global Prime-badge gate override. False (default) = enforce the
  // visible ✓prime check before buying. True = skip the check
  // worker-wide (every account, every job). See ipc.ts for the
  // full rationale.
  bypassPrimeCheck: false,
  // Redis pub/sub push (Path C migration, Phase 3). On by default
  // as of v0.13.79 after Phase 2 soak validated sub-100ms wakes and
  // the safety-net 10s Postgres poll remains active as defense in
  // depth. Users on saved settings keep their existing value; only
  // fresh installs pick up this default. Operators can flip off via
  // Settings → Accounts → "Use Redis push" if Upstash has issues.
  // See docs/migration/redis-pub-sub-push.md in the BetterBG repo.
  useRedisPush: true,
};

function filePath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

/** Pre-v0.13.19 settings.json shape — single + filler split into two
 *  fields. Pre-v0.13.36: wheyProteinFillerOnly was a boolean before
 *  the multi-pool refactor. Pre-v0.13.62: `fillerPool` was a single
 *  enum before the per-attempt `fillerAttempts` array. Used only by
 *  `loadSettings` for migration. */
type LegacyKnobs = {
  maxConcurrentSingleBuys?: number;
  maxConcurrentFillerBuys?: number;
  wheyProteinFillerOnly?: boolean;
  fillerPool?: FillerPool | 'whey';
};

const VALID_FILLER_POOLS: readonly FillerPool[] = [
  'general',
  'eero',
  'amazon-basics',
];

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await readFile(filePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<Settings> & LegacyKnobs;

    // v0.13.19 migration: the split single/filler concurrency knobs were
    // unified into one `maxConcurrentBuys` because the batch cart-add
    // refactor made filler-mode's per-account resource profile match
    // single-mode. Take min(single, filler) so users who throttled
    // filler-mode keep that lower cap globally instead of getting
    // bumped up.
    const migrated: Partial<Settings> = { ...parsed };
    if (migrated.maxConcurrentBuys === undefined) {
      const single = parsed.maxConcurrentSingleBuys;
      const filler = parsed.maxConcurrentFillerBuys;
      if (typeof single === 'number' || typeof filler === 'number') {
        const candidates = [single, filler].filter(
          (n): n is number => typeof n === 'number',
        );
        if (candidates.length > 0) {
          migrated.maxConcurrentBuys = Math.min(...candidates);
        }
      }
    }

    // v0.13.62 migration: the single `fillerPool` enum became the
    // `fillerAttempts` array (per-attempt pool plan — sets both the
    // retry count and each attempt's pool). Resolve the legacy value
    // through the older chain first:
    //   - pre-v0.13.36 it was the boolean `wheyProteinFillerOnly`
    //     (true → 'eero', false → 'general')
    //   - v0.13.40 removed the 'whey' pool → 'eero'
    // Migrate to a SINGLE attempt on the saved pool — matches the new
    // 1-attempt default. Retries are now opt-in: a user re-adds them
    // (with whatever pool per attempt) via the Filler Attempts UI.
    if (migrated.fillerAttempts === undefined) {
      let legacyPool: FillerPool | 'whey' | undefined = parsed.fillerPool;
      if (legacyPool === undefined && parsed.wheyProteinFillerOnly !== undefined) {
        legacyPool = parsed.wheyProteinFillerOnly ? 'eero' : 'general';
      }
      if (legacyPool === 'whey' || legacyPool === undefined) {
        legacyPool = 'eero';
      }
      migrated.fillerAttempts = [legacyPool];
    }
    // The legacy single-pool field no longer exists on Settings.
    delete (migrated as { fillerPool?: unknown }).fillerPool;

    // Normalize fillerAttempts to a sane shape regardless of source:
    // drop unknown pool values, clamp to 1–5 entries.
    {
      let fa = (migrated.fillerAttempts ?? []).filter(
        (p): p is FillerPool => VALID_FILLER_POOLS.includes(p),
      );
      if (fa.length === 0) fa = ['eero'];
      if (fa.length > 5) fa = fa.slice(0, 5);
      migrated.fillerAttempts = fa;
    }

    return { ...DEFAULTS, ...migrated };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULTS };
    throw err;
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  await writeJsonAtomic(filePath(), s);
}
