import { app } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Settings } from '../shared/ipc.js';

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
  wheyProteinFillerOnly: true,
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
  // Streaming scheduler feature flag. When true, the worker uses the
  // account-aware streaming scheduler from
  // proposal-scheduler-redesign.md instead of today's per-job pMap +
  // lifecycleInFlight. Default OFF until Phase 3 flips it after live
  // validation. Setting this to true in settings.json activates the
  // scheduler on next worker start.
  streamingScheduler: false,
};

function filePath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

/** Pre-v0.13.19 settings.json shape — single + filler split into two
 *  fields. Used only by `loadSettings` for migration. */
type LegacyParallelKnobs = {
  maxConcurrentSingleBuys?: number;
  maxConcurrentFillerBuys?: number;
};

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await readFile(filePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<Settings> & LegacyParallelKnobs;

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

    return { ...DEFAULTS, ...migrated };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULTS };
    throw err;
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(filePath(), JSON.stringify(s, null, 2), 'utf8');
}
