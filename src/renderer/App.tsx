import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AmazonProfile,
  JobAttempt,
  JobAttemptStatus,
  LogEvent,
  RendererStatus,
} from '@shared/types';
import type { Settings } from '@shared/ipc';
import { parsePrice } from '@parsers/amazonProduct';

const SETUP_GUIDE_URL = 'https://betterbg.vercel.app/dashboard/auto-buy';

function stripIpcPrefix(msg: string): string {
  return msg.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '').trim();
}

/** Fetch settings once on mount + provide an updater. Used by the
 *  three setting panels (DryRunBanner / HeadlessTogglePanel /
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

  useEffect(() => {
    void window.autog.appVersion().then(setAppVersion);
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
    return () => {
      off();
      offProfiles();
      offJobs();
      clearInterval(tick);
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
          {status.identity && (
            <div className="identity-chip">
              {status.identity.userEmail} · …{status.identity.last4}
            </div>
          )}
        </div>
      </div>

      <div className="content">
        {status.lastError && <div className="error-banner">{status.lastError}</div>}
        <UpdateBanner />
        <ChangelogModal currentVersion={appVersion} />

        {view === 'dashboard' ? (
          <DashboardView
            status={status}
            stats={stats}
            uptimeLabel={uptimeLabel}
            lastJobLabel={lastJobLabel}
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
  stats: Stats;
  uptimeLabel: string;
  lastJobLabel: string;
  attempts: JobAttempt[];
  profiles: AmazonProfile[];
  onViewLogs: (a: JobAttempt) => void;
}) {
  const { status, stats, uptimeLabel, lastJobLabel, attempts, profiles, onViewLogs } = props;

  // Aggregate profit + units across verified rows. Three windows: today
  // (since local midnight), last 7 days rolling, all-time. Re-uses
  // computeProfit so the math stays in lockstep with the per-row column.
  const profitSummary = useMemo(() => {
    const now = Date.now();
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayMs = startOfToday.getTime();
    const weekMs = now - 7 * 24 * 60 * 60 * 1000;

    let pAll = 0, pWeek = 0, pToday = 0;
    let uAll = 0, uWeek = 0, uToday = 0;
    let nAll = 0;
    for (const a of attempts) {
      const profit = computeProfit(a);
      if (profit === null) continue; // only verified rows count
      const qty = typeof a.quantity === 'number' && a.quantity > 0 ? a.quantity : 0;
      const t = new Date(a.createdAt).getTime();
      pAll += profit;
      uAll += qty;
      nAll += 1;
      if (t >= weekMs) {
        pWeek += profit;
        uWeek += qty;
      }
      if (t >= todayMs) {
        pToday += profit;
        uToday += qty;
      }
    }
    return { pAll, pWeek, pToday, uAll, uWeek, uToday, nAll };
  }, [attempts]);

  const fmt = (n: number) => `${n >= 0 ? '+' : '−'}$${Math.abs(n).toFixed(2)}`;

  return (
    <>
      <DryRunBanner />

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
            { label: 'Account', value: status.identity?.userEmail ?? '—', valueClass: 'muted' },
          ]}
        />
        <StatCard
          icon={<ShoppingIcon />}
          iconVariant="purple"
          title="Jobs"
          subtitle="Since session start"
          rows={[
            { label: 'Claimed', value: stats.claimed, valueClass: 'purple' },
            { label: 'Completed', value: stats.completed, valueClass: 'green' },
            { label: 'Failed', value: stats.failed, valueClass: 'red' },
          ]}
        />
        <StatCard
          icon={<ActivityIcon />}
          iconVariant="orange"
          title="Last Job"
          subtitle={stats.lastJobAt ? `Finished ${lastJobLabel}` : 'No jobs yet'}
          rows={[
            {
              label: 'Job ID',
              value: stats.lastJobId ? shortId(stats.lastJobId) : '—',
              valueClass: stats.lastJobId ? 'blue' : 'muted',
            },
            {
              label: 'Result',
              value: stats.lastJobResult ?? '—',
              valueClass:
                stats.lastJobResult === 'completed'
                  ? 'green'
                  : stats.lastJobResult === 'failed'
                    ? 'red'
                    : 'muted',
            },
            { label: 'When', value: lastJobLabel, valueClass: 'muted' },
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
              value: `${fmt(profitSummary.pToday)} · ${profitSummary.uToday}u`,
              valueClass: profitSummary.pToday >= 0 ? 'green' : 'red',
            },
            {
              label: 'Last 7d',
              value: `${fmt(profitSummary.pWeek)} · ${profitSummary.uWeek}u`,
              valueClass: profitSummary.pWeek >= 0 ? 'green' : 'red',
            },
            {
              label: 'All time',
              value: `${fmt(profitSummary.pAll)} · ${profitSummary.uAll}u`,
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
type SortKey = 'date' | 'item' | 'dealId' | 'account' | 'qty' | 'retail' | 'payout' | 'cb' | 'profit' | 'status' | 'orderId';

/**
 * Per-row profit: BG pays us `payout` per unit, we pay Amazon `retail`,
 * and Amazon refunds `cashbackPct` of retail. So per unit:
 *   profit = payout - retail × (1 - cashback%)
 * Multiplied by quantity (units we ordered).
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
  const retail = typeof a.maxPrice === 'number' ? a.maxPrice : null;
  const payout = typeof a.price === 'number' ? a.price : null;
  const qty = typeof a.quantity === 'number' && a.quantity > 0 ? a.quantity : null;
  const cb = typeof a.cashbackPct === 'number' ? a.cashbackPct : null;
  if (retail === null || payout === null || qty === null || cb === null) return null;
  const perUnit = payout - retail * (1 - cb / 100);
  return perUnit * qty;
}
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
  const [statusFilter, setStatusFilter] = useState<JobAttemptStatus | 'all'>('all');
  const [accountFilter, setAccountFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [orderToast, setOrderToast] = useState<string | null>(null);

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
    return Array.from(new Set(attempts.map((a) => a.amazonEmail))).sort();
  }, [attempts]);

  const failedCount = useMemo(
    () => attempts.reduce((n, a) => (a.status === 'failed' ? n + 1 : n), 0),
    [attempts],
  );
  const canceledCount = useMemo(
    () => attempts.reduce((n, a) => (a.status === 'cancelled_by_amazon' ? n + 1 : n), 0),
    [attempts],
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = attempts.filter((a) => {
      if (statusFilter !== 'all' && a.status !== statusFilter) return false;
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
        case 'retail': {
          const an = typeof a.maxPrice === 'number' ? a.maxPrice : null;
          const bn = typeof b.maxPrice === 'number' ? b.maxPrice : null;
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
  }, [attempts, sortKey, sortDir, statusFilter, accountFilter, search]);

  const onSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'date' ? 'desc' : 'asc');
    }
  };

  const clearFilters = () => {
    setStatusFilter('all');
    setAccountFilter('all');
    setSearch('');
  };

  const hasFilter = statusFilter !== 'all' || accountFilter !== 'all' || search.length > 0;

  return (
    <div className="jobs-card">
      <div className="jobs-head">
        <h2>Jobs</h2>
        <div className="jobs-head-right">
          <div className="jobs-count">
            {visible.length} of {attempts.length} row{attempts.length === 1 ? '' : 's'}
          </div>
          {failedCount > 0 && (
            <button
              className="ghost-btn"
              title="Delete every row whose status is Failed (keeps successful + in-flight rows)"
              onClick={() => {
                if (confirm(`Delete ${failedCount} failed row${failedCount === 1 ? '' : 's'} and their logs?`)) {
                  void window.autog.jobsClearFailed();
                }
              }}
            >
              Clear Failed
            </button>
          )}
          {canceledCount > 0 && (
            <button
              className="ghost-btn"
              title="Delete every row whose order was Canceled by Amazon"
              onClick={() => {
                if (confirm(`Delete ${canceledCount} canceled row${canceledCount === 1 ? '' : 's'} and their logs?`)) {
                  void window.autog.jobsClearCanceled();
                }
              }}
            >
              Clear Canceled
            </button>
          )}
          {attempts.length > 0 && (
            <button
              className="ghost-btn danger-text"
              title="Delete every job + its logs (testing only)"
              onClick={() => {
                if (confirm(`Delete all ${attempts.length} job rows and their logs? This can't be undone.`)) {
                  void window.autog.jobsClearAll();
                }
              }}
            >
              Clear All
            </button>
          )}
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
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as JobAttemptStatus | 'all')}
          >
            <option value="all">All statuses</option>
            <option value="queued">Queued</option>
            <option value="in_progress">Running</option>
            <option value="awaiting_verification">Waiting for Verification</option>
            <option value="verified">Success</option>
            <option value="cancelled_by_amazon">Canceled</option>
            <option value="completed">Done</option>
            <option value="dry_run_success">Dry-run OK</option>
            <option value="failed">Failed</option>
          </select>
          <select value={accountFilter} onChange={(e) => setAccountFilter(e.target.value)}>
            <option value="all">All accounts</option>
            {accountOptions.map((email) => (
              <option key={email} value={email}>
                {email}
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
                <SortableTh label="Date" k="date" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <SortableTh label="Item" k="item" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <SortableTh label="Deal ID" k="dealId" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <SortableTh label="Amazon Account" k="account" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <SortableTh label="Qty" k="qty" sortKey={sortKey} sortDir={sortDir} onSort={onSort} align="center" />
                <SortableTh label="Retail" k="retail" sortKey={sortKey} sortDir={sortDir} onSort={onSort} align="right" />
                <SortableTh label="Payout" k="payout" sortKey={sortKey} sortDir={sortDir} onSort={onSort} align="right" />
                <SortableTh label="CB" k="cb" sortKey={sortKey} sortDir={sortDir} onSort={onSort} align="right" />
                <SortableTh label="Profit" k="profit" sortKey={sortKey} sortDir={sortDir} onSort={onSort} align="right" />
                <SortableTh label="Order ID" k="orderId" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <SortableTh label="Status" k="status" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((a) => (
                <tr key={a.attemptId}>
                  <td className="cell-date">
                    <div>{formatDate(a.createdAt)}</div>
                    <div className="cell-date-time">{formatTime(a.createdAt)}</div>
                  </td>
                  <td className="cell-item">
                    {a.productUrl ? (
                      <a
                        href="#"
                        className="cell-item-title item-link"
                        title="Open this product on Amazon"
                        onClick={(e) => {
                          e.preventDefault();
                          void window.autog.openExternal(a.productUrl);
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
                  <td className="cell-dealid">
                    {a.dealId ? (
                      <span className="dealid-text" title={a.dealKey ?? a.dealId}>
                        {a.dealId}
                      </span>
                    ) : a.dealKey ? (
                      <span className="dealid-text" title={a.dealKey}>
                        {a.dealKey.slice(0, 8)}
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="cell-account">
                    <span className="account-pill">{a.amazonEmail}</span>
                    {accountLabelByEmail.get(a.amazonEmail.toLowerCase()) && (
                      <div className="cell-account-name">
                        {accountLabelByEmail.get(a.amazonEmail.toLowerCase())}
                      </div>
                    )}
                  </td>
                  <td className="cell-qty">
                    {typeof a.quantity === 'number' && a.quantity > 0 ? a.quantity : <span className="muted">—</span>}
                  </td>
                  <td className="cell-retail">
                    {typeof a.maxPrice === 'number' ? `$${a.maxPrice.toFixed(2)}` : <span className="muted">—</span>}
                  </td>
                  <td className="cell-payout">
                    {typeof a.price === 'number' ? `$${a.price.toFixed(2)}` : <span className="muted">—</span>}
                  </td>
                  <td className="cell-cb">
                    {a.cashbackPct !== null ? (
                      <span className={a.cashbackPct >= 6 ? 'cb-good' : 'cb-low'}>
                        {a.cashbackPct}%
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="cell-profit">
                    {(() => {
                      const p = computeProfit(a);
                      if (p === null) return <span className="muted">—</span>;
                      const sign = p >= 0 ? '+' : '−';
                      return (
                        <span
                          className={p >= 0 ? 'profit-good' : 'profit-bad'}
                          title={`payout ${a.price} − retail ${a.maxPrice} × (1 − ${a.cashbackPct}% cb) × qty ${a.quantity}`}
                        >
                          {sign}${Math.abs(p).toFixed(2)}
                        </span>
                      );
                    })()}
                  </td>
                  <td className="cell-orderid">
                    {a.orderId ? (
                      <a
                        href="#"
                        className="orderid-link"
                        title={`Open in ${a.amazonEmail}'s signed-in session`}
                        onClick={(e) => {
                          e.preventDefault();
                          void openOrderInProfile(a.amazonEmail, a.orderId!);
                        }}
                      >
                        {a.orderId}
                      </a>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="cell-status">
                    <StatusBadge status={a.status} />
                    {a.error && <div className="cell-error" title={a.error}>{a.error}</div>}
                  </td>
                  <td className="cell-actions">
                    <ActionMenu
                      attempt={a}
                      onViewLogs={() => onViewLogs(a)}
                      onToast={(msg) => {
                        setOrderToast(msg);
                        setTimeout(() => setOrderToast(null), 5000);
                      }}
                    />
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

function UpdateBanner() {
  // Polls GitHub Releases on mount + every 6h. Renders nothing when
  // already up-to-date or when the check failed (silently — failures are
  // logged in main, no need to nag the user). On "available" we show a
  // dismissible banner with a one-click Update button that triggers the
  // self-update flow (download → swap → relaunch).
  type S =
    | { kind: 'idle' }
    | { kind: 'available'; current: string; latest: string; downloadUrl: string }
    | { kind: 'installing' }
    | { kind: 'error'; message: string };
  const [state, setState] = useState<S>({ kind: 'idle' });
  const [dismissed, setDismissed] = useState(false);

  const check = useCallback(async () => {
    try {
      const r = await window.autog.updateCheck();
      if (r.kind === 'available') {
        setState({
          kind: 'available',
          current: r.current,
          latest: r.latest,
          downloadUrl: r.downloadUrl,
        });
      } else {
        setState({ kind: 'idle' });
      }
    } catch {
      // swallow — main logs it
    }
  }, []);

  useEffect(() => {
    void check();
    const t = setInterval(() => void check(), 6 * 60 * 60 * 1000);
    return () => clearInterval(t);
  }, [check]);

  if (dismissed) return null;
  if (state.kind === 'idle') return null;

  const onUpdate = async () => {
    if (state.kind !== 'available') return;
    setState({ kind: 'installing' });
    try {
      await window.autog.updateApply(state.downloadUrl);
      // App is about to quit; stay in installing UI.
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div className="update-banner" role="status">
      {state.kind === 'available' && (
        <>
          <span className="update-banner-icon">⬆</span>
          <span>
            <b>AmazonG {state.latest}</b> is available (you have {state.current}).
          </span>
          <div className="update-banner-actions">
            <button className="primary-action" onClick={() => void onUpdate()}>
              Update &amp; Restart
            </button>
            <button className="ghost-btn" onClick={() => setDismissed(true)}>
              Later
            </button>
          </div>
        </>
      )}
      {state.kind === 'installing' && (
        <>
          <span className="update-banner-icon">⬇</span>
          <span>
            Downloading update… AmazonG will quit and relaunch automatically when ready (~30 seconds).
          </span>
        </>
      )}
      {state.kind === 'error' && (
        <>
          <span className="update-banner-icon">⚠</span>
          <span>Update failed: {state.message}</span>
          <div className="update-banner-actions">
            <button className="ghost-btn" onClick={() => setDismissed(true)}>
              Dismiss
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ChangelogModal({ currentVersion }: { currentVersion: string }) {
  // First-launch-after-update "What's new" modal. Compare current version
  // to the version we last showed the changelog for (persisted in
  // settings.lastSeenVersion). On any version bump, fetch the GitHub
  // release notes for the current tag and pop them in a modal. The user
  // dismisses it once and we record the new version so it doesn't show
  // again until the NEXT update.
  //
  // Fresh installs: lastSeenVersion is "" → we DON'T show the modal
  // (would be annoying), but we do record the current version so the
  // next update triggers it.
  const { settings, update } = useSettings();
  const [notes, setNotes] = useState<{ tag: string; name: string; body: string } | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!settings || !currentVersion) return;
    const last = settings.lastSeenVersion;
    if (!last) {
      // Fresh install — record the current version so we only show the
      // modal on actual upgrades, not on every first launch.
      void update({ lastSeenVersion: currentVersion });
      return;
    }
    if (last === currentVersion) return;
    // Some kind of version bump (or downgrade — either way, show the
    // notes for the version we're now running).
    void window.autog.updateGetReleaseNotes(currentVersion).then((n) => {
      if (n) {
        setNotes(n);
        setOpen(true);
      } else {
        // No release on GitHub for this version (dev build?) — silently
        // record so we don't keep retrying every launch.
        void update({ lastSeenVersion: currentVersion });
      }
    });
  }, [settings, currentVersion, update]);

  const dismiss = () => {
    setOpen(false);
    void update({ lastSeenVersion: currentVersion });
  };

  if (!open || !notes) return null;
  return (
    <div className="modal-backdrop" onClick={dismiss}>
      <div className="modal-card changelog-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="changelog-eyebrow">What's new</div>
            <div className="modal-title">AmazonG {notes.name}</div>
          </div>
          <button className="ghost-btn" onClick={dismiss}>Close</button>
        </div>
        <div className="changelog-body">
          {notes.body
            ? notes.body.split(/\r?\n/).map((line, i) => (
                <div key={i} className="changelog-line">{line || '\u00A0'}</div>
              ))
            : <div className="changelog-line muted">No release notes were published for this version.</div>}
        </div>
        <div className="modal-actions">
          <button className="primary-action" onClick={dismiss}>Got it</button>
        </div>
      </div>
    </div>
  );
}

function ActionMenu({
  attempt,
  onViewLogs,
  onToast,
}: {
  attempt: JobAttempt;
  onViewLogs: () => void;
  onToast: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'verify' | 'delete' | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const doVerify = async () => {
    setOpen(false);
    if (!attempt.orderId) {
      onToast('No order id on this row — nothing to verify.');
      return;
    }
    setBusy('verify');
    try {
      const r = await window.autog.jobsVerifyOrder(attempt.attemptId);
      if (r.kind === 'active') onToast(`✓ Order ${r.orderId} is still active.`);
      else if (r.kind === 'cancelled') onToast(`✗ Order ${r.orderId} was cancelled by Amazon.`);
      else if (r.kind === 'timeout') onToast(`Verify timed out for ${r.orderId}. Try again.`);
      else if (r.kind === 'busy') onToast(r.message);
      else if (r.kind === 'error') onToast(`Verify failed: ${r.message}`);
    } finally {
      setBusy(null);
    }
  };

  const doDelete = async () => {
    setOpen(false);
    if (!confirm(`Delete this row? Logs for this attempt will also be deleted.`)) return;
    setBusy('delete');
    try {
      await window.autog.jobsDelete(attempt.attemptId);
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="action-menu-wrap" ref={ref}>
      <button
        className="ghost-btn"
        onClick={() => setOpen((o) => !o)}
        disabled={busy !== null}
        title="Row actions"
      >
        {busy === 'verify' ? 'Verifying…' : busy === 'delete' ? 'Deleting…' : 'Action ▾'}
      </button>
      {open && (
        <div className="action-menu">
          <button className="action-menu-item" onClick={() => { setOpen(false); onViewLogs(); }}>
            View Log
          </button>
          <button
            className="action-menu-item"
            onClick={() => void doVerify()}
            disabled={!attempt.orderId}
            title={attempt.orderId ? 'Re-check Amazon order status' : 'No order id to verify'}
          >
            Verify Order
          </button>
          <div className="action-menu-sep" />
          <button className="action-menu-item action-menu-danger" onClick={() => void doDelete()}>
            Delete
          </button>
        </div>
      )}
    </div>
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
  const map: Record<JobAttemptStatus, { label: string; cls: string }> = {
    queued: { label: 'Queued', cls: 'badge-gray' },
    in_progress: { label: 'Running', cls: 'badge-blue' },
    awaiting_verification: { label: 'Waiting for Verification', cls: 'badge-amber' },
    verified: { label: 'Success', cls: 'badge-green' },
    cancelled_by_amazon: { label: 'Canceled', cls: 'badge-red' },
    completed: { label: 'Done', cls: 'badge-green' },
    failed: { label: 'Failed', cls: 'badge-red' },
    dry_run_success: { label: 'Dry-run OK', cls: 'badge-blue' },
  };
  const m = map[status];
  return <span className={`status-badge ${m.cls}`}>{m.label}</span>;
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
function DryRunBanner() {
  const { settings, busy, update } = useSettings();
  if (!settings) return null;
  const on = settings.buyDryRun;
  const toggle = () => void update({ buyDryRun: !on });
  return (
    <div className={`dry-run-banner ${on ? 'dry' : 'live'}`}>
      <div className="dry-run-text">
        <div className="dry-run-title">
          {on ? '🧪 Dry-run mode' : '🔥 LIVE mode — real orders will be placed'}
        </div>
        <div className="dry-run-sub">
          {on
            ? "Runs the full checkout flow — including saved-address mutations like the BG1/BG2 toggle. Stops only before clicking Place Order."
            : 'Every claimed job that passes verification will place a real Amazon order.'}
        </div>
      </div>
      <button
        className={`ghost-btn ${on ? '' : 'danger-text'}`}
        onClick={() => void toggle()}
        disabled={busy}
      >
        {on ? 'Go Live' : 'Back to Dry-run'}
      </button>
    </div>
  );
}

/* ============================================================
   Logs view (full page, per-attempt)
   ============================================================ */
function LogsView({ attempt }: { attempt: JobAttempt }) {
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [loading, setLoading] = useState(true);

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
        <button className="ghost-btn" onClick={() => void reload()} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {attempt.error && <div className="error-banner">{attempt.error}</div>}

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
        <AllowedPrefixesPanel />
        <HeadlessTogglePanel profiles={profiles} />
        <AutoStartWorkerPanel />
        <UpdatesPanel />
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

function UpdatesPanel() {
  // Manual update check + install. Surfaced in the Accounts (settings)
  // view alongside the other Headless / Address-prefix panels. The
  // proactive UpdateBanner at the top of every view handles the
  // background poll + auto-prompt; this panel is for users who want to
  // poke the check now.
  type S =
    | { kind: 'idle' }
    | { kind: 'checking' }
    | { kind: 'up_to_date'; current: string }
    | { kind: 'available'; current: string; latest: string; downloadUrl: string }
    | { kind: 'installing' }
    | { kind: 'error'; message: string };
  const [state, setState] = useState<S>({ kind: 'idle' });
  const [version, setVersion] = useState<string>('');

  useEffect(() => {
    void window.autog.appVersion().then(setVersion);
  }, []);

  const check = async () => {
    setState({ kind: 'checking' });
    try {
      const r = await window.autog.updateCheck();
      if (r.kind === 'available') {
        setState({ kind: 'available', current: r.current, latest: r.latest, downloadUrl: r.downloadUrl });
      } else if (r.kind === 'up_to_date') {
        setState({ kind: 'up_to_date', current: r.current });
      } else {
        setState({ kind: 'error', message: r.message });
      }
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  const install = async () => {
    if (state.kind !== 'available') return;
    setState({ kind: 'installing' });
    try {
      await window.autog.updateApply(state.downloadUrl);
      // App is about to quit; banner stays in installing state.
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  const busy = state.kind === 'checking' || state.kind === 'installing';
  const buttonLabel =
    state.kind === 'checking' ? 'Checking…' :
    state.kind === 'installing' ? 'Installing…' :
    state.kind === 'available' ? 'Update & Restart' :
    'Check for Updates';
  const onClick = state.kind === 'available' ? install : check;

  return (
    <div className="prefix-panel">
      <div className="prefix-head">
        <div>
          <div className="prefix-title">Software updates</div>
          <div className="prefix-sub">
            {version ? <>Currently running AmazonG <b>v{version}</b>. </> : null}
            Click <b>Check for Updates</b> to see if a newer release is available on GitHub.
            Updating downloads the new build, swaps the app, and relaunches automatically — your
            saved sessions and job history stay intact.
          </div>
          {state.kind === 'up_to_date' && (
            <div className="prefix-status prefix-status-ok">✓ You're on the latest version (v{state.current}).</div>
          )}
          {state.kind === 'available' && (
            <div className="prefix-status prefix-status-info">
              ⬆ Update available: <b>v{state.latest}</b> (you have v{state.current}).
            </div>
          )}
          {state.kind === 'error' && (
            <div className="prefix-status prefix-status-err">⚠ {state.message}</div>
          )}
        </div>
        <button
          className={state.kind === 'available' ? 'primary-action' : 'ghost-btn'}
          onClick={() => void onClick()}
          disabled={busy}
        >
          {buttonLabel}
        </button>
      </div>
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

function StatCard(props: {
  icon: React.ReactNode;
  iconVariant: 'blue' | 'purple' | 'orange' | 'green' | 'red';
  title: string;
  subtitle?: string;
  rows: { label: string; value: React.ReactNode; valueClass?: string }[];
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
function BoltIcon() {
  return (
    <svg {...svgProps}>
      <path d="M13 2 3 14h7l-1 8 10-12h-7z" />
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
function InfoIcon() {
  return (
    <svg {...svgProps} width="22" height="22">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}
