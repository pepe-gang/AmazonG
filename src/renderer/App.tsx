import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { toast } from 'sonner';
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Toaster } from '@/components/ui/sonner';
import { AppSidebar } from '@/components/app-sidebar';
import { Deals } from '@/pages/Deals';
import type {
  AmazonProfile,
  JobAttempt,
  JobAttemptStatus,
  LogEvent,
  RendererStatus,
} from '@shared/types';
import type { Settings } from '@shared/ipc';
import { SNAPSHOT_ERROR_GROUPS } from '@shared/snapshotGroups';
import { computeProfit, retailPrice } from '@shared/profit';
import { parsePrice } from '@parsers/amazonProduct';
import {
  ALL_STATUS_GROUPS,
  attemptsToTSV,
  COLUMN_ALIGN,
  COLUMN_LABEL,
  DEFAULT_COLUMN_ORDER,
  DEFAULT_HIDDEN_COLUMNS,
  DEFAULT_VISIBLE_STATUS_GROUPS,
  resolveColumnOrder,
  STATUS_GROUP,
  STATUS_GROUP_BADGE_CLASS,
  STATUS_GROUP_LABEL,
  STATUS_LABEL,
  type JobColumnId,
  type SortDir,
  type SortKey,
  type StatusGroup,
} from './lib/jobsColumns.js';
import {
  formatBytes,
  formatDate,
  formatTime,
  formatUptime,
  relDate,
  relTime,
  shortEmail,
} from './lib/format.js';
import { useSettings } from './hooks/useSettings.js';
import {
  AppIcon,
  BackIcon,
  BoltIcon,
  DollarIcon,
  InfoIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  ShoppingIcon,
  StopIcon,
  UsersIcon,
} from './components/icons.js';
import { useConfirm } from './components/ConfirmDialog.js';
import { StatusBadge } from './components/StatusBadge.js';
import { LogsView } from './pages/Logs.js';
import { AccountsView } from './pages/Accounts.js';

const SETUP_GUIDE_URL = 'https://betterbg.vercel.app/dashboard/auto-buy';

function stripIpcPrefix(msg: string): string {
  return msg.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '').trim();
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

  return (
    <>
      {status.connected ? <MainScreen status={status} /> : <OnboardingScreen />}
      {/* Sonner Toaster: mounted at app root so any component can `toast(...)`.
          Styled via CSS vars inside sonner.tsx so it picks up our tokens. */}
      <Toaster />
    </>
  );
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
    // Drag-region padding on top so macOS traffic lights don't overlap
    // the card. Flex centers the card against the aurora background.
    <div
      className="flex flex-1 items-center justify-center px-6 pt-12 pb-6"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div
        className="glass w-full max-w-md p-7 flex flex-col gap-4"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <div className="flex size-12 items-center justify-center rounded-xl bg-accent-gradient text-white shadow-[0_4px_16px_-4px_oklch(0.65_0.18_180_/_0.4)]">
          <AppIcon />
        </div>
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-medium tracking-tight text-foreground">
            Paste your Secret Key
          </h1>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Link this device to your BetterBG account to start running jobs on Amazon.
          </p>
        </div>

        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (apiKey.trim() && !busy) void connect();
          }}
        >
          <label htmlFor="key" className="text-xs font-medium text-foreground/80">
            Secret Key
          </label>
          <Input
            id="key"
            type="password"
            placeholder="••••••••••••••••"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            disabled={busy}
            autoFocus
          />
          <Button type="submit" disabled={busy || !apiKey.trim()} className="mt-2 w-full">
            {busy ? 'Connecting…' : 'Continue'}
          </Button>
        </form>

        {error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            {error}
          </div>
        )}

        <div className="flex items-center justify-between gap-3 rounded-lg glass-inner p-3 text-sm">
          <div className="flex flex-col min-w-0">
            <span className="font-medium text-foreground/90">Don't have a key yet?</span>
            <span className="text-xs text-muted-foreground mt-0.5">
              Generate one in the BetterBG dashboard.
            </span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void window.autog.openExternal(SETUP_GUIDE_URL)}
          >
            Open Setup Guide →
          </Button>
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
  // Route-driven nav via HashRouter — logs are opened as a modal out of
  // the jobs table, not a full route. Keep `view` state out for now;
  // MainShell uses react-router internally so sidebar active states
  // stay in sync with the URL.
  return (
    <HashRouter>
      <MainShell status={status} />
    </HashRouter>
  );
}

/**
 * App shell: glass top-chrome header + sidebar + routed content. All
 * worker/status state lives here so status-pill and Start/Stop can
 * stay pinned across every route. Mirrors Bestie's `DashboardLayout`
 * pattern — one `SidebarProvider`, a header with `SidebarTrigger`, a
 * flex-row with `AppSidebar` + `SidebarInset`, and the routes inside.
 */
function MainShell({ status }: { status: RendererStatus }) {
  // Routing handles Dashboard/Accounts; the Logs drawer is a separate
  // right-side Sheet that opens on top of whichever route is active.
  // Clicking "View Log" on a jobs row sets `logsAttempt`; the Sheet
  // mounts LogsView and slides in without unmounting the dashboard.
  const [logsAttempt, setLogsAttempt] = useState<JobAttempt | null>(null);
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

  // Disconnect moved into AccountsView — kept out of the header so the
  // top chrome stays focused on worker state (Start/Stop + uptime).

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
    <SidebarProvider defaultOpen={false} className="!min-h-0 h-screen flex-col">
      <header
        className="glass-chrome flex h-12 shrink-0 items-center gap-2 border-b border-white/5 px-4 pl-24"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <Separator orientation="vertical" className="mr-2 !h-4" />
        <SidebarTrigger
          className="-ml-1"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        />
        <span className="font-medium text-sm">AmazonG</span>
        {appVersion && (
          <span className="text-xs text-muted-foreground">v{appVersion}</span>
        )}

        <div
          className="ml-auto flex items-center gap-2"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border border-white/10 bg-white/[0.04]">
            <span className="relative inline-flex items-center justify-center size-3">
              {/* Running = expanding ring behind a solid dot. Idle = flat
                  inert dot. Reduced motion users see the solid dot only
                  (animate-ping is suppressed by prefers-reduced-motion). */}
              {status.running && (
                <span className="absolute inset-0 rounded-full bg-emerald-400/70 animate-ping" />
              )}
              <span
                className={
                  'relative size-2 rounded-full ' +
                  (status.running
                    ? 'bg-emerald-400 shadow-[0_0_6px_0_oklch(0.75_0.18_150_/_0.9)]'
                    : 'bg-white/20')
                }
              />
            </span>
            <span className="tabular-nums text-foreground/90">
              {status.running ? uptimeLabel : 'Idle'}
            </span>
          </div>
          <Button
            variant={status.running ? 'destructive' : 'default'}
            size="sm"
            onClick={toggleWorker}
            disabled={busy}
          >
            {status.running ? <StopIcon /> : <PlayIcon />}
            {status.running ? 'Stop' : 'Start'}
          </Button>
        </div>
      </header>

      <div className="flex flex-1 min-h-0 w-full">
        <AppSidebar version={appVersion || undefined} />
        <SidebarInset>
          {/* No `overflow-hidden` on this outer column — pop-overs /
              dialogs / dropdowns anchored inside the page need to be
              able to escape vertically. Inner scroll containers
              (`.jobs-table-wrap`, logs body) keep their own bounds. */}
          <div className="flex flex-1 flex-col min-h-0">
            {updateInfo && !updateDismissed && (
              <div
                className="mx-4 mt-3 flex items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-sm text-amber-100"
                role="status"
              >
                <span className="flex-1">
                  <b>AmazonG v{updateInfo.latest}</b> is available (you have v{appVersion}).
                  Download the latest from the{' '}
                  <button
                    className="underline hover:text-amber-50"
                    onClick={() =>
                      void window.autog.openExternal('https://betterbg.vercel.app/dashboard/auto-buy')
                    }
                  >
                    BetterBG setup guide
                  </button>
                  .
                </span>
                <Button variant="ghost" size="sm" onClick={() => setUpdateDismissed(true)}>
                  Dismiss
                </Button>
              </div>
            )}
            {status.lastError && (
              <div className="mx-4 mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                {status.lastError}
              </div>
            )}
            <Routes>
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route
                path="/dashboard"
                element={
                  <DashboardView
                    status={status}
                    uptimeLabel={uptimeLabel}
                    attempts={attempts}
                    profiles={profiles}
                    onViewLogs={setLogsAttempt}
                  />
                }
              />
              <Route
                path="/accounts"
                element={
                  <AccountsView
                    profiles={profiles}
                    workerRunning={status.running}
                    identity={status.identity}
                  />
                }
              />
              <Route path="/deals" element={<Deals />} />
            </Routes>
          </div>
        </SidebarInset>
      </div>

      {/* Logs as a right-side Sheet — the dashboard stays mounted
          underneath so closing the drawer returns users to the exact
          scroll position they left. onOpenChange handles both the
          built-in X close and swipe/escape dismissal. */}
      <Sheet
        open={logsAttempt !== null}
        onOpenChange={(next) => {
          if (!next) setLogsAttempt(null);
        }}
      >
        <SheetContent
          side="right"
          className="w-full sm:max-w-3xl p-0 gap-0 flex flex-col"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>
              Attempt logs — {logsAttempt?.dealTitle ?? logsAttempt?.amazonEmail ?? ''}
            </SheetTitle>
          </SheetHeader>
          <div className="flex-1 min-h-0 overflow-auto">
            {logsAttempt && <LogsView attempt={logsAttempt} />}
          </div>
        </SheetContent>
      </Sheet>
    </SidebarProvider>
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
  const { settings } = useSettings();
  // Timestamp of the last time the user reset the Failed counter.
  // Every attempt with a failed status whose createdAt is earlier than
  // this is excluded from the count + the failures-by-reason
  // breakdown. The rows themselves still exist (BG re-syncs them);
  // this is purely a display filter.
  const failedHiddenBeforeTs = settings?.failedHiddenBeforeTs ?? null;

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
      const group = STATUS_GROUP[a.status];
      // Hide pre-reset failures from the counter — the popover's Clear
      // action stamps settings.failedHiddenBeforeTs when the user wants
      // to start fresh. Server rows keep flowing in through
      // listMergedAttempts; we just skip them in the dashboard number.
      if (
        group === 'failed' &&
        failedHiddenBeforeTs !== null &&
        a.createdAt < failedHiddenBeforeTs
      ) {
        continue;
      }
      c[group] += 1;
    }
    return c;
  }, [attempts, failedHiddenBeforeTs]);

  const failedErrorBreakdown = useMemo(() => {
    const by = new Map<string, number>();
    for (const a of attempts) {
      if (STATUS_GROUP[a.status] !== 'failed') continue;
      if (failedHiddenBeforeTs !== null && a.createdAt < failedHiddenBeforeTs) continue;
      const key = normalizeFailureError(a.error);
      by.set(key, (by.get(key) ?? 0) + 1);
    }
    return Array.from(by.entries()).sort((a, b) => b[1] - a[1]);
  }, [attempts, failedHiddenBeforeTs]);

  const fmt = (n: number) => `${n >= 0 ? '+' : '−'}$${Math.abs(n).toFixed(2)}`;

  return (
    // No `overflow-hidden` here — the inner Jobs section has its own
    // scroll container (`.jobs-table-wrap`) and clipping this wrapper
    // also clips absolute-positioned popovers anchored to the stat
    // tiles above (e.g. FailedErrorPopover).
    <div className="flex flex-1 flex-col gap-3 p-5 min-h-0">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
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

      <section className="glass flex flex-1 min-h-0 flex-col overflow-hidden">
        <JobsTable
          attempts={attempts}
          profiles={profiles}
          onViewLogs={onViewLogs}
          workerRunning={status.running}
        />
      </section>
    </div>
  );
}

/* ============================================================
   Jobs table
   ============================================================ */

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
  // Empty set = all accounts. Non-empty = only show rows whose
  // amazonEmail is in the set. Session-scoped — not persisted.
  const [accountFilter, setAccountFilter] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [orderToast, setOrderToast] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState<null | 'verify' | 'delete' | 'tracking'>(null);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const { confirm, dialog: confirmDialog } = useConfirm();

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

  // Per-group row counts shown on the inline filter pills. Respects the
  // account/search filters so the numbers match what you'd see if you
  // toggled that status on — otherwise "Failed · 1295" would mislead
  // after you picked a single account.
  const statusGroupCounts = useMemo(() => {
    const q = search.trim().toLowerCase();
    const c: Record<StatusGroup, number> = { pending: 0, success: 0, cancelled: 0, failed: 0 };
    for (const a of attempts) {
      if (accountFilter.size > 0 && !accountFilter.has(a.amazonEmail)) continue;
      if (q.length > 0) {
        const hay = `${a.dealTitle ?? ''} ${a.amazonEmail} ${a.dealId ?? ''} ${a.dealKey ?? ''} ${a.orderId ?? ''}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      c[STATUS_GROUP[a.status]] += 1;
    }
    return c;
  }, [attempts, accountFilter, search]);


  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = attempts.filter((a) => {
      if (!visibleStatusGroups.has(STATUS_GROUP[a.status])) return false;
      if (accountFilter.size > 0 && !accountFilter.has(a.amazonEmail)) return false;
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
        case 'fillerOrders': {
          // Rows with no filler orders sort as "empty" (first asc, last
          // desc). Ones with orders compare by their first id so users
          // can quickly line up rows from the same filler placement.
          const aId = a.fillerOrderIds?.[0] ?? '';
          const bId = b.fillerOrderIds?.[0] ?? '';
          return aId.localeCompare(bId);
        }
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
    setAccountFilter(new Set());
    setSearch('');
  };

  const statusFilterIsCustom =
    visibleStatusGroups.size !== DEFAULT_VISIBLE_STATUS_GROUPS.length ||
    !DEFAULT_VISIBLE_STATUS_GROUPS.every((s) => visibleStatusGroups.has(s));
  const hasFilter = statusFilterIsCustom || accountFilter.size > 0 || search.length > 0;

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

  const runBulkDelete = () => {
    if (selectedAttempts.length === 0) return;
    const count = selectedAttempts.length;
    confirm({
      title: `Delete ${count} row${count === 1 ? '' : 's'}?`,
      message: `This removes the selected attempt${count === 1 ? '' : 's'} and ${count === 1 ? 'its log' : 'their logs'} from disk. This cannot be undone.`,
      confirmLabel: `Delete ${count}`,
      danger: true,
      onConfirm: async () => {
        setBulkBusy('delete');
        // Bulk path: one IPC + one cache mutation + parallel log/snapshot
        // unlinks on the main side. Much faster than looping jobsDelete —
        // a 1000-row delete drops from ~30s to well under a second.
        setBulkProgress({ done: 0, total: count });
        try {
          const removed = await window.autog.jobsDeleteBulk(
            selectedAttempts.map((a) => a.attemptId),
          );
          toast.success(`Deleted ${removed} row${removed === 1 ? '' : 's'}`);
        } catch (err) {
          toast.error('Delete failed', {
            description: err instanceof Error ? err.message : String(err),
          });
        } finally {
          setSelected(new Set());
          setBulkBusy(null);
          setBulkProgress(null);
        }
      },
    });
  };

  return (
    // Outer is a plain flex column — the parent DashboardView section
    // already wraps this in `.glass` so we don't need another card
    // surface here. The inner blocks inherit that translucent shell.
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-white/[0.04]">
        <h2 className="text-base font-medium tracking-tight">Amazon Purchases</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {visible.length} of {attempts.length} row{attempts.length === 1 ? '' : 's'}
        </span>
      </div>

      {attempts.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-white/[0.04]">
          <Input
            type="search"
            placeholder="Search title, account, deal key, order id…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 max-w-xs"
          />
          <ColumnsMenu
            order={fullColumnOrder}
            hidden={hiddenSet}
            onToggle={setColumnHidden}
            onReset={() => void update({ jobsColumnOrder: [], jobsColumnHidden: [] })}
          />
          <AccountFilterMenu
            options={accountOptions}
            selected={accountFilter}
            onToggle={(email, on) => {
              const next = new Set(accountFilter);
              if (on) next.add(email);
              else next.delete(email);
              setAccountFilter(next);
            }}
            onClear={() => setAccountFilter(new Set())}
          />
          <div className="flex items-center gap-1.5">
            {ALL_STATUS_GROUPS.map((s) => {
              const active = visibleStatusGroups.has(s);
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatusGroupVisible(s, !active)}
                  className={`status-filter-pill ${s} ${active ? 'is-active' : ''}`}
                  title={active ? `Hide ${STATUS_GROUP_LABEL[s]}` : `Show ${STATUS_GROUP_LABEL[s]}`}
                >
                  {STATUS_GROUP_LABEL[s]}
                  <span className="status-filter-count">· {statusGroupCounts[s]}</span>
                </button>
              );
            })}
          </div>
          {hasFilter && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              Clear
            </Button>
          )}
        </div>
      )}

      {selected.size > 0 && (
        <div
          className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-white/[0.04] bg-accent/30"
          role="toolbar"
        >
          <span className="text-xs text-muted-foreground mr-1">
            {bulkBusy && bulkProgress
              ? `${bulkBusy === 'verify' ? 'Verifying' : bulkBusy === 'tracking' ? 'Fetching tracking' : 'Deleting'} ${bulkProgress.done}/${bulkProgress.total}…`
              : `${selected.size} selected`}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={bulkBusy !== null}
            title={`Copy ${selected.size} row${selected.size === 1 ? '' : 's'} as TSV (paste into Google Sheets / Excel)`}
            onClick={async () => {
              const tsv = attemptsToTSV(selectedAttempts, columnOrder);
              try {
                await navigator.clipboard.writeText(tsv);
                toast.success(
                  `Copied ${selectedAttempts.length} row${selectedAttempts.length === 1 ? '' : 's'}`,
                  { description: 'Paste into a spreadsheet.' },
                );
              } catch (err) {
                toast.error('Copy failed', {
                  description: err instanceof Error ? err.message : String(err),
                });
              }
            }}
          >
            Copy ({selected.size})
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={bulkBusy !== null || selectedVerifiable.length === 0}
            title={
              selectedVerifiable.length === 0
                ? 'None of the selected rows have an order id to verify'
                : `Re-check Amazon for ${selectedVerifiable.length} order${selectedVerifiable.length === 1 ? '' : 's'}`
            }
            onClick={() => void runBulkVerify()}
          >
            Verify Order ({selectedVerifiable.length})
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={bulkBusy !== null || selectedForTracking.length === 0}
            title={
              selectedForTracking.length === 0
                ? 'None of the selected rows have an order id to fetch tracking for'
                : `Fetch carrier tracking for ${selectedForTracking.length} order${selectedForTracking.length === 1 ? '' : 's'}`
            }
            onClick={() => void runBulkFetchTracking()}
          >
            Fetch Tracking ({selectedForTracking.length})
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={bulkBusy !== null}
            onClick={() => void runBulkDelete()}
          >
            Delete ({selected.size})
          </Button>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto jobs-table-wrap">
        {attempts.length === 0 ? (
          <div className="flex items-center justify-center min-h-[200px] text-sm text-muted-foreground text-center px-8">
            {workerRunning
              ? 'Worker is polling. Rows will appear once a job is claimed.'
              : 'Click Start to begin polling BetterBG for jobs. Each claimed job will create one row per Amazon account.'}
          </div>
        ) : visible.length === 0 ? (
          <div className="flex items-center justify-center min-h-[200px] text-sm text-muted-foreground">
            No rows match current filters.
          </div>
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
                      onOpenFillerOrder={(oid) => void openOrderInProfile(a.amazonEmail, oid)}
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
      {confirmDialog}
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
 * Multi-select Amazon-account filter. Empty selection = all accounts.
 * Shows the count in the trigger so users see at a glance how many
 * accounts are narrowing the view.
 */
function AccountFilterMenu({
  options,
  selected,
  onToggle,
  onClear,
}: {
  options: { email: string; label: string }[];
  selected: Set<string>;
  onToggle: (email: string, on: boolean) => void;
  onClear: () => void;
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
  const label =
    selected.size === 0
      ? 'All accounts'
      : selected.size === 1
      ? (options.find((o) => o.email === Array.from(selected)[0])?.label ?? '1 account')
      : `${selected.size} accounts`;
  return (
    <div className="action-menu-wrap" ref={ref}>
      <button
        className="ghost-btn"
        onClick={() => setOpen((o) => !o)}
        title="Filter by Amazon account. Tick multiple to union."
      >
        {label} ▾
      </button>
      {open && (
        <div className="action-menu columns-menu">
          {options.length === 0 ? (
            <div className="columns-menu-item" style={{ opacity: 0.6, cursor: 'default' }}>
              No accounts yet
            </div>
          ) : (
            options.map(({ email, label }) => (
              <label key={email} className="columns-menu-item">
                <input
                  type="checkbox"
                  checked={selected.has(email)}
                  onChange={(e) => onToggle(email, e.target.checked)}
                />
                {label}
              </label>
            ))
          )}
          {selected.size > 0 && (
            <>
              <div className="action-menu-sep" />
              <button
                className="action-menu-item"
                onClick={() => {
                  onClear();
                  setOpen(false);
                }}
              >
                Show all accounts
              </button>
            </>
          )}
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
            toast.success('Copied', { description: value, duration: 1800 });
          })
          .catch((err) => {
            toast.error('Copy failed', {
              description: err instanceof Error ? err.message : String(err),
            });
          });
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
  onOpenFillerOrder,
}: {
  id: JobColumnId;
  a: JobAttempt;
  accountLabel: string | null;
  onOpenProductUrl: (url: string) => void;
  onOpenOrder: () => void;
  /** Open a specific filler order id in this row's Amazon profile
   *  session. Mirrors `onOpenOrder` but takes the id as a param
   *  because a row has 0..N filler orders, not a single bound one. */
  onOpenFillerOrder: (orderId: string) => void;
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
                  title="Click to copy tracking id"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(code)
                      .then(() =>
                        toast.success('Tracking id copied', {
                          description: code,
                          duration: 1800,
                        }),
                      )
                      .catch((err) =>
                        toast.error('Copy failed', {
                          description: err instanceof Error ? err.message : String(err),
                        }),
                      );
                  }}
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
    case 'fillerOrders':
      // Buy-with-Fillers audit trail. Each id is an Amazon order that
      // came from the Place Order fan-out but does NOT contain the
      // target — AutoG tries to cancel each inline + in the verify
      // phase. Click a pill to open that order in the signed-in
      // Amazon profile's session (same UX as the Order ID column).
      return (
        <td className="cell-orderid">
          {a.fillerOrderIds && a.fillerOrderIds.length > 0 ? (
            <div className="tracking-list">
              {a.fillerOrderIds.map((oid) => (
                <a
                  key={oid}
                  href="#"
                  className="orderid-link"
                  title={`Open filler order in ${a.amazonEmail}'s signed-in session`}
                  onClick={(e) => {
                    e.preventDefault();
                    onOpenFillerOrder(oid);
                  }}
                >
                  {oid}
                </a>
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
          {a.error && (
            <div
              className={
                'cell-error ' +
                (a.status === 'cancelled_by_amazon' ? 'cell-error-cancelled' : '')
              }
              title={a.error}
            >
              {a.error}
            </div>
          )}
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
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const { confirm, dialog: confirmDialog } = useConfirm();
  const { update } = useSettings();
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  // Position the popover in viewport coords each time it opens. Doing
  // it on open (not on render) means we don't need to listen for
  // scroll/resize; if the user scrolls with the popover open we just
  // accept the slight drift — the click-outside handler closes it
  // soon enough. Simpler than a full Radix Popover install.
  useEffect(() => {
    if (!open || !wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    setCoords({ top: rect.bottom + 6, left: rect.left });
  }, [open]);

  // Click-outside handler — needs to look at BOTH the trigger wrap and
  // the popover (which is now portaled elsewhere in the DOM).
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  if (breakdown.length === 0) return null;
  return (
    <span className="stat-label-info-wrap" ref={wrapRef}>
      <button
        type="button"
        className="stat-label-info"
        aria-label={`Show error breakdown for ${total} failed order${total === 1 ? '' : 's'}`}
        onClick={(e) => { e.preventDefault(); setOpen((o) => !o); }}
      >
        <InfoIcon size={14} />
      </button>
      {open && coords &&
        createPortal(
          <div
            ref={popRef}
            role="dialog"
            className="error-breakdown-pop"
            style={{
              // position: fixed so ancestor stacking contexts (the
              // adjacent .glass section's backdrop-filter layer) can't
              // occlude us. `z-[1000]` keeps us above everything.
              position: 'fixed',
              top: coords.top,
              left: coords.left,
              zIndex: 1000,
            }}
          >
            <div className="flex items-center justify-between gap-3 mb-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Failures by reason
              </span>
              {/* Resets the failure counter + the rest of this breakdown by
                  deleting every failed jobs row. Permanent — the rows +
                  their logs are removed locally. */}
              <Button
                variant="ghost"
                size="xs"
                className="text-red-300 hover:text-red-200 hover:bg-red-500/10"
                onClick={() => {
                  // Close the popover first — if we leave it open, its
                  // z-[1000] sits above the shadcn Dialog (z-50) and the
                  // confirm prompt ends up visually buried underneath.
                  setOpen(false);
                  confirm({
                    title: `Reset Failed counter?`,
                    message: `Hides the ${total} current failure${total === 1 ? '' : 's'} from the Dashboard counter and the failures-by-reason list. The rows themselves stay in Jobs so logs remain accessible; new failures after this point count normally.`,
                    confirmLabel: 'Reset',
                    danger: true,
                    onConfirm: async () => {
                      try {
                        // Stamp "now" so pre-existing failures are
                        // filtered out of the counter. Also sweep local
                        // failed rows in the same shot so the Jobs
                        // table doesn't carry dead rows that BG won't
                        // re-sync (failed rows with no orderId).
                        await update({ failedHiddenBeforeTs: new Date().toISOString() });
                        await window.autog.jobsClearFailed().catch(() => 0);
                        toast.success(`Reset — hiding ${total} prior failure${total === 1 ? '' : 's'}`);
                      } catch (err) {
                        toast.error('Reset failed', {
                          description: err instanceof Error ? err.message : String(err),
                        });
                      }
                    },
                  });
                }}
              >
                Clear
              </Button>
            </div>
            <ul className="error-breakdown-list">
              {breakdown.map(([msg, n]) => (
                <li key={msg}>
                  <span className="error-breakdown-count">{n}</span>
                  <span className="error-breakdown-msg">{msg}</span>
                </li>
              ))}
            </ul>
          </div>,
          document.body,
        )}
      {confirmDialog}
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
  // Icon-badge tints — the accent-gradient is reserved for the primary
  // brand moments, so stat tiles use their own desaturated jewel tones
  // with matching alpha backgrounds. Colors hand-picked against the
  // glass surface so every variant stays readable.
  const badge: Record<typeof props.iconVariant, string> = {
    blue: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
    purple: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
    orange: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    green: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    red: 'bg-red-500/15 text-red-300 border-red-500/30',
  };
  const valueTone = (cls?: string): string => {
    if (!cls) return '';
    if (cls.includes('green')) return 'text-emerald-300';
    if (cls.includes('red')) return 'text-red-300';
    if (cls.includes('purple')) return 'text-violet-300';
    if (cls.includes('muted')) return 'text-muted-foreground';
    return '';
  };

  return (
    <div className="glass flex flex-col gap-3 p-4">
      <div className="flex items-start gap-3">
        <div
          className={
            'flex size-9 shrink-0 items-center justify-center rounded-lg border ' +
            badge[props.iconVariant]
          }
        >
          {props.icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium leading-tight">{props.title}</div>
          {props.subtitle && (
            <div className="text-xs text-muted-foreground mt-0.5">{props.subtitle}</div>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-1.5 text-sm">
        {props.rows.map((r, i) => (
          <div
            key={i}
            className="flex items-center justify-between gap-3 border-t border-white/[0.04] pt-1.5 first:border-t-0 first:pt-0"
          >
            <span className="text-xs uppercase tracking-wider text-muted-foreground/80 flex items-center gap-1">
              {r.label}
            </span>
            <span className={'tabular-nums font-medium ' + valueTone(r.valueClass)}>
              {r.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

