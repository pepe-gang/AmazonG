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
};

function filePath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

const VALID_FILLER_POOLS: readonly FillerPool[] = [
  'general',
  'eero',
  'amazon-basics',
];

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await readFile(filePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<Settings>;

    // Defensive normalization for fillerAttempts: drop unknown pool
    // values and clamp 1–5 entries. Guards against hand-edited
    // settings.json or out-of-range arrays.
    let fa = (parsed.fillerAttempts ?? []).filter(
      (p): p is FillerPool => VALID_FILLER_POOLS.includes(p),
    );
    if (fa.length === 0) fa = ['eero'];
    if (fa.length > 5) fa = fa.slice(0, 5);
    parsed.fillerAttempts = fa;

    return { ...DEFAULTS, ...parsed };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULTS };
    throw err;
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  await writeJsonAtomic(filePath(), s);
}
