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
  LogEvent,
  RendererStatus,
} from '@shared/types';
import { computeProfit } from '@shared/profit';
import { STATUS_GROUP } from './lib/jobsColumns.js';
import { formatUptime } from './lib/format.js';
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
import { LogsView } from './pages/Logs.js';
import { AccountsView } from './pages/Accounts.js';
import { PurchasesView } from './pages/Purchases.js';
import { SettingsView } from './pages/Settings.js';
import { AccountStatsCard } from './components/AccountStatsCard.js';

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
    // Pause perpetual CSS animations (aurora drift + animate-ping
    // halos) when the window is hidden. The 1s uptime tick used to
    // live here too — it's been moved into <UptimeText /> so it only
    // re-renders that one component instead of MainShell + every
    // routed page.
    const onVisibility = () => {
      if (document.hidden) document.body.classList.add('bg-paused');
      else document.body.classList.remove('bg-paused');
    };
    if (document.hidden) document.body.classList.add('bg-paused');
    document.addEventListener('visibilitychange', onVisibility);
    // Server-state poll: picks up cross-device changes and verify-phase
    // flips that happen on the BetterBG worker without a local trigger.
    const serverPoll = setInterval(() => {
      void window.autog.jobsList().then(setAttempts).catch(() => undefined);
    }, 30_000);
    return () => {
      off();
      offProfiles();
      offJobs();
      document.removeEventListener('visibilitychange', onVisibility);
      document.body.classList.remove('bg-paused');
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
  // (Uptime label is rendered by <UptimeText /> below — it owns its own
  // 1s interval so the per-second tick doesn't re-render this whole
  // shell + every routed page.)

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
              {status.running ? <UptimeText startedAt={stats.startedAt} /> : 'Idle'}
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
                    startedAt={stats.startedAt}
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
                  />
                }
              />
              <Route
                path="/purchases"
                element={
                  <PurchasesView
                    attempts={attempts}
                    profiles={profiles}
                    workerRunning={status.running}
                    onViewLogs={setLogsAttempt}
                  />
                }
              />
              <Route
                path="/settings"
                element={
                  <SettingsView
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
  startedAt: number | null;
  attempts: JobAttempt[];
  profiles: AmazonProfile[];
  onViewLogs: (a: JobAttempt) => void;
}) {
  const { status, startedAt, attempts, profiles, onViewLogs } = props;
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
    // No `overflow-hidden` here — clipping this wrapper also clips
    // absolute-positioned popovers anchored to the stat tiles (e.g.
    // FailedErrorPopover). The full purchases table + active-jobs
    // panel live on the /purchases tab now.
    <div className="flex flex-1 flex-col gap-3 p-5 min-h-0 overflow-auto">
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
            { label: 'Uptime', value: status.running ? <UptimeText startedAt={startedAt} /> : '—', valueClass: 'muted' },
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

      <AccountStatsCard attempts={attempts} profiles={profiles} />
    </div>
  );
}

/**
 * Renders the worker's uptime as a live string ("12s", "3m 04s",
 * "1h 02m"). Owns its own 1s interval — extracted from MainShell so
 * the per-second tick re-renders only this one span instead of the
 * whole shell + every routed page (which used to drag the JobsTable's
 * useMemos and StatCard subtrees through a tick they didn't need).
 *
 * Pauses when the window is hidden via the `visibilitychange` event,
 * so a backgrounded AmazonG isn't burning CPU updating an invisible
 * label. Bumps once on resume so the visible label catches up before
 * the next tick fires.
 */
function UptimeText({ startedAt }: { startedAt: number | null }) {
  const [, force] = useState(0);
  useEffect(() => {
    if (startedAt === null) return;
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (id !== null) return;
      id = setInterval(() => force((n) => n + 1), 1000);
    };
    const stop = () => {
      if (id === null) return;
      clearInterval(id);
      id = null;
    };
    const onVis = () => {
      if (document.hidden) stop();
      else {
        force((n) => n + 1);
        start();
      }
    };
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [startedAt]);
  if (startedAt === null) return <>—</>;
  return <>{formatUptime(Date.now() - startedAt)}</>;
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

