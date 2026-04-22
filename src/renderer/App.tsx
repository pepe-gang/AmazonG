import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AmazonProfile,
  JobAttempt,
  JobAttemptStatus,
  LogEvent,
  RendererStatus,
} from '@shared/types';
import type { Settings } from '@shared/ipc';
import { SNAPSHOT_ERROR_GROUPS } from '@shared/snapshotGroups';
import { parsePrice } from '@parsers/amazonProduct';

const SETUP_GUIDE_URL = 'https://betterbg.vercel.app/dashboard/auto-buy';

function stripIpcPrefix(msg: string): string {
  return msg.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '').trim();
}

/** Fetch settings once on mount + provide an updater. Used by the
 *  settings panels (LiveModePanel / HeadlessTogglePanel /
 *  AllowedPrefixesPanel) instead of each panel doing its own IPC dance. */
function useSettings(): {
  settings: Settings | null;
  busy: boolean;
  update: (patch: Partial<Settings>) => Promise<void>;
} {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void window.autog.settingsGet().then(setSettings);
  }, []);
  const update = useCallback(async (patch: Partial<Settings>) => {
    setBusy(true);
    try {
      const next = await window.autog.settingsSet(patch);
      setSettings(next);
    } finally {
      setBusy(false);
    }
  }, []);
  return { settings, busy, update };
}

export function App() {
  const [status, setStatus] = useState<RendererStatus>({
    connected: false,
    running: false,
    identity: null,
    lastError: null,
  });

  useEffect(() => {
    void window.autog.statusGet().then(setStatus);
    const off = window.autog.onStatus(setStatus);
    return off;
  }, []);

  return status.connected ? <MainScreen status={status} /> : <OnboardingScreen />;
}

/* ============================================================
   Onboarding
   ============================================================ */
function OnboardingScreen() {
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    setError(null);
    setBusy(true);
    try {
      await window.autog.identityConnect(apiKey.trim());
    } catch (err) {
      setError(stripIpcPrefix(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <div className="app-badge">
          <AppIcon />
        </div>
        <h1>Paste your Secret Key</h1>
        <p className="lede">
          Link this device to your BetterBG account to start running jobs on Amazon.
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (apiKey.trim() && !busy) void connect();
          }}
        >
          <label htmlFor="key">Secret Key</label>
          <input
            id="key"
            type="password"
            placeholder="••••••••••••••••"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            disabled={busy}
            autoFocus
          />
          <button className="primary-btn" type="submit" disabled={busy || !apiKey.trim()}>
            {busy ? 'Connecting…' : 'Continue'}
          </button>
        </form>

        {error && <div className="error-banner">{error}</div>}

        <div className="guide-link">
          <div>
            <div className="guide-title">Don't have a key yet?</div>
            <div className="guide-sub">Generate one in the BetterBG dashboard.</div>
          </div>
          <button
            type="button"
            className="link-btn"
            onClick={() => void window.autog.openExternal(SETUP_GUIDE_URL)}
          >
            Open Setup Guide →
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   Main screen
   ============================================================ */
type View = 'dashboard' | 'accounts' | { kind: 'logs'; attempt: JobAttempt };

type Stats = {
  claimed: number;
  completed: number;
  failed: number;
  lastJobId: string | null;
  lastJobResult: 'completed' | 'failed' | null;
  lastJobAt: string | null;
  startedAt: number | null;
};

const EMPTY_STATS: Stats = {
  claimed: 0,
  completed: 0,
  failed: 0,
  lastJobId: null,
  lastJobResult: null,
  lastJobAt: null,
  startedAt: null,
};

function MainScreen({ status }: { status: RendererStatus }) {
  const [view, setView] = useState<View>('dashboard');
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [profiles, setProfiles] = useState<AmazonProfile[]>([]);
  const [attempts, setAttempts] = useState<JobAttempt[]>([]);
  const [uptimeTick, setUptimeTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [appVersion, setAppVersion] = useState<string>('');
  const [updateInfo, setUpdateInfo] = useState<{ latest: string } | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  useEffect(() => {
    void window.autog.appVersion().then(setAppVersion);
    // Check for updates on mount + every 6 hours
    const check = () => {
      void window.autog.versionCheck().then((r) => {
        if (r.updateAvailable && r.latest) setUpdateInfo({ latest: r.latest });
      }).catch(() => undefined);
    };
    check();
    const t = setInterval(check, 6 * 60 * 60 * 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    // Update the dashboard's "Jobs" stat card by listening to the same log
    // stream the worker emits. Cheaper than maintaining a separate counter
    // pipeline through IPC.
    const off = window.autog.onLog((ev) => {
      setStats((prev) => applyLogsToStats(prev, [ev]));
    });
    const offProfiles = window.autog.onProfiles(setProfiles);
    void window.autog.profilesList().then(setProfiles);
    const offJobs = window.autog.onJobs(setAttempts);
    void window.autog.jobsList().then(setAttempts);
    const tick = setInterval(() => setUptimeTick((n) => n + 1), 1000);
    // Server-state poll: picks up cross-device changes and verify-phase
    // flips that happen on the BetterBG worker without a local trigger.
    const serverPoll = setInterval(() => {
      void window.autog.jobsList().then(setAttempts).catch(() => undefined);
    }, 30_000);
    return () => {
      off();
      offProfiles();
      offJobs();
      clearInterval(tick);
      clearInterval(serverPoll);
    };
  }, []);

  useEffect(() => {
    if (!status.running) return;
    setStats((prev) => (prev.startedAt ? prev : { ...prev, startedAt: Date.now() }));
  }, [status.running]);

  useEffect(() => {
    if (status.running) return;
    setStats((prev) => ({ ...prev, startedAt: null }));
  }, [status.running]);

  const toggleWorker = async () => {
    setBusy(true);
    try {
      if (status.running) await window.autog.workerStop();
      else await window.autog.workerStart();
    } catch (err) {
      alert(stripIpcPrefix(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!confirm('Disconnect from BetterBG? The saved Secret Key will be removed.')) return;
    setBusy(true);
    try {
      await window.autog.identityDisconnect();
    } finally {
      setBusy(false);
    }
  };

  const uptimeLabel = useMemo(() => {
    if (!stats.startedAt) return '—';
    void uptimeTick;
    return formatUptime(Date.now() - stats.startedAt);
  }, [stats.startedAt, uptimeTick]);

  const lastJobLabel = useMemo(() => {
    if (!stats.lastJobAt) return '—';
    void uptimeTick;
    const diff = Math.max(0, Date.now() - new Date(stats.lastJobAt).getTime());
    return relTime(diff);
  }, [stats.lastJobAt, uptimeTick]);

  const accountsCount = profiles.length;
  const accountsReady = profiles.filter((p) => p.enabled && p.loggedIn).length;

  return (
    <div className="app">
      <div className="toolbar">
        <div className="toolbar-left">
          <div className="brand-pill" title={appVersion ? `AmazonG ${appVersion}` : 'AmazonG'}>
            <div className="app-badge">
              <AppIcon />
            </div>
            <span className="brand-pill-label">AmazonG</span>
            {appVersion && <span className="brand-pill-version">v{appVersion}</span>}
          </div>

          {view === 'dashboard' ? (
            <>
              <button
                className={`primary-action ${status.running ? 'danger' : ''}`}
                onClick={toggleWorker}
                disabled={busy}
              >
                {status.running ? <StopIcon /> : <PlayIcon />}
                {status.running ? 'Stop' : 'Start'}
              </button>
              <button
                className="ghost-btn"
                onClick={disconnect}
                disabled={busy || status.running}
              >
                Disconnect
              </button>
              <div className={`status-pill ${status.running ? 'running' : 'idle'}`}>
                <span className="dot" />
                {status.running ? uptimeLabel : 'Idle'}
              </div>
            </>
          ) : (
            <button className="ghost-btn" onClick={() => setView('dashboard')}>
              <BackIcon /> {typeof view === 'object' && view.kind === 'logs' ? 'Back' : 'Dashboard'}
            </button>
          )}
        </div>
        <div className="toolbar-right">
          {view === 'dashboard' && (
            <button className="ghost-btn" onClick={() => setView('accounts')}>
              <UsersIcon />
              Amazon Accounts
              {accountsCount > 0 && (
                <span className={`count-badge ${accountsReady > 0 ? 'ready' : ''}`}>
                  {accountsReady}/{accountsCount}
                </span>
              )}
            </button>
          )}
        </div>
      </div>

      <div className="content">
        {updateInfo && !updateDismissed && (
          <div className="update-notice" role="status">
            <span>
              <b>AmazonG v{updateInfo.latest}</b> is available (you have v{appVersion}).
              Download the latest from the <button className="link-inline" onClick={() => void window.autog.openExternal('https://betterbg.vercel.app/dashboard/auto-buy')}>BetterBG setup guide</button>.
            </span>
            <button className="ghost-btn" onClick={() => setUpdateDismissed(true)}>Dismiss</button>
          </div>
        )}
        {status.lastError && <div className="error-banner">{status.lastError}</div>}
        {view === 'dashboard' ? (
          <DashboardView
            status={status}
            uptimeLabel={uptimeLabel}
            attempts={attempts}
            profiles={profiles}
            onViewLogs={(attempt) => setView({ kind: 'logs', attempt })}
          />
        ) : view === 'accounts' ? (
          <AccountsView profiles={profiles} workerRunning={status.running} />
        ) : (
          <LogsView attempt={view.attempt} />
        )}
      </div>
    </div>
  );
}

/* ============================================================
   Dashboard view
   ============================================================ */
function DashboardView(props: {
  status: RendererStatus;
  uptimeLabel: string;
  attempts: JobAttempt[];
  profiles: AmazonProfile[];
  onViewLogs: (a: JobAttempt) => void;
}) {
  const { status, uptimeLabel, attempts, profiles, onViewLogs } = props;

  const accountsCount = profiles.length;
  const accountsReady = profiles.filter((p) => p.enabled && p.loggedIn).length;

  const profitSummary = useMemo(() => {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayMs = startOfToday.getTime();
    const startOfMonth = new Date();
    startOfMonth.setHours(0, 0, 0, 0);
    startOfMonth.setDate(1);
    const monthMs = startOfMonth.getTime();

    let pAll = 0, pMonth = 0, pToday = 0, nAll = 0;
    for (const a of attempts) {
      const profit = computeProfit(a);
      if (profit === null) continue;
      const t = new Date(a.createdAt).getTime();
      pAll += profit;
      nAll += 1;
      if (t >= monthMs) pMonth += profit;
      if (t >= todayMs) pToday += profit;
    }
    return { pAll, pMonth, pToday, nAll };
  }, [attempts]);

  const statusCounts = useMemo(() => {
    const c = { pending: 0, success: 0, cancelled: 0, failed: 0 };
    for (const a of attempts) {
      c[STATUS_GROUP[a.status]] += 1;
    }
    return c;
  }, [attempts]);

  const failedErrorBreakdown = useMemo(() => {
    const by = new Map<string, number>();
    for (const a of attempts) {
      if (STATUS_GROUP[a.status] !== 'failed') continue;
      const key = normalizeFailureError(a.error);
      by.set(key, (by.get(key) ?? 0) + 1);
    }
    return Array.from(by.entries()).sort((a, b) => b[1] - a[1]);
  }, [attempts]);

  const fmt = (n: number) => `${n >= 0 ? '+' : '−'}$${Math.abs(n).toFixed(2)}`;

  return (
    <>
      <div className="stat-row">
        <StatCard
          icon={<BoltIcon />}
          iconVariant="blue"
          title="Worker"
          subtitle={status.running ? 'Polling BetterBG' : 'Not running'}
          rows={[
            {
              label: 'Status',
              value: status.running ? 'Running' : 'Idle',
              valueClass: status.running ? 'green' : 'muted',
            },
            { label: 'Uptime', value: uptimeLabel, valueClass: 'muted' },
            {
              label: 'Amazon accounts',
              value: `${accountsReady} of ${accountsCount}`,
              valueClass: 'muted',
            },
            { label: 'Better BG Account', value: status.identity?.userEmail ?? '—', valueClass: 'muted' },
          ]}
        />
        <StatCard
          icon={<ShoppingIcon />}
          iconVariant="purple"
          title="Amazon Purchases"
          subtitle="Since session start"
          rows={[
            { label: 'Pending', value: statusCounts.pending, valueClass: 'purple' },
            { label: 'Success', value: statusCounts.success, valueClass: 'green' },
            { label: 'Cancelled', value: statusCounts.cancelled, valueClass: 'muted' },
            {
              label: (
                <>
                  Failed
                  <FailedErrorPopover breakdown={failedErrorBreakdown} total={statusCounts.failed} />
                </>
              ),
              value: statusCounts.failed,
              valueClass: 'red',
            },
          ]}
        />
        <StatCard
          icon={<DollarIcon />}
          iconVariant={profitSummary.pAll >= 0 ? 'green' : 'red'}
          title="Profit"
          subtitle={
            profitSummary.nAll > 0
              ? `Across ${profitSummary.nAll} verified order${profitSummary.nAll === 1 ? '' : 's'}`
              : 'No verified orders yet'
          }
          rows={[
            {
              label: 'Today',
              value: `${fmt(profitSummary.pToday)}`,
              valueClass: profitSummary.pToday >= 0 ? 'green' : 'red',
            },
            {
              label: 'This month',
              value: `${fmt(profitSummary.pMonth)}`,
              valueClass: profitSummary.pMonth >= 0 ? 'green' : 'red',
            },
            {
              label: 'All time',
              value: `${fmt(profitSummary.pAll)}`,
              valueClass: profitSummary.pAll >= 0 ? 'green' : 'red',
            },
          ]}
        />
      </div>

      <JobsTable
        attempts={attempts}
        profiles={profiles}
        onViewLogs={onViewLogs}
        workerRunning={status.running}
      />
    </>
  );
}

/* ============================================================
   Jobs table
   ============================================================ */
type SortKey = 'date' | 'item' | 'dealId' | 'account' | 'buyMode' | 'qty' | 'retail' | 'totalRetail' | 'payout' | 'cb' | 'profit' | 'status' | 'orderId';

/**
 * Stable identifiers for each draggable column in the Jobs table. The
 * user-chosen ordering lives in settings.jobsColumnOrder; unknown ids
 * are dropped, missing ids fall back to DEFAULT_COLUMN_ORDER's tail.
 *
 * The Action menu column is intentionally excluded — it's not part of
 * the data, it stays pinned to the right.
 */
type JobColumnId =
  | 'date' | 'item' | 'dealId' | 'account' | 'buyMode' | 'qty'
  | 'retail' | 'totalRetail' | 'payout' | 'cb' | 'profit'
  | 'orderId' | 'tracking' | 'status';

const DEFAULT_COLUMN_ORDER: JobColumnId[] = [
  'date', 'item', 'dealId', 'account', 'buyMode', 'qty',
  'retail', 'totalRetail', 'payout', 'cb', 'profit',
  'orderId', 'tracking', 'status',
];

/**
 * Columns hidden the first time a user sees them. Once they explicitly
 * tick the column on (which writes the new order back to settings),
 * the "haven't-seen-it-yet" check stops firing.
 */
const DEFAULT_HIDDEN_COLUMNS = new Set<JobColumnId>(['totalRetail', 'buyMode']);

function resolveColumnOrder(saved: string[]): JobColumnId[] {
  const valid = new Set<JobColumnId>(DEFAULT_COLUMN_ORDER);
  const seen = new Set<JobColumnId>();
  const out: JobColumnId[] = [];
  for (const id of saved) {
    if (valid.has(id as JobColumnId) && !seen.has(id as JobColumnId)) {
      out.push(id as JobColumnId);
      seen.add(id as JobColumnId);
    }
  }
  // Slot any defaults the saved order didn't mention (e.g. brand-new
  // columns added in a later release) into their natural position —
  // right after the nearest default-predecessor the user already has.
  DEFAULT_COLUMN_ORDER.forEach((id, i) => {
    if (seen.has(id)) return;
    let insertAt = 0;
    for (let j = i - 1; j >= 0; j--) {
      const prev = DEFAULT_COLUMN_ORDER[j]!;
      const idx = out.indexOf(prev);
      if (idx !== -1) { insertAt = idx + 1; break; }
    }
    out.splice(insertAt, 0, id);
    seen.add(id);
  });
  return out;
}

/**
 * Parse a formatted price string like "$399.99" (or "USD 399.99", or
 * "$1,299.95") into a number. Returns null for anything that doesn't
 * parse cleanly.
 */
function parseCost(cost: string | null): number | null {
  if (!cost) return null;
  const cleaned = cost.replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Effective retail price for a row: the actual Amazon /spc price we
 * captured at buy time (`cost`) when available, otherwise BG's retail
 * cap (`maxPrice`) as a fallback. Legacy rows placed before we started
 * capturing `cost` have no /spc price on file — falling back to BG's
 * cap is close enough for the Profit calc and avoids leaving the
 * column blank on every old row.
 */
function retailPrice(a: JobAttempt): number | null {
  const actual = parseCost(a.cost);
  if (actual !== null) return actual;
  return typeof a.maxPrice === 'number' && a.maxPrice > 0 ? a.maxPrice : null;
}

/**
 * Per-row profit: BG pays us `payout` per unit, we pay Amazon `retail`,
 * and Amazon refunds `cashbackPct` of retail. So per unit:
 *   profit = payout - retail × (1 - cashback%)
 * Multiplied by quantity (units we ordered).
 *
 * Retail is the ACTUAL Amazon price we paid (`a.cost`, captured from
 * /spc at buy time), not BG's max-pay cap (`a.maxPrice`). If cost is
 * unset we skip the calc — we don't want to show a profit number
 * built on the cap when the true price might have been different.
 *
 * Only computes for verified ("Success") orders — that's the one status
 * where we know:
 *   - the buy actually placed (vs queued / in_progress / failed)
 *   - Amazon didn't auto-cancel (vs awaiting_verification / cancelled)
 *   - real money moved (vs dry_run_success)
 * For every other status the cell shows "—" so we don't pretend to know
 * profit for a row whose outcome isn't final.
 */
function computeProfit(a: JobAttempt): number | null {
  if (a.status !== 'verified') return null;
  const retail = retailPrice(a);
  const payout = typeof a.price === 'number' ? a.price : null;
  const qty = typeof a.quantity === 'number' && a.quantity > 0 ? a.quantity : null;
  const cb = typeof a.cashbackPct === 'number' ? a.cashbackPct : null;
  if (retail === null || payout === null || qty === null || cb === null) return null;
  const perUnit = payout - retail * (1 - cb / 100);
  return perUnit * qty;
}

// Display label per raw status — collapses to one of 4 visible buckets.
// "Done" and "Dry-run OK" are gone; everything that's a finished-good
// outcome reads as "Success" now.
const STATUS_LABEL: Record<JobAttemptStatus, string> = {
  queued: 'Pending',
  in_progress: 'Pending',
  awaiting_verification: 'Pending',
  verified: 'Success',
  completed: 'Success',
  dry_run_success: 'Success',
  cancelled_by_amazon: 'Cancelled',
  failed: 'Failed',
};

/**
 * Visible status buckets. The underlying JobAttemptStatus enum still
 * has 8 values for the worker's internal state machine, but the user
 * only ever sees 4 buckets in the filter + badge — Pending, Success,
 * Cancelled, Failed. The `Done` and `Dry-run OK` raw statuses get
 * folded into Success; the in-flight three (queued / in_progress /
 * awaiting_verification) all read as Pending.
 */
type StatusGroup = 'pending' | 'success' | 'cancelled' | 'failed';

const STATUS_GROUP: Record<JobAttemptStatus, StatusGroup> = {
  queued: 'pending',
  in_progress: 'pending',
  awaiting_verification: 'pending',
  verified: 'success',
  completed: 'success',
  dry_run_success: 'success',
  cancelled_by_amazon: 'cancelled',
  failed: 'failed',
};

const ALL_STATUS_GROUPS: StatusGroup[] = ['pending', 'success', 'cancelled', 'failed'];

const STATUS_GROUP_LABEL: Record<StatusGroup, string> = {
  pending: 'Pending',
  success: 'Success',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

const STATUS_GROUP_BADGE_CLASS: Record<StatusGroup, string> = {
  pending: 'badge-amber',
  success: 'badge-green',
  cancelled: 'badge-red',
  failed: 'badge-red',
};

/** Default visible: in-flight + finished-good. Settled bad rows hidden. */
const DEFAULT_VISIBLE_STATUS_GROUPS: StatusGroup[] = ['pending', 'success'];

/** TSV cell value extractor for one column id. Used by both copy paths. */
function tsvCell(id: JobColumnId, a: JobAttempt): string | number {
  switch (id) {
    case 'date':    return new Date(a.createdAt).toISOString();
    case 'item':    return a.dealTitle ?? '';
    case 'dealId':  return a.dealId ?? a.dealKey ?? '';
    case 'account': return a.amazonEmail;
    case 'buyMode': return a.buyMode === 'filler' ? 'Filler' : 'Single';
    case 'qty':     return typeof a.quantity === 'number' ? a.quantity : '';
    case 'retail': {
      const n = retailPrice(a);
      return n !== null ? n.toFixed(2) : '';
    }
    case 'totalRetail': {
      const n = retailPrice(a);
      if (n === null || typeof a.quantity !== 'number' || a.quantity <= 0) {
        return '';
      }
      return (n * a.quantity).toFixed(2);
    }
    case 'payout':  return typeof a.price === 'number' ? a.price.toFixed(2) : '';
    case 'cb':      return typeof a.cashbackPct === 'number' ? a.cashbackPct : '';
    case 'profit': {
      const p = computeProfit(a);
      return p === null ? '' : p.toFixed(2);
    }
    case 'orderId': return a.orderId ?? '';
    case 'tracking': return (a.trackingIds ?? []).join(', ');
    case 'status':  return STATUS_LABEL[a.status] ?? a.status;
  }
}

/**
 * Format attempt rows as TSV for paste-to-spreadsheet flows. Column
 * order matches the visible Jobs table (whatever the user dragged it
 * to). NO HEADER row — paste-append into an existing tracker is the
 * primary use case, and the user explicitly doesn't want column names.
 * Cells get the standard TSV escape (wrap in quotes + double internal
 * quotes) when they contain tab/newline/quote so Google Sheets / Excel
 * parse them correctly.
 */
function attemptsToTSV(rows: JobAttempt[], order: JobColumnId[]): string {
  const escape = (v: string | number): string => {
    const s = String(v);
    return /[\t\n"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows
    .map((a) => order.map((id) => escape(tsvCell(id, a))).join('\t'))
    .join('\n');
}

const COLUMN_LABEL: Record<JobColumnId, string> = {
  date: 'Date',
  item: 'Item',
  dealId: 'Deal ID',
  account: 'Amazon Account',
  buyMode: 'Buy Mode',
  qty: 'Qty',
  retail: 'Retail',
  totalRetail: 'Total Retail',
  payout: 'Payout',
  cb: 'CB',
  profit: 'Profit',
  orderId: 'Order ID',
  tracking: 'Tracking',
  status: 'Status',
};

const COLUMN_ALIGN: Partial<Record<JobColumnId, 'right' | 'center'>> = {
  buyMode: 'center',
  qty: 'center',
  retail: 'right',
  totalRetail: 'right',
  payout: 'right',
  cb: 'right',
  profit: 'right',
  status: 'center',
};
type SortDir = 'asc' | 'desc';

function JobsTable({
  attempts,
  profiles,
  onViewLogs,
  workerRunning,
}: {
  attempts: JobAttempt[];
  profiles: AmazonProfile[];
  onViewLogs: (a: JobAttempt) => void;
  workerRunning: boolean;
}) {
  // email → display name lookup, used to show the human label under the
  // monospace email pill in the Amazon Account cell.
  const accountLabelByEmail = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const p of profiles) m.set(p.email.toLowerCase(), p.displayName);
    return m;
  }, [profiles]);
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [accountFilter, setAccountFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [orderToast, setOrderToast] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState<null | 'verify' | 'delete' | 'tracking'>(null);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);

  // Drag-to-reorder + hide/show columns. Both persist in settings so
  // the layout (and the TSV-copy shape) survives restarts.
  const { settings, update } = useSettings();
  const savedOrder = settings?.jobsColumnOrder ?? [];
  const fullColumnOrder = useMemo(() => resolveColumnOrder(savedOrder), [savedOrder]);
  const hiddenSet = useMemo(() => {
    const explicit = (settings?.jobsColumnHidden ?? []).filter(
      (id): id is JobColumnId => DEFAULT_COLUMN_ORDER.includes(id as JobColumnId),
    );
    const set = new Set<JobColumnId>(explicit);
    // Default-hidden columns (Total Retail, Total Profit, etc.) stay
    // hidden until the user has acknowledged them at least once.
    // "Acknowledged" = the id has appeared in their saved order, which
    // only happens after they explicitly tick the column on.
    const savedSet = new Set(savedOrder);
    for (const id of DEFAULT_HIDDEN_COLUMNS) {
      if (!savedSet.has(id)) set.add(id);
    }
    return set;
  }, [settings?.jobsColumnHidden, savedOrder]);
  // Persisted multi-select status filter (group-based). Empty saved
  // value = use defaults: Pending + Success on, Cancelled + Failed
  // off. Toggling writes back the explicit visible-set.
  const visibleStatusGroups = useMemo<Set<StatusGroup>>(() => {
    const saved = settings?.jobsStatusFilter ?? [];
    const list = saved.length > 0
      ? saved.filter((s): s is StatusGroup => ALL_STATUS_GROUPS.includes(s as StatusGroup))
      : DEFAULT_VISIBLE_STATUS_GROUPS;
    return new Set(list);
  }, [settings?.jobsStatusFilter]);
  const setStatusGroupVisible = (s: StatusGroup, visible: boolean) => {
    const next = new Set(visibleStatusGroups);
    if (visible) next.add(s);
    else next.delete(s);
    void update({ jobsStatusFilter: ALL_STATUS_GROUPS.filter((x) => next.has(x)) });
  };
  const setAllStatusGroupsVisible = (visible: boolean) => {
    void update({ jobsStatusFilter: visible ? [...ALL_STATUS_GROUPS] : ['__none__'] });
  };
  const resetStatusFilter = () => {
    void update({ jobsStatusFilter: [] });
  };

  const columnOrder = useMemo(
    () => fullColumnOrder.filter((id) => !hiddenSet.has(id)),
    [fullColumnOrder, hiddenSet],
  );
  const setColumnHidden = (id: JobColumnId, hidden: boolean) => {
    const explicit = new Set(
      (settings?.jobsColumnHidden ?? []).filter(
        (x): x is JobColumnId => DEFAULT_COLUMN_ORDER.includes(x as JobColumnId),
      ),
    );
    if (hidden) explicit.add(id);
    else explicit.delete(id);
    // When ticking a default-hidden column ON for the first time, also
    // append it to the saved order so the "haven't-seen" check stops
    // firing on next render.
    let nextOrder: string[] | undefined;
    if (!hidden && DEFAULT_HIDDEN_COLUMNS.has(id) && !savedOrder.includes(id)) {
      nextOrder = [...fullColumnOrder]; // includes the appended id
    }
    void update({
      jobsColumnHidden: Array.from(explicit),
      ...(nextOrder !== undefined ? { jobsColumnOrder: nextOrder } : {}),
    });
  };
  const [draggingCol, setDraggingCol] = useState<JobColumnId | null>(null);
  const [dropTargetCol, setDropTargetCol] = useState<JobColumnId | null>(null);
  const handleColDrop = (target: JobColumnId) => {
    if (!draggingCol || draggingCol === target) {
      setDraggingCol(null);
      setDropTargetCol(null);
      return;
    }
    const next = columnOrder.filter((c) => c !== draggingCol);
    const idx = next.indexOf(target);
    next.splice(idx + 1, 0, draggingCol);
    setDraggingCol(null);
    setDropTargetCol(null);
    void update({ jobsColumnOrder: next });
  };

  const openOrderInProfile = async (email: string, orderId: string) => {
    try {
      await window.autog.profilesOpenOrder(email, orderId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Profile is locked by the running worker — fall back to the system
      // browser so the user can still look at the order.
      if (/ProcessSingleton|profile is already in use|SingletonLock/i.test(msg)) {
        setOrderToast(
          `${email} is being used by the running worker. Opened in your default browser instead — stop the worker to open in the signed-in profile.`,
        );
        setTimeout(() => setOrderToast(null), 5000);
        void window.autog.openExternal(
          `https://www.amazon.com/gp/your-account/order-details?orderID=${encodeURIComponent(orderId)}`,
        );
        return;
      }
      setOrderToast(msg);
      setTimeout(() => setOrderToast(null), 5000);
    }
  };

  const accountOptions = useMemo(() => {
    const emails = Array.from(new Set(attempts.map((a) => a.amazonEmail)));
    return emails
      .map((email) => {
        const name = accountLabelByEmail.get(email.toLowerCase()) ?? null;
        return { email, label: name ?? email };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [attempts, accountLabelByEmail]);


  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = attempts.filter((a) => {
      if (!visibleStatusGroups.has(STATUS_GROUP[a.status])) return false;
      if (accountFilter !== 'all' && a.amazonEmail !== accountFilter) return false;
      if (q.length > 0) {
        const hay = `${a.dealTitle ?? ''} ${a.amazonEmail} ${a.dealId ?? ''} ${a.dealKey ?? ''} ${a.orderId ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const cmp = (a: JobAttempt, b: JobAttempt): number => {
      switch (sortKey) {
        case 'date':
          return a.createdAt.localeCompare(b.createdAt);
        case 'item':
          return (a.dealTitle ?? '').localeCompare(b.dealTitle ?? '');
        case 'dealId':
          return (a.dealId ?? a.dealKey ?? '').localeCompare(b.dealId ?? b.dealKey ?? '');
        case 'account':
          return a.amazonEmail.localeCompare(b.amazonEmail);
        case 'buyMode':
          return (a.buyMode ?? 'single').localeCompare(b.buyMode ?? 'single');
        case 'retail': {
          const an = retailPrice(a);
          const bn = retailPrice(b);
          if (an === null && bn === null) return 0;
          if (an === null) return 1;
          if (bn === null) return -1;
          return an - bn;
        }
        case 'totalRetail': {
          const totalRetail = (x: JobAttempt) => {
            const unit = retailPrice(x);
            return unit !== null && typeof x.quantity === 'number' && x.quantity > 0
              ? unit * x.quantity
              : null;
          };
          const an = totalRetail(a);
          const bn = totalRetail(b);
          if (an === null && bn === null) return 0;
          if (an === null) return 1;
          if (bn === null) return -1;
          return an - bn;
        }
        case 'payout': {
          const an = typeof a.price === 'number' ? a.price : null;
          const bn = typeof b.price === 'number' ? b.price : null;
          if (an === null && bn === null) return 0;
          if (an === null) return 1;
          if (bn === null) return -1;
          return an - bn;
        }
        case 'qty':
          return (a.quantity ?? 0) - (b.quantity ?? 0);
        case 'profit': {
          const an = computeProfit(a);
          const bn = computeProfit(b);
          if (an === null && bn === null) return 0;
          if (an === null) return 1;
          if (bn === null) return -1;
          return an - bn;
        }
        case 'cb':
          return (a.cashbackPct ?? -1) - (b.cashbackPct ?? -1);
        case 'status':
          return a.status.localeCompare(b.status);
        case 'orderId':
          return (a.orderId ?? '').localeCompare(b.orderId ?? '');
      }
    };
    filtered.sort((a, b) => (sortDir === 'asc' ? cmp(a, b) : -cmp(a, b)));
    return filtered;
  }, [attempts, sortKey, sortDir, visibleStatusGroups, accountFilter, search]);

  const onSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'date' ? 'desc' : 'asc');
    }
  };

  const clearFilters = () => {
    resetStatusFilter();
    setAccountFilter('all');
    setSearch('');
  };

  const statusFilterIsCustom =
    visibleStatusGroups.size !== DEFAULT_VISIBLE_STATUS_GROUPS.length ||
    !DEFAULT_VISIBLE_STATUS_GROUPS.every((s) => visibleStatusGroups.has(s));
  const hasFilter = statusFilterIsCustom || accountFilter !== 'all' || search.length > 0;

  // Drop selections that no longer exist in the visible-or-attempts set
  // (e.g. after a bulk delete) so the bulk bar reflects reality.
  useEffect(() => {
    const ids = new Set(attempts.map((a) => a.attemptId));
    let dirty = false;
    const next = new Set<string>();
    for (const id of selected) {
      if (ids.has(id)) next.add(id);
      else dirty = true;
    }
    if (dirty) setSelected(next);
  }, [attempts, selected]);

  const selectedAttempts = useMemo(
    () => attempts.filter((a) => selected.has(a.attemptId)),
    [attempts, selected],
  );
  const selectedVerifiable = selectedAttempts.filter((a) => !!a.orderId);

  const runBulkVerify = async () => {
    if (selectedVerifiable.length === 0) return;
    setBulkBusy('verify');
    setBulkProgress({ done: 0, total: selectedVerifiable.length });
    let active = 0, cancelled = 0, failed = 0;
    // Serialize — each verify opens a Chromium session for that profile;
    // running them in parallel would hit ProcessSingleton locks when
    // multiple selected rows share an Amazon account.
    for (let i = 0; i < selectedVerifiable.length; i++) {
      const a = selectedVerifiable[i]!;
      try {
        const r = await window.autog.jobsVerifyOrder(a.attemptId);
        if (r.kind === 'active') active++;
        else if (r.kind === 'cancelled') cancelled++;
        else failed++;
      } catch {
        failed++;
      }
      setBulkProgress({ done: i + 1, total: selectedVerifiable.length });
    }
    setBulkBusy(null);
    setBulkProgress(null);
    setOrderToast(
      `Bulk verify complete · ${active} active, ${cancelled} cancelled${failed ? `, ${failed} failed/timeout` : ''}.`,
    );
    setTimeout(() => setOrderToast(null), 6000);
  };

  // Fetch-tracking bulk action. Same eligibility as verify (row needs an
  // orderId), but skips rows that already have every tracking we've seen
  // — re-running on a fully-tracked row is harmless, just wastes time.
  const selectedForTracking = selectedVerifiable;

  const runBulkFetchTracking = async () => {
    if (selectedForTracking.length === 0) return;
    setBulkBusy('tracking');
    setBulkProgress({ done: 0, total: selectedForTracking.length });
    let tracked = 0, notShipped = 0, retry = 0, cancelled = 0, failed = 0;
    let lastError: string | null = null;
    for (let i = 0; i < selectedForTracking.length; i++) {
      const a = selectedForTracking[i]!;
      try {
        const r = await window.autog.jobsFetchTracking(a.attemptId);
        if (r.kind === 'tracked' || r.kind === 'partial') tracked++;
        else if (r.kind === 'not_shipped') notShipped++;
        else if (r.kind === 'retry') retry++;
        else if (r.kind === 'cancelled') cancelled++;
        else if (r.kind === 'error' || r.kind === 'busy') {
          failed++;
          lastError = r.message;
        } else {
          failed++;
        }
      } catch (err) {
        failed++;
        lastError = err instanceof Error ? err.message : String(err);
      }
      setBulkProgress({ done: i + 1, total: selectedForTracking.length });
    }
    setBulkBusy(null);
    setBulkProgress(null);
    const parts = [
      `${tracked} tracked`,
      notShipped ? `${notShipped} not shipped` : null,
      retry ? `${retry} retrying` : null,
      cancelled ? `${cancelled} cancelled` : null,
      failed ? `${failed} failed${lastError ? ` — ${lastError}` : ''}` : null,
    ].filter(Boolean);
    setOrderToast(`Fetch tracking complete · ${parts.join(', ')}.`);
    setTimeout(() => setOrderToast(null), 8000);
  };

  const runBulkDelete = async () => {
    if (selectedAttempts.length === 0) return;
    if (!confirm(`Delete ${selectedAttempts.length} selected row${selectedAttempts.length === 1 ? '' : 's'} and their logs?`)) {
      return;
    }
    setBulkBusy('delete');
    setBulkProgress({ done: 0, total: selectedAttempts.length });
    for (let i = 0; i < selectedAttempts.length; i++) {
      const a = selectedAttempts[i]!;
      try {
        await window.autog.jobsDelete(a.attemptId);
      } catch {
        // skip — broadcast will sync state
      }
      setBulkProgress({ done: i + 1, total: selectedAttempts.length });
    }
    setSelected(new Set());
    setBulkBusy(null);
    setBulkProgress(null);
  };

  return (
    <div className="jobs-card">
      <div className="jobs-head">
        <h2>Amazon Purchases</h2>
        <div className="jobs-head-right">
          <div className="jobs-count">
            {visible.length} of {attempts.length} row{attempts.length === 1 ? '' : 's'}
          </div>
        </div>
      </div>

      {attempts.length > 0 && (
        <div className="jobs-filters">
          <input
            className="jobs-search"
            type="search"
            placeholder="Search title, account, deal key, order id…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <ColumnsMenu
            order={fullColumnOrder}
            hidden={hiddenSet}
            onToggle={setColumnHidden}
            onReset={() => void update({ jobsColumnOrder: [], jobsColumnHidden: [] })}
          />
          <StatusFilterMenu
            visible={visibleStatusGroups}
            onToggle={setStatusGroupVisible}
            onToggleAll={setAllStatusGroupsVisible}
            onReset={resetStatusFilter}
          />
          <select value={accountFilter} onChange={(e) => setAccountFilter(e.target.value)}>
            <option value="all">All accounts</option>
            {accountOptions.map(({ email, label }) => (
              <option key={email} value={email}>
                {label}
              </option>
            ))}
          </select>
          {hasFilter && (
            <button className="ghost-btn" onClick={clearFilters}>
              Clear
            </button>
          )}
        </div>
      )}

      {selected.size > 0 && (
        <div className="bulk-bar" role="toolbar">
          <span className="bulk-count">
            {bulkBusy && bulkProgress
              ? `${bulkBusy === 'verify' ? 'Verifying' : bulkBusy === 'tracking' ? 'Fetching tracking' : 'Deleting'} ${bulkProgress.done}/${bulkProgress.total}…`
              : `${selected.size} selected`}
          </span>
          <button
            className="ghost-btn"
            disabled={bulkBusy !== null}
            title={`Copy ${selected.size} row${selected.size === 1 ? '' : 's'} as TSV (paste into Google Sheets / Excel)`}
            onClick={async () => {
              const tsv = attemptsToTSV(selectedAttempts, columnOrder);
              try {
                await navigator.clipboard.writeText(tsv);
                setOrderToast(
                  `Copied ${selectedAttempts.length} row${selectedAttempts.length === 1 ? '' : 's'} — paste into a spreadsheet.`,
                );
              } catch (err) {
                setOrderToast(
                  `Copy failed: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
              setTimeout(() => setOrderToast(null), 4000);
            }}
          >
            Copy ({selected.size})
          </button>
          <button
            className="ghost-btn"
            disabled={bulkBusy !== null || selectedVerifiable.length === 0}
            title={
              selectedVerifiable.length === 0
                ? 'None of the selected rows have an order id to verify'
                : `Re-check Amazon for ${selectedVerifiable.length} order${selectedVerifiable.length === 1 ? '' : 's'}`
            }
            onClick={() => void runBulkVerify()}
          >
            Verify Order ({selectedVerifiable.length})
          </button>
          <button
            className="ghost-btn"
            disabled={bulkBusy !== null || selectedForTracking.length === 0}
            title={
              selectedForTracking.length === 0
                ? 'None of the selected rows have an order id to fetch tracking for'
                : `Fetch carrier tracking for ${selectedForTracking.length} order${selectedForTracking.length === 1 ? '' : 's'}`
            }
            onClick={() => void runBulkFetchTracking()}
          >
            Fetch Tracking ({selectedForTracking.length})
          </button>
          <button
            className="ghost-btn danger-text"
            disabled={bulkBusy !== null}
            onClick={() => void runBulkDelete()}
          >
            Delete ({selected.size})
          </button>
        </div>
      )}

      <div className="jobs-table-wrap">
        {attempts.length === 0 ? (
          <div className="jobs-empty">
            {workerRunning
              ? 'Worker is polling. Rows will appear once a job is claimed.'
              : 'Click Start to begin polling BetterBG for jobs. Each claimed job will create one row per Amazon account.'}
          </div>
        ) : visible.length === 0 ? (
          <div className="jobs-empty">No rows match current filters.</div>
        ) : (
          <table className="jobs-table">
            <thead>
              <tr>
                <th className="cell-select">
                  <input
                    type="checkbox"
                    aria-label="Select all visible rows"
                    checked={visible.length > 0 && visible.every((a) => selected.has(a.attemptId))}
                    ref={(el) => {
                      // Indeterminate when some-but-not-all visible rows are selected.
                      if (el) {
                        const sel = visible.filter((a) => selected.has(a.attemptId)).length;
                        el.indeterminate = sel > 0 && sel < visible.length;
                      }
                    }}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) {
                        for (const a of visible) next.add(a.attemptId);
                      } else {
                        for (const a of visible) next.delete(a.attemptId);
                      }
                      setSelected(next);
                    }}
                  />
                </th>
                {columnOrder.map((id) => (
                  <DraggableTh
                    key={id}
                    id={id}
                    label={COLUMN_LABEL[id]}
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onSort={onSort}
                    align={COLUMN_ALIGN[id]}
                    isDragging={draggingCol === id}
                    isDropTarget={dropTargetCol === id && draggingCol !== id}
                    onDragStart={() => setDraggingCol(id)}
                    onDragOver={(e) => {
                      if (draggingCol && draggingCol !== id) {
                        e.preventDefault();
                        setDropTargetCol(id);
                      }
                    }}
                    onDragLeave={() => {
                      if (dropTargetCol === id) setDropTargetCol(null);
                    }}
                    onDrop={() => handleColDrop(id)}
                    onDragEnd={() => {
                      setDraggingCol(null);
                      setDropTargetCol(null);
                    }}
                  />
                ))}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((a) => (
                <tr key={a.attemptId} className={selected.has(a.attemptId) ? 'row-selected' : undefined}>
                  <td className="cell-select">
                    <input
                      type="checkbox"
                      aria-label={`Select row ${a.dealTitle ?? a.attemptId}`}
                      checked={selected.has(a.attemptId)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(a.attemptId);
                        else next.delete(a.attemptId);
                        setSelected(next);
                      }}
                    />
                  </td>
                  {columnOrder.map((id) => (
                    <JobsCell
                      key={id}
                      id={id}
                      a={a}
                      accountLabel={accountLabelByEmail.get(a.amazonEmail.toLowerCase()) ?? null}
                      onOpenProductUrl={(url) => void window.autog.openExternal(url)}
                      onOpenOrder={() => void openOrderInProfile(a.amazonEmail, a.orderId!)}
                    />
                  ))}
                  <td className="cell-actions">
                    {a.status === 'cancelled_by_amazon' && (
                      <RebuyButton
                        attempt={a}
                        onToast={(msg) => {
                          setOrderToast(msg);
                          setTimeout(() => setOrderToast(null), 5000);
                        }}
                      />
                    )}
                    <ViewLogButton onViewLogs={() => onViewLogs(a)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {orderToast && (
        <div className="lock-toast" role="status">
          {orderToast}
        </div>
      )}
    </div>
  );
}


/**
 * Dropdown to show/hide individual Jobs-table columns. Lives next to
 * the row count in the table header. Hidden columns drop from the
 * table render AND the TSV copy. Reset clears both order + hidden so
 * the user can recover the default layout in one click.
 */
function ColumnsMenu({
  order,
  hidden,
  onToggle,
  onReset,
}: {
  order: JobColumnId[];
  hidden: Set<JobColumnId>;
  onToggle: (id: JobColumnId, hidden: boolean) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const visibleCount = order.length - hidden.size;
  return (
    <div className="action-menu-wrap" ref={ref}>
      <button
        className="ghost-btn"
        onClick={() => setOpen((o) => !o)}
        title="Show/hide fields. Drag column headers to reorder."
      >
        Fields ({visibleCount}/{order.length}) ▾
      </button>
      {open && (
        <div className="action-menu columns-menu">
          {order.map((id) => {
            const isHidden = hidden.has(id);
            const isLastVisible = !isHidden && order.length - hidden.size === 1;
            return (
              <label
                key={id}
                className="columns-menu-item"
                title={isLastVisible ? 'At least one column must stay visible' : ''}
              >
                <input
                  type="checkbox"
                  checked={!isHidden}
                  disabled={isLastVisible}
                  onChange={(e) => onToggle(id, !e.target.checked)}
                />
                {COLUMN_LABEL[id]}
              </label>
            );
          })}
          <div className="action-menu-sep" />
          <button className="action-menu-item" onClick={() => { onReset(); setOpen(false); }}>
            Reset to default
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Multi-select status filter dropdown. Replaces the old single-select
 * "All statuses / one status" dropdown. Defaults hide Failed and
 * Cancelled — once an order has settled into one of those, it usually
 * doesn't need attention. User can tick them on to audit.
 */
function StatusFilterMenu({
  visible,
  onToggle,
  onToggleAll,
  onReset,
}: {
  visible: Set<StatusGroup>;
  onToggle: (s: StatusGroup, visible: boolean) => void;
  onToggleAll: (visible: boolean) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const allChecked = visible.size === ALL_STATUS_GROUPS.length;
  const someChecked = visible.size > 0 && !allChecked;
  const allCheckboxRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (allCheckboxRef.current) allCheckboxRef.current.indeterminate = someChecked;
  }, [someChecked, open]);
  return (
    <div className="action-menu-wrap" ref={ref}>
      <button
        className="ghost-btn"
        onClick={() => setOpen((o) => !o)}
        title="Show only the statuses you tick"
      >
        Statuses ({visible.size}/{ALL_STATUS_GROUPS.length}) ▾
      </button>
      {open && (
        <div className="action-menu columns-menu">
          <label className="columns-menu-item">
            <input
              ref={allCheckboxRef}
              type="checkbox"
              checked={allChecked}
              onChange={(e) => onToggleAll(e.target.checked)}
            />
            All
          </label>
          <div className="action-menu-sep" />
          {ALL_STATUS_GROUPS.map((s) => (
            <label key={s} className="columns-menu-item">
              <input
                type="checkbox"
                checked={visible.has(s)}
                onChange={(e) => onToggle(s, e.target.checked)}
              />
              {STATUS_GROUP_LABEL[s]}
            </label>
          ))}
          <div className="action-menu-sep" />
          <button className="action-menu-item" onClick={() => { onReset(); setOpen(false); }}>
            Reset to default
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Sortable + drag-to-reorder header cell for the Jobs table. Reuses the
 * existing SortableTh visuals; layered on top is HTML5 drag so the user
 * can move columns into the order their spreadsheet wants. The
 * resulting order is the same one used for TSV copy.
 */
function DraggableTh(props: {
  id: JobColumnId;
  label: string;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
  align?: 'right' | 'center';
  isDragging: boolean;
  isDropTarget: boolean;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
}) {
  const active = props.sortKey === props.id;
  const cls = [
    props.align ? `th-${props.align}` : '',
    props.isDragging ? 'th-dragging' : '',
    props.isDropTarget ? 'th-drop-target' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <th
      className={cls || undefined}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', props.id);
        props.onDragStart();
      }}
      onDragOver={props.onDragOver}
      onDragLeave={props.onDragLeave}
      onDrop={(e) => {
        e.preventDefault();
        props.onDrop();
      }}
      onDragEnd={props.onDragEnd}
      title="Drag to reorder column"
    >
      <button
        type="button"
        className={`th-sort ${active ? 'active' : ''}`}
        onClick={() => props.onSort(props.id as SortKey)}
      >
        {props.label}
        <span className="th-arrow">
          {active ? (props.sortDir === 'asc' ? '▲' : '▼') : ''}
        </span>
      </button>
    </th>
  );
}

/** Click-to-copy Deal ID chip with a transient "Copied!" tooltip. */
function DealIdChip({ text, copyValue }: { text: string; copyValue?: string }) {
  const [copied, setCopied] = useState(false);
  const value = copyValue ?? text;
  return (
    <span
      className="dealid-text"
      title={copied ? 'Copied!' : 'Click to copy'}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard
          .writeText(value)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          })
          .catch(() => {});
      }}
    >
      {text}
    </span>
  );
}

/**
 * Render one Jobs-table cell for a given column id. All the per-column
 * JSX lives here so the column-order iteration in the parent stays
 * tidy. Keep this in lockstep with tsvCell so the on-screen value and
 * the copied value match.
 */
function JobsCell({
  id,
  a,
  accountLabel,
  onOpenProductUrl,
  onOpenOrder,
}: {
  id: JobColumnId;
  a: JobAttempt;
  accountLabel: string | null;
  onOpenProductUrl: (url: string) => void;
  onOpenOrder: () => void;
}) {
  switch (id) {
    case 'date':
      return (
        <td className="cell-date">
          <div>{formatDate(a.createdAt)}</div>
          <div className="cell-date-time">{formatTime(a.createdAt)}</div>
        </td>
      );
    case 'item':
      return (
        <td className="cell-item">
          {a.productUrl ? (
            <a
              href="#"
              className="cell-item-title item-link"
              title="Open this product on Amazon"
              onClick={(e) => {
                e.preventDefault();
                onOpenProductUrl(a.productUrl);
              }}
            >
              {a.dealTitle ?? '(untitled)'}
            </a>
          ) : (
            <div className="cell-item-title">{a.dealTitle ?? '(untitled)'}</div>
          )}
          {(a.phase === 'verify' || a.dryRun) && (
            <div className="cell-item-sub">
              {a.phase === 'verify' ? <span className="chip chip-purple">VERIFY</span> : null}
              {a.dryRun ? <span className="chip chip-blue">DRY-RUN</span> : null}
            </div>
          )}
        </td>
      );
    case 'dealId':
      return (
        <td className="cell-dealid">
          {a.dealId ? (
            <DealIdChip text={a.dealId} />
          ) : a.dealKey ? (
            <DealIdChip text={a.dealKey.slice(0, 8)} copyValue={a.dealKey} />
          ) : (
            <span className="muted">—</span>
          )}
        </td>
      );
    case 'account':
      return (
        <td className="cell-account">
          <span className="account-pill">{a.amazonEmail}</span>
          {accountLabel && <div className="cell-account-name">{accountLabel}</div>}
        </td>
      );
    case 'buyMode':
      return (
        <td className="cell-buymode">
          <span className={`buymode-badge ${a.buyMode === 'filler' ? 'filler' : 'single'}`}>
            {a.buyMode === 'filler' ? 'Filler' : 'Single'}
          </span>
        </td>
      );
    case 'qty':
      return (
        <td className="cell-qty">
          {typeof a.quantity === 'number' && a.quantity > 0 ? a.quantity : <span className="muted">—</span>}
        </td>
      );
    case 'retail': {
      const n = retailPrice(a);
      return (
        <td className="cell-retail">
          {n !== null ? `$${n.toFixed(2)}` : <span className="muted">—</span>}
        </td>
      );
    }
    case 'totalRetail': {
      const unit = retailPrice(a);
      const ok = unit !== null && typeof a.quantity === 'number' && a.quantity > 0;
      return (
        <td className="cell-retail">
          {ok ? `$${(unit! * a.quantity!).toFixed(2)}` : <span className="muted">—</span>}
        </td>
      );
    }
    case 'payout':
      return (
        <td className="cell-payout">
          {typeof a.price === 'number' ? `$${a.price.toFixed(2)}` : <span className="muted">—</span>}
        </td>
      );
    case 'cb':
      return (
        <td className="cell-cb">
          {a.cashbackPct !== null ? (
            <span className={a.cashbackPct >= 6 ? 'cb-good' : 'cb-low'}>{a.cashbackPct}%</span>
          ) : (
            '—'
          )}
        </td>
      );
    case 'profit': {
      const p = computeProfit(a);
      return (
        <td className="cell-profit">
          {p === null ? (
            <span className="muted">—</span>
          ) : (
            <span
              className={p >= 0 ? 'profit-good' : 'profit-bad'}
              title={`payout ${a.price} − retail ${retailPrice(a) ?? '?'} × (1 − ${a.cashbackPct}% cb) × qty ${a.quantity}`}
            >
              {p >= 0 ? '+' : '−'}${Math.abs(p).toFixed(2)}
            </span>
          )}
        </td>
      );
    }
    case 'orderId':
      return (
        <td className="cell-orderid">
          {a.orderId ? (
            <a
              href="#"
              className="orderid-link"
              title={`Open in ${a.amazonEmail}'s signed-in session`}
              onClick={(e) => {
                e.preventDefault();
                onOpenOrder();
              }}
            >
              {a.orderId}
            </a>
          ) : (
            <span className="muted">—</span>
          )}
        </td>
      );
    case 'tracking':
      return (
        <td className="cell-tracking">
          {a.trackingIds && a.trackingIds.length > 0 ? (
            <div className="tracking-list">
              {a.trackingIds.map((code) => (
                <button
                  key={code}
                  type="button"
                  className="tracking-pill"
                  title="Click to copy"
                  onClick={() => void navigator.clipboard.writeText(code).catch(() => undefined)}
                >
                  {code}
                </button>
              ))}
            </div>
          ) : (
            <span className="muted">—</span>
          )}
        </td>
      );
    case 'status':
      return (
        <td className="cell-status">
          <StatusBadge status={a.status} />
          {a.error && <div className="cell-error" title={a.error}>{a.error}</div>}
        </td>
      );
  }
}


function ViewLogButton({ onViewLogs }: { onViewLogs: () => void }) {
  return (
    <button
      className="ghost-btn"
      onClick={onViewLogs}
      title="View logs for this row"
    >
      View Log
    </button>
  );
}

/**
 * Per-row Re-buy action for cancelled_by_amazon attempts. Queues a new
 * buy-phase job on BG scoped to this row's Amazon account, forced through
 * buyWithFillers. Server-side idempotency covers button mashing — a second
 * click returns the already-queued job.
 */
function RebuyButton({
  attempt,
  onToast,
}: {
  attempt: JobAttempt;
  onToast: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await window.autog.jobsRebuy(attempt.attemptId);
      if (r.kind === 'error') {
        onToast(`Re-buy failed: ${r.message}`);
        return;
      }
      onToast(r.deduped ? 'Re-buy already queued for this account.' : 'Re-buy queued.');
    } catch (err) {
      onToast(`Re-buy failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      className="ghost-btn"
      onClick={run}
      disabled={busy}
      title="Queue a new buy for this account, using buyWithFillers."
    >
      {busy ? 'Queuing…' : 'Re-buy'}
    </button>
  );
}

function SortableTh({
  label,
  k,
  sortKey,
  sortDir,
  onSort,
  align,
}: {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
  align?: 'right' | 'center';
}) {
  const active = sortKey === k;
  return (
    <th className={align ? `th-${align}` : undefined}>
      <button
        type="button"
        className={`th-sort ${active ? 'active' : ''}`}
        onClick={() => onSort(k)}
      >
        {label}
        <span className="th-arrow">{active ? (sortDir === 'asc' ? '▲' : '▼') : ''}</span>
      </button>
    </th>
  );
}

function StatusBadge({ status }: { status: JobAttemptStatus }) {
  const group = STATUS_GROUP[status];
  return (
    <span className={`status-badge ${STATUS_GROUP_BADGE_CLASS[group]}`}>
      {STATUS_GROUP_LABEL[group]}
    </span>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: '2-digit', day: '2-digit', year: '2-digit' });
}
function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/* ============================================================
   Dry-run banner (toggle)
   ============================================================ */
function LiveModePanel() {
  const { settings, busy, update } = useSettings();
  if (!settings) return null;
  const live = !settings.buyDryRun;
  return (
    <div className="prefix-panel">
      <div className="prefix-head">
        <div>
          <div className="prefix-title">Live mode</div>
          <div className="prefix-sub">
            When on, real Amazon orders are placed. When off, dry-run — runs the full flow
            (including saved-address mutations like BG1/BG2) but stops before clicking Place Order.
          </div>
        </div>
        <label
          className={`toggle ${live ? 'on' : 'off'}`}
          title={live ? 'Real orders will be placed' : 'Dry-run — no orders placed'}
        >
          <input
            type="checkbox"
            checked={live}
            onChange={(e) => void update({ buyDryRun: !e.target.checked })}
            disabled={busy}
          />
          <span className="toggle-slider" />
          <span className="toggle-label">{live ? 'On' : 'Off'}</span>
        </label>
      </div>
    </div>
  );
}

/* ============================================================
   Logs view (full page, per-attempt)
   ============================================================ */
function LogsView({ attempt }: { attempt: JobAttempt }) {
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [snapshotPreview, setSnapshotPreview] = useState<'screenshot' | 'html' | null>(null);
  const [snapshotData, setSnapshotData] = useState<{ screenshot: string | null; html: string | null; hasTrace: boolean } | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const list = await window.autog.jobsLogs(attempt.attemptId);
      setLogs(list);
    } finally {
      setLoading(false);
    }
  }, [attempt.attemptId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Live tail: append any new log events that match this attempt.
  useEffect(() => {
    const off = window.autog.onLog((ev) => {
      const data = ev.data as Record<string, unknown> | undefined;
      const jobId = typeof data?.jobId === 'string' ? data.jobId : null;
      const profile = typeof data?.profile === 'string' ? data.profile : null;
      if (jobId === attempt.jobId && profile === attempt.amazonEmail) {
        setLogs((prev) => prev.concat(ev));
      }
    });
    return off;
  }, [attempt.jobId, attempt.amazonEmail]);

  const hasSnapshot = useMemo(() => logs.some((ev) => ev.message === 'snapshot.captured'), [logs]);

  const openSnapshot = async (kind: 'screenshot' | 'html') => {
    if (!snapshotData) {
      const data = await window.autog.jobsSnapshot(attempt.attemptId);
      setSnapshotData(data);
      setSnapshotPreview(kind);
    } else {
      setSnapshotPreview(kind);
    }
  };

  return (
    <div className="logs-view">
      <div className="logs-head">
        <div>
          <div className="logs-title">{attempt.dealTitle ?? '(untitled deal)'}</div>
          <div className="logs-meta">
            <span className="account-pill">{attempt.amazonEmail}</span>
            <span className="meta-sep">·</span>
            <StatusBadge status={attempt.status} />
            <span className="meta-sep">·</span>
            <span>{formatDate(attempt.createdAt)} {formatTime(attempt.createdAt)}</span>
            {attempt.cost && (
              <>
                <span className="meta-sep">·</span>
                <span>{attempt.cost}</span>
              </>
            )}
            {attempt.cashbackPct !== null && (
              <>
                <span className="meta-sep">·</span>
                <span>{attempt.cashbackPct}% cashback</span>
              </>
            )}
            {attempt.orderId && (
              <>
                <span className="meta-sep">·</span>
                <span className="cell-mono">order {attempt.orderId}</span>
              </>
            )}
          </div>
        </div>
        <div className="logs-head-actions">
          {hasSnapshot && (
            <>
              <button className="ghost-btn" onClick={() => void openSnapshot('screenshot')}>Screenshot</button>
              <button className="ghost-btn" onClick={() => void openSnapshot('html')}>HTML</button>
              {snapshotData?.hasTrace && (
                <button
                  className="ghost-btn"
                  title="Open trace file in Finder — drag into trace.playwright.dev to inspect"
                  onClick={() => void window.autog.jobsOpenTrace(attempt.attemptId)}
                >
                  Trace
                </button>
              )}
            </>
          )}
          <button className="ghost-btn" onClick={() => void reload()} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {attempt.error && <div className="error-banner">{attempt.error}</div>}

      {snapshotPreview && snapshotData && (
        <div className="snapshot-preview">
          <div className="snapshot-preview-head">
            <div className="snapshot-preview-tabs">
              <button
                className={`ghost-btn ${snapshotPreview === 'screenshot' ? 'active' : ''}`}
                onClick={() => setSnapshotPreview('screenshot')}
              >
                Screenshot
              </button>
              <button
                className={`ghost-btn ${snapshotPreview === 'html' ? 'active' : ''}`}
                onClick={() => setSnapshotPreview('html')}
              >
                HTML Source
              </button>
            </div>
            <button className="ghost-btn" onClick={() => setSnapshotPreview(null)}>Close</button>
          </div>
          <div className="snapshot-preview-body">
            {snapshotPreview === 'screenshot'
              ? snapshotData.screenshot
                ? <img src={`data:image/png;base64,${snapshotData.screenshot}`} alt="Failure screenshot" className="snapshot-img" />
                : <div className="log-empty">No screenshot available.</div>
              : snapshotData.html
                ? <pre className="snapshot-html">{snapshotData.html}</pre>
                : <div className="log-empty">No HTML snapshot available.</div>}
          </div>
        </div>
      )}

      <div className="logs-stream">
        {logs.length === 0 ? (
          <div className="log-empty">{loading ? 'Loading logs…' : 'No logs recorded for this attempt.'}</div>
        ) : (
          logs.map((ev, i) => (
            <div key={i} className="log-line">
              <span className="log-time">{ev.ts.slice(11, 19)}</span>
              <span className={`log-level ${ev.level}`}>{ev.level}</span>
              <span className="log-message">
                {ev.message}
                {ev.data ? <span className="log-data"> {JSON.stringify(ev.data)}</span> : null}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ============================================================
   Accounts view (full page)
   ============================================================ */
function AccountsView({
  profiles,
  workerRunning,
}: {
  profiles: AmazonProfile[];
  workerRunning: boolean;
}) {
  const [lockedToast, setLockedToast] = useState(false);
  const handleLockedClick = () => {
    setLockedToast(true);
    setTimeout(() => setLockedToast(false), 4000);
  };
  return (
    <>
      {workerRunning && (
        <div className="lock-banner" role="alert">
          <span className="lock-banner-icon">🔒</span>
          <span>
            Account settings are locked while the worker is running. Click <b>Stop</b> in the
            dashboard to edit accounts, prefixes, or headless mode.
          </span>
        </div>
      )}
      <div
        className={workerRunning ? 'lock-wrapper lock-wrapper-locked' : 'lock-wrapper'}
        aria-disabled={workerRunning}
        onClickCapture={(e) => {
          if (!workerRunning) return;
          // Intercept clicks on any descendant — don't let them reach the
          // now-disabled buttons. Scroll / wheel events still pass through
          // because this is click-only.
          e.preventDefault();
          e.stopPropagation();
          handleLockedClick();
        }}
      >
        <LiveModePanel />
        <AllowedPrefixesPanel />
        <HeadlessTogglePanel profiles={profiles} />
        <AutoStartWorkerPanel />
        <BuyWithFillersPanel />
        <SnapshotSettingsPanel />
        <AccountsList profiles={profiles} />
      </div>
      {lockedToast && (
        <div className="lock-toast" role="status">
          Stop the worker first — settings can't be changed while jobs are polling.
        </div>
      )}
    </>
  );
}

function AutoStartWorkerPanel() {
  const { settings, busy, update } = useSettings();
  if (!settings) return null;
  const on = settings.autoStartWorker;
  return (
    <div className="prefix-panel">
      <div className="prefix-head">
        <div>
          <div className="prefix-title">Auto-start worker</div>
          <div className="prefix-sub">
            When on, the polling worker starts as soon as AmazonG launches (assuming you're
            connected to BetterBG). Pairs well with leaving the app running in the background —
            you don't have to click Start every time.
          </div>
        </div>
        <label
          className={`toggle ${on ? 'on' : 'off'}`}
          title={on ? 'Worker starts on launch' : 'Worker waits for you to click Start'}
        >
          <input
            type="checkbox"
            checked={on}
            onChange={(e) => void update({ autoStartWorker: e.target.checked })}
            disabled={busy}
          />
          <span className="toggle-slider" />
          <span className="toggle-label">{on ? 'On' : 'Off'}</span>
        </label>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function BuyWithFillersPanel() {
  const { settings, busy, update } = useSettings();
  if (!settings) return null;
  const on = settings.buyWithFillers;
  return (
    <div className="prefix-panel">
      <div className="prefix-head">
        <div>
          <div className="prefix-title">Buy with Fillers</div>
          <div className="prefix-sub">
            When on, every account&apos;s buy phase places the target item alongside ~10 random
            Prime fillers, then cancels the fillers once the order is verified. Applies globally
            to all enabled accounts. Caps worker concurrency to 1 account at a time. Shows as
            &quot;Filler&quot; in the Buy Mode column. Takes effect on the next worker Start.
          </div>
        </div>
        <label
          className={`toggle ${on ? 'on' : 'off'}`}
          title={on ? 'Filler mode enabled — all accounts' : 'Filler mode disabled'}
        >
          <input
            type="checkbox"
            checked={on}
            onChange={(e) => void update({ buyWithFillers: e.target.checked })}
            disabled={busy}
          />
          <span className="toggle-slider" />
          <span className="toggle-label">{on ? 'On' : 'Off'}</span>
        </label>
      </div>
    </div>
  );
}

function SnapshotSettingsPanel() {
  const { settings, busy, update } = useSettings();
  const [diskUsage, setDiskUsage] = useState<{ count: number; bytes: number } | null>(null);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    void window.autog.snapshotsDiskUsage().then(setDiskUsage);
  }, []);

  const clearSnapshots = async () => {
    if (!confirm('Delete all snapshot files (screenshots, HTML, traces)? Job history and logs are kept.')) return;
    setClearing(true);
    try {
      await window.autog.snapshotsClearAll();
      setDiskUsage({ count: 0, bytes: 0 });
    } finally {
      setClearing(false);
    }
  };

  if (!settings) return null;
  const on = settings.snapshotOnFailure;
  const groups = settings.snapshotGroups ?? [];
  const allSelected = groups.length === 0;

  const toggleGroup = (id: string) => {
    if (allSelected) {
      // Switching from "all" to specific: select everything except the one we're toggling off
      const next = SNAPSHOT_ERROR_GROUPS.map((g) => g.id).filter((g) => g !== id);
      void update({ snapshotGroups: next });
    } else if (groups.includes(id)) {
      const next = groups.filter((g) => g !== id);
      void update({ snapshotGroups: next });
    } else {
      // If adding this would select all, go back to empty (= all)
      const next = [...groups, id];
      if (next.length >= SNAPSHOT_ERROR_GROUPS.length) {
        void update({ snapshotGroups: [] });
      } else {
        void update({ snapshotGroups: next });
      }
    }
  };

  return (
    <div className="prefix-panel">
      <div className="prefix-head">
        <div>
          <div className="prefix-title">Capture snapshots on failure</div>
          <div className="prefix-sub">
            When on, AmazonG saves a screenshot and HTML snapshot of the page whenever a checkout
            error occurs. Snapshots appear in the log viewer for debugging. Stored locally, cleaned
            up automatically after 30 days.
          </div>
        </div>
        <label
          className={`toggle ${on ? 'on' : 'off'}`}
          title={on ? 'Snapshots enabled' : 'Snapshots disabled'}
        >
          <input
            type="checkbox"
            checked={on}
            onChange={(e) => void update({ snapshotOnFailure: e.target.checked })}
            disabled={busy}
          />
          <span className="toggle-slider" />
          <span className="toggle-label">{on ? 'On' : 'Off'}</span>
        </label>
      </div>
      {on && (
        <div className="snapshot-groups">
          <div className="snapshot-groups-head">
            <span className="prefix-sub">Capture errors:</span>
            <button
              className="ghost-btn snapshot-all-btn"
              onClick={() => void update({ snapshotGroups: [] })}
              disabled={busy || allSelected}
            >
              {allSelected ? 'All selected' : 'Select all'}
            </button>
          </div>
          <div className="snapshot-group-list">
            {SNAPSHOT_ERROR_GROUPS.map((g) => {
              const checked = allSelected || groups.includes(g.id);
              return (
                <label key={g.id} className="snapshot-group-item">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleGroup(g.id)}
                    disabled={busy}
                  />
                  <span>{g.label}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}
      {diskUsage && diskUsage.count > 0 && (
        <div className="snapshot-disk">
          <span className="snapshot-disk-label">
            {diskUsage.count} snapshot{diskUsage.count !== 1 ? 's' : ''} · {formatBytes(diskUsage.bytes)}
          </span>
          <button
            className="ghost-btn snapshot-clear-btn"
            onClick={() => void clearSnapshots()}
            disabled={clearing}
          >
            {clearing ? 'Clearing…' : 'Clear all snapshots'}
          </button>
        </div>
      )}
    </div>
  );
}

function HeadlessTogglePanel({ profiles }: { profiles: AmazonProfile[] }) {
  const { settings, busy, update } = useSettings();
  const [applying, setApplying] = useState(false);
  if (!settings) return null;
  // Master toggle state is derived from the per-profile switches. When
  // there are no profiles yet, fall back to the global default so the user
  // sees a non-empty state.
  const on =
    profiles.length > 0
      ? profiles.every((p) => p.headless !== false)
      : settings.headless;
  const toggle = async () => {
    const next = !on;
    setApplying(true);
    try {
      // Serialize the per-profile writes — the main-side updateProfile
      // reads + writes profiles.json, so running them in parallel
      // clobbers state (last writer wins). Sequential keeps every update.
      for (const p of profiles) {
        await window.autog.profilesSetHeadless(p.email, next);
      }
      await update({ headless: next });
    } finally {
      setApplying(false);
    }
  };
  const anyOff = profiles.some((p) => p.headless === false);
  return (
    <div className="prefix-panel">
      <div className="prefix-head">
        <div>
          <div className="prefix-title">Headless mode</div>
          <div className="prefix-sub">
            When enabled, every account runs Amazon checkouts in hidden Chromium windows. Flip
            any individual account below to Visible and this master switch turns off automatically.
            Takes effect on the next worker Start.
            {anyOff && profiles.length > 0 && (
              <>
                {' '}
                <span className="muted">
                  ({profiles.filter((p) => p.headless === false).length} of {profiles.length}{' '}
                  currently visible)
                </span>
              </>
            )}
          </div>
        </div>
        <label
          className={`toggle ${on ? 'on' : 'off'}`}
          title={on ? 'Headless: all accounts run hidden' : 'At least one account is set to Visible'}
        >
          <input
            type="checkbox"
            checked={on}
            onChange={() => void toggle()}
            disabled={busy || applying}
          />
          <span className="toggle-slider" />
          <span className="toggle-label">{on ? 'Headless' : 'Visible'}</span>
        </label>
      </div>
    </div>
  );
}

function AllowedPrefixesPanel() {
  const { settings, busy, update } = useSettings();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  useEffect(() => {
    if (settings) setDraft(settings.allowedAddressPrefixes.join(', '));
  }, [settings]);

  const save = async () => {
    const list = draft
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    await update({ allowedAddressPrefixes: list });
    setEditing(false);
  };

  if (!settings) return null;

  return (
    <div className="prefix-panel">
      <div className="prefix-head">
        <div>
          <div className="prefix-title">Allowed House-Number Prefixes</div>
          <div className="prefix-sub">
            Checkout only proceeds if the Amazon delivery address's street line starts with one of
            these house numbers (e.g. <code>13132</code> matches{' '}
            <code>13132 NE Portland Way</code>). If the current address doesn't match, AmazonG
            opens the picker and selects the matching saved address.
          </div>
        </div>
        {!editing && (
          <button className="ghost-btn" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <div className="prefix-edit">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="13132, 13130, 1146"
          />
          <button className="primary-action" onClick={() => void save()} disabled={busy}>
            Save
          </button>
          <button
            className="ghost-btn"
            onClick={() => {
              setEditing(false);
              setDraft(settings.allowedAddressPrefixes.join(', '));
            }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="prefix-chips">
          {settings.allowedAddressPrefixes.length === 0 ? (
            <span className="prefix-empty">None — address verification is off</span>
          ) : (
            settings.allowedAddressPrefixes.map((p) => (
              <span key={p} className="prefix-chip">
                {p}
              </span>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function AccountsList({ profiles }: { profiles: AmazonProfile[] }) {
  const [busyEmail, setBusyEmail] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [refreshingEmail, setRefreshingEmail] = useState<string | null>(null);
  const [draggingEmail, setDraggingEmail] = useState<string | null>(null);
  const [dropTargetEmail, setDropTargetEmail] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 4000);
  };

  const doAdd = async () => {
    const email = newEmail.trim().toLowerCase();
    if (!email || !email.includes('@')) {
      showToast('Please enter a valid email.');
      return;
    }
    try {
      await window.autog.profilesAdd(email, newName.trim() || undefined);
      setAdding(false);
      setNewEmail('');
      setNewName('');
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    }
  };

  const doLogin = async (email: string) => {
    setBusyEmail(email);
    try {
      const result = await window.autog.profilesLogin(email);
      if (!result.loggedIn) {
        const reason =
          result.reason === 'cancelled'
            ? 'Login window was closed before sign-in completed.'
            : result.reason === 'timeout'
              ? 'Login timed out after 5 minutes.'
              : 'Sign-in did not complete.';
        showToast(reason);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyEmail(null);
    }
  };

  const doRemove = (email: string) => {
    setConfirmState({
      title: 'Remove Amazon account?',
      message: `${email} will be removed and its saved cookies deleted. You'll need to sign in again to re-add this account.`,
      confirmLabel: 'Remove',
      danger: true,
      onConfirm: async () => {
        setBusyEmail(email);
        try {
          await window.autog.profilesRemove(email);
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err));
        } finally {
          setBusyEmail(null);
        }
      },
    });
  };

  const startRename = (p: AmazonProfile) => {
    setRenaming(p.email);
    setRenameValue(p.displayName ?? '');
  };

  const toggleEnabled = async (email: string, enabled: boolean) => {
    try {
      await window.autog.profilesSetEnabled(email, enabled);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    }
  };

  const refreshAll = async () => {
    setRefreshingAll(true);
    try {
      // Sequential to avoid 5 headless browsers spawning at once.
      for (const p of profiles) {
        setRefreshingEmail(p.email);
        try {
          await window.autog.profilesRefresh(p.email);
        } catch (err) {
          showToast(`${p.email}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      showToast(`Checked ${profiles.length} account${profiles.length === 1 ? '' : 's'}`);
    } finally {
      setRefreshingEmail(null);
      setRefreshingAll(false);
    }
  };

  const handleDrop = async (targetEmail: string) => {
    if (!draggingEmail || draggingEmail === targetEmail) {
      setDraggingEmail(null);
      setDropTargetEmail(null);
      return;
    }
    const fromIdx = profiles.findIndex((p) => p.email === draggingEmail);
    const toIdx = profiles.findIndex((p) => p.email === targetEmail);
    if (fromIdx === -1 || toIdx === -1) {
      setDraggingEmail(null);
      setDropTargetEmail(null);
      return;
    }
    const reordered = [...profiles];
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved!);
    setDraggingEmail(null);
    setDropTargetEmail(null);
    try {
      await window.autog.profilesReorder(reordered.map((p) => p.email));
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    }
  };

  const commitRename = async () => {
    if (!renaming) return;
    try {
      await window.autog.profilesRename(renaming, renameValue.trim() || null);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setRenaming(null);
      setRenameValue('');
    }
  };

  return (
    <div className="accounts-view">
      <div className="page-head">
        <div>
          <h1>Amazon Accounts</h1>
          <p className="page-sub">
            Each account has its own persistent browser session. Sign in once — cookies are saved
            so the worker can run jobs on that account later.
          </p>
        </div>
        <div className="page-head-actions">
          {profiles.length > 0 && (
            <button
              className="ghost-btn"
              onClick={() => void refreshAll()}
              disabled={refreshingAll}
              title="Re-check sign-in status for every account"
            >
              {refreshingAll
                ? `Checking${refreshingEmail ? ` ${shortEmail(refreshingEmail)}…` : '…'}`
                : 'Refresh all'}
            </button>
          )}
          {!adding && (
            <button className="primary-action" onClick={() => setAdding(true)}>
              <PlusIcon /> Add account
            </button>
          )}
        </div>
      </div>

      {adding && (
        <div className="add-card">
          <div className="add-card-title">New Amazon account</div>
          <div className="add-card-row">
            <div className="field">
              <label>Email</label>
              <input
                type="email"
                placeholder="you@example.com"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                autoFocus
              />
            </div>
            <div className="field">
              <label>Label (optional)</label>
              <input
                type="text"
                placeholder="e.g. Jack's main, Alt account"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </div>
          </div>
          <div className="add-card-actions">
            <button className="primary-action" onClick={() => void doAdd()}>
              Add account
            </button>
            <button
              className="ghost-btn"
              onClick={() => {
                setAdding(false);
                setNewEmail('');
                setNewName('');
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {profiles.length === 0 && !adding ? (
        <div className="accounts-empty-page">
          <div className="empty-icon">
            <UsersIcon />
          </div>
          <div className="empty-title">No Amazon accounts yet</div>
          <div className="empty-sub">
            Add one to sign in and let the worker run jobs on your behalf.
          </div>
          <button className="primary-action" onClick={() => setAdding(true)}>
            <PlusIcon /> Add your first account
          </button>
        </div>
      ) : null}

      {profiles.length > 0 && (
        <div className="accounts-list">
          {profiles.map((p) => {
            const isRenaming = renaming === p.email;
            const isDragging = draggingEmail === p.email;
            const isDropTarget = dropTargetEmail === p.email && draggingEmail !== p.email;
            return (
              <div
                key={p.email}
                className={`account-card ${isDragging ? 'dragging' : ''} ${isDropTarget ? 'drop-target' : ''}`}
                draggable={!isRenaming}
                onDragStart={(e) => {
                  setDraggingEmail(p.email);
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', p.email);
                }}
                onDragOver={(e) => {
                  if (draggingEmail && draggingEmail !== p.email) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    setDropTargetEmail(p.email);
                  }
                }}
                onDragLeave={() => {
                  if (dropTargetEmail === p.email) setDropTargetEmail(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  void handleDrop(p.email);
                }}
                onDragEnd={() => {
                  setDraggingEmail(null);
                  setDropTargetEmail(null);
                }}
              >
                <div className="account-drag-handle" title="Drag to reorder">
                  ⋮⋮
                </div>
                <div className="account-left">
                  <div className="account-avatar">
                    {(p.displayName || p.email).charAt(0).toUpperCase()}
                  </div>
                  {!isRenaming && (
                    <label
                      className={`toggle ${p.loggedIn && p.enabled ? 'on' : 'off'} ${
                        !p.loggedIn ? 'toggle-locked' : ''
                      }`}
                      title={
                        !p.loggedIn
                          ? 'Sign in first to enable this account'
                          : p.enabled
                            ? 'Enabled — included when the worker fans out a job'
                            : 'Disabled — worker skips this account'
                      }
                    >
                      <input
                        type="checkbox"
                        checked={p.loggedIn && p.enabled}
                        disabled={!p.loggedIn}
                        onChange={(e) => void toggleEnabled(p.email, e.target.checked)}
                      />
                      <span className="toggle-slider" />
                      <span className="toggle-label">
                        {p.enabled ? 'Enabled' : 'Disabled'}
                      </span>
                    </label>
                  )}
                </div>
                <div className="account-main">
                  {isRenaming ? (
                    <form
                      className="rename-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void commitRename();
                      }}
                    >
                      <input
                        type="text"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        placeholder="Account label"
                        autoFocus
                      />
                      <button type="submit" className="primary-action">
                        Save
                      </button>
                      <button
                        type="button"
                        className="ghost-btn"
                        onClick={() => setRenaming(null)}
                      >
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <>
                      <div className="account-title">
                        {p.displayName ?? <span className="muted">Unnamed</span>}
                        <button
                          className="inline-btn"
                          onClick={() => startRename(p)}
                          title="Rename"
                        >
                          <PencilIcon />
                        </button>
                      </div>
                      <div className="account-email-line">{p.email}</div>
                      <div className="account-meta-line">
                        <span className={`status-pill ${p.loggedIn ? 'running' : 'idle'}`}>
                          <span className="dot" />
                          {p.loggedIn ? 'Signed in' : 'Not signed in'}
                        </span>
                        {p.lastLoginAt && (
                          <span className="meta-sep">
                            · Last login {relDate(p.lastLoginAt)}
                          </span>
                        )}
                      </div>
                    </>
                  )}
                </div>
                {!isRenaming && (
                  <div className="account-actions">
                    <label
                      className={`toggle ${p.headless !== false ? 'on' : 'off'}`}
                      title={
                        p.headless !== false
                          ? 'Headless ON — worker runs this account without showing a browser window'
                          : 'Headless OFF — worker shows the Chromium window for this account (useful for debugging)'
                      }
                    >
                      <input
                        type="checkbox"
                        checked={p.headless !== false}
                        onChange={(e) =>
                          void window.autog.profilesSetHeadless(p.email, e.target.checked)
                        }
                      />
                      <span className="toggle-slider" />
                      <span className="toggle-label">Headless</span>
                    </label>
                    <label
                      className="toggle off"
                      title="Buy with Fillers — coming soon"
                    >
                      <input type="checkbox" checked={false} disabled readOnly />
                      <span className="toggle-slider" />
                      <span className="toggle-label">Fillers</span>
                    </label>
                    {!p.loggedIn && (
                      <button
                        className="primary-action"
                        disabled={busyEmail === p.email}
                        onClick={() => void doLogin(p.email)}
                      >
                        {busyEmail === p.email ? 'Opening…' : 'Sign in'}
                      </button>
                    )}
                    {p.loggedIn && (
                      <button
                        className="ghost-btn"
                        title="Open Amazon's Your Orders page using this account's session"
                        onClick={() => void window.autog.profilesOpenOrders(p.email)}
                      >
                        Your Orders ↗
                      </button>
                    )}
                    <button
                      className="ghost-btn danger-text"
                      disabled={busyEmail === p.email}
                      onClick={() => void doRemove(p.email)}
                    >
                      Remove
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog state={confirmState} onClose={() => setConfirmState(null)} />
      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </div>
  );
}

type ConfirmState = {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
};

function ConfirmDialog({
  state,
  onClose,
}: {
  state: ConfirmState | null;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, onClose]);

  if (!state) return null;

  const handleConfirm = async () => {
    setBusy(true);
    try {
      await state.onConfirm();
      onClose();
    } catch {
      // caller is expected to handle errors (toast/etc) — just close
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className={`modal-icon ${state.danger ? 'danger' : ''}`}>
          {state.danger ? <AlertIcon /> : <InfoIcon />}
        </div>
        <div className="modal-title">{state.title}</div>
        <div className="modal-message">{state.message}</div>
        <div className="modal-actions">
          <button className="ghost-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className={`primary-action ${state.danger ? 'danger' : ''}`}
            onClick={() => void handleConfirm()}
            disabled={busy}
            autoFocus
          >
            {busy ? 'Working…' : state.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Toast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="toast" role="status">
      <span>{message}</span>
      <button className="toast-close" onClick={onDismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}

function applyLogsToStats(prev: Stats, batch: LogEvent[]): Stats {
  let next = prev;
  for (const ev of batch) {
    if (ev.message === 'job.claim') {
      const jobId = typeof ev.data?.jobId === 'string' ? ev.data.jobId : null;
      next = { ...next, claimed: next.claimed + 1, lastJobId: jobId ?? next.lastJobId };
    } else if (
      ev.message === 'job.profile.placed' ||
      ev.message === 'job.profile.dryrun.success' ||
      ev.message === 'job.verify.active'
    ) {
      next = {
        ...next,
        completed: next.completed + 1,
        lastJobResult: 'completed',
        lastJobAt: ev.ts,
      };
    } else if (ev.message === 'job.profile.fail' || ev.message === 'step.verify.fail' || ev.message === 'step.buy.fail') {
      next = { ...next, failed: next.failed + 1, lastJobResult: 'failed', lastJobAt: ev.ts };
    }
  }
  return next;
}

/**
 * Collapse failure messages with embedded variable data (prices, counts,
 * titles) into stable group labels so the Failed-row popover doesn't
 * list each `$199.99 exceeds max $199.00` variant separately.
 */
function normalizeFailureError(raw: string | null | undefined): string {
  const err = raw?.trim();
  if (!err) return '(no error message)';
  if (/exceeds max \$?[\d.]+/i.test(err)) return 'Price exceeds expected price';
  if (/unable to parse current price|price_unknown/i.test(err)) return 'Price unavailable';
  if (/out of stock|currently unavailable/i.test(err)) return 'Out of stock';
  if (/listing is Used/i.test(err)) return 'Listing is Used';
  if (/listing is Amazon Renewed/i.test(err)) return 'Listing is Renewed';
  if (/won't ship|wont ship|not eligible for shipping/i.test(err)) return 'Won\u2019t ship to address';
  if (/not prime/i.test(err)) return 'Not Prime eligible';
  if (/no buy[- ]?now|buy now unavailable/i.test(err)) return 'No Buy Now button';
  if (/quantity.*limit|quantity_limit/i.test(err)) return 'Quantity limit';
  if (/timed out|timeout/i.test(err)) return 'Timeout';
  if (/cancelled by Amazon/i.test(err)) return 'Cancelled by Amazon';
  return err;
}

function FailedErrorPopover({ breakdown, total }: { breakdown: [string, number][]; total: number }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  if (breakdown.length === 0) return null;
  return (
    <span className="stat-label-info-wrap" ref={ref}>
      <button
        type="button"
        className="stat-label-info"
        aria-label={`Show error breakdown for ${total} failed order${total === 1 ? '' : 's'}`}
        onClick={(e) => { e.preventDefault(); setOpen((o) => !o); }}
      >
        <InfoIcon size={14} />
      </button>
      {open && (
        <div className="error-breakdown-pop" role="dialog">
          <div className="error-breakdown-head">Failures by reason</div>
          <ul className="error-breakdown-list">
            {breakdown.map(([msg, n]) => (
              <li key={msg}>
                <span className="error-breakdown-count">{n}</span>
                <span className="error-breakdown-msg">{msg}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </span>
  );
}

function StatCard(props: {
  icon: React.ReactNode;
  iconVariant: 'blue' | 'purple' | 'orange' | 'green' | 'red';
  title: string;
  subtitle?: string;
  rows: { label: React.ReactNode; value: React.ReactNode; valueClass?: string }[];
}) {
  return (
    <div className="stat-card">
      <div className="stat-header">
        <div className={`stat-icon ${props.iconVariant}`}>{props.icon}</div>
        <div>
          <div className="stat-title">{props.title}</div>
          {props.subtitle && <div className="stat-sub">{props.subtitle}</div>}
        </div>
      </div>
      <div className="stat-rows">
        {props.rows.map((r, i) => (
          <div key={i} className="stat-row-item">
            <span className="stat-label">{r.label}</span>
            <span className={`stat-value ${r.valueClass ?? ''}`.trim()}>{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============================================================
   Utilities
   ============================================================ */
function formatUptime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function relTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

function shortEmail(email: string): string {
  const [user] = email.split('@');
  return user && user.length > 12 ? user.slice(0, 12) + '…' : user ?? email;
}

function relDate(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function shortId(id: string): string {
  return id.length > 10 ? id.slice(0, 8) + '…' : id;
}

/* ============================================================
   Icons (inline SVG)
   ============================================================ */
const svgProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: '2',
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function AppIcon() {
  return (
    <svg {...svgProps}>
      <path d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z" />
    </svg>
  );
}
function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}
function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
      <rect x="6" y="6" width="12" height="12" rx="1" />
    </svg>
  );
}
function ShoppingIcon() {
  return (
    <svg {...svgProps}>
      <circle cx="9" cy="21" r="1" />
      <circle cx="20" cy="21" r="1" />
      <path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6" />
    </svg>
  );
}
function BoltIcon() {
  return (
    <svg {...svgProps}>
      <path d="M13 2 3 14h7l-1 8 10-12h-7z" />
    </svg>
  );
}
function ActivityIcon() {
  return (
    <svg {...svgProps}>
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}
function DollarIcon() {
  return (
    <svg {...svgProps}>
      <line x1="12" y1="1" x2="12" y2="23" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  );
}
function UsersIcon() {
  return (
    <svg {...svgProps} width="14" height="14">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
function BackIcon() {
  return (
    <svg {...svgProps} width="14" height="14">
      <path d="M19 12H5M12 19l-7-7 7-7" />
    </svg>
  );
}
function PlusIcon() {
  return (
    <svg {...svgProps} width="14" height="14">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
function PencilIcon() {
  return (
    <svg {...svgProps} width="12" height="12">
      <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </svg>
  );
}
function AlertIcon() {
  return (
    <svg {...svgProps} width="22" height="22">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}
function InfoIcon({ size = 22 }: { size?: number } = {}) {
  return (
    <svg {...svgProps} width={size} height={size}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}
