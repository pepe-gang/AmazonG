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
  // How many Amazon accounts run a single deal in parallel. Single-mode
  // buys are light enough that 3 accounts at once is the historical
  // default. Filler-mode carts are heavier and Amazon is touchier on
  // rapid-fire filler checkouts, so default 1 (one account at a time).
  // Customers with thermal headroom can dial these up; customers with
  // older / fanless laptops can dial them down to 1 to stay quiet.
  maxConcurrentSingleBuys: 3,
  maxConcurrentFillerBuys: 1,
  // Parallel tabs inside ONE filler-mode buy. Each tab fires its own
  // Add-to-Cart POSTs against Amazon's cart API; they share cookies
  // + cart server-side so all adds land on the same order. 4 has
  // historically given a clean ~4× speedup without hitting rate
  // limits. 1 = sequential (slow but safest). 6 max (going higher
  // can trigger Amazon's per-IP throttling on the cart endpoint).
  fillerParallelTabs: 4,
  // Run Chase automation (snapshot fetch + rewards redemption) with
  // a hidden Chrome window. Default OFF because Chase's anti-bot
  // detection (banking-grade) flags headless via WebGL fingerprint,
  // missing window.chrome, plugin list, etc. — going beyond UA.
  // Visible mode reliably works; headless is best-effort and may
  // get stuck on snapshot fetches for some accounts. Login + Pay
  // flows always open visible regardless.
  chaseHeadless: false,
};

function filePath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await readFile(filePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULTS, ...parsed };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULTS };
    throw err;
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(filePath(), JSON.stringify(s, null, 2), 'utf8');
}
