import { app } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from './atomicJson.js';
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
  fillerPool: 'eero',
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
};

function filePath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

/** Pre-v0.13.19 settings.json shape — single + filler split into two
 *  fields. Pre-v0.13.36: wheyProteinFillerOnly was a boolean before
 *  the multi-pool refactor. Used only by `loadSettings` for migration. */
type LegacyKnobs = {
  maxConcurrentSingleBuys?: number;
  maxConcurrentFillerBuys?: number;
  wheyProteinFillerOnly?: boolean;
};

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

    // v0.13.36 migration: wheyProteinFillerOnly (boolean) →
    // fillerPool (enum). true → 'whey' (preserve previous behavior),
    // false → 'general'. The new field is the source of truth going
    // forward.
    if (migrated.fillerPool === undefined && parsed.wheyProteinFillerOnly !== undefined) {
      migrated.fillerPool = parsed.wheyProteinFillerOnly ? 'whey' : 'general';
    }

    // v0.13.39 migration: bump the historical default 'whey' to 'eero'.
    // 'whey' was the original default (and was inherited from the
    // v0.13.36 migration above for everyone who had wheyProteinFillerOnly
    // = true, which itself was the pre-multi-pool default). So almost
    // every saved 'whey' is a default-by-inheritance, not a deliberate
    // choice. Users who actively picked 'general' or 'amazon-basics'
    // keep their choice — only the inherited default gets bumped.
    if (migrated.fillerPool === 'whey') {
      migrated.fillerPool = 'eero';
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
