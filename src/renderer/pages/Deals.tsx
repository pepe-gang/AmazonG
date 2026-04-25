import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, MapPin, ChevronDown, ChevronUp, ChevronsUpDown, Send, Info } from 'lucide-react';
import { toast } from 'sonner';

import type { AmazonDeal } from '@shared/ipc';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { DealImageTile } from '@/components/deal-image-tile';
import { cn } from '@/lib/utils';
import {
  computeMargin,
  fmtDollars,
  timeAgo,
  truncateAtWord,
} from '@/lib/helpers';

/** Opens in the OS default browser via Electron's shell.openExternal
 *  IPC — keeps Amazon / BG links out of the app window. */
function openExternal(e: React.MouseEvent, url: string) {
  e.stopPropagation();
  e.preventDefault();
  void window.autog.openExternal(url);
}

/** BG returns price/oldPrice as Decimal strings. Parse defensively:
 *  unparseable or missing values become undefined so the UI shows a
 *  `—` instead of `NaN`. */
function toNumber(v: string | null | undefined): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Margin % of payout vs retail. Used as the sort key for the Margin
 *  column so deals with the biggest rebate float to the top. BG feed
 *  convention: missing retail means retail equals payout → 0% margin.
 *  Null only when payout itself is missing — those rows sink to the
 *  end regardless of direction. */
function marginPct(d: AmazonDeal): number | null {
  const price = toNumber(d.price);
  const oldPrice = toNumber(d.oldPrice);
  if (price === undefined) return null;
  if (oldPrice === undefined || oldPrice === 0) return 0;
  return ((price - oldPrice) / oldPrice) * 100;
}

/** Parse BG's "MM-DD-YYYY" expiryDay into a ms timestamp. null-safe. */
function expiryMs(day: string | null): number | null {
  if (!day) return null;
  const [mm, dd, yyyy] = day.split('-').map((n) => parseInt(n, 10));
  if (!mm || !dd || !yyyy) return null;
  return new Date(yyyy, mm - 1, dd).getTime();
}

/** Three-way comparator: negatives first, then numbers asc; null values
 *  always sink to the end regardless of direction so the user can scan
 *  the known-good data at the top. */
function cmpNullable(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

type SortKey = 'product' | 'pricing' | 'margin' | 'expires' | 'discovered';
type SortDir = 'asc' | 'desc';

/**
 * Clickable table header that advertises + toggles sort state. The
 * column shows its active sort direction inline; inactive columns
 * render a neutral two-arrow glyph on hover to hint at interactivity
 * without crowding the header row.
 */
function SortableHead({
  className,
  label,
  active,
  dir,
  onClick,
}: {
  className?: string;
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
}) {
  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'inline-flex items-center gap-1 w-full text-left -mx-1 px-1 py-0.5 rounded hover:bg-white/[0.04] transition-colors',
          active ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        <span>{label}</span>
        {active ? (
          dir === 'asc' ? (
            <ChevronUp className="size-3" />
          ) : (
            <ChevronDown className="size-3" />
          )
        ) : (
          <ChevronsUpDown className="size-3 opacity-0 group-hover:opacity-100" />
        )}
      </button>
    </TableHead>
  );
}

type AutoEnqueueCfg = {
  enabled: boolean;
  intervalHours: number;
  shipToFilter: string;
  minMarginPct: number;
  maxPerTick: number;
};

type AutoEnqueueStatus = Awaited<
  ReturnType<typeof window.autog.autoEnqueueStatus>
>;

/** Coerce a number-input value into the schedule's allowed bounds.
 *  Empty / NaN falls back to the previous good value so the user can
 *  clear and retype without the input snapping to 1. */
function clampInterval(raw: string, prev: number): number {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return prev;
  return Math.max(1, Math.min(168, n));
}

function clampMaxPerTick(raw: string, prev: number): number {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return prev;
  return Math.max(1, Math.min(1000, n));
}

/** Margin floor accepts decimals (e.g. -3.5) and a wide range so the
 *  user can effectively disable the filter (-100) or ratchet it up
 *  (any positive number). Empty / NaN → keep previous value. */
function clampMinMargin(raw: string, prev: number): number {
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return prev;
  return Math.max(-100, Math.min(100, n));
}

/** Compact "in 2h", "in 12m", "now" formatter for the next-run hint. */
function fmtUntil(ms: number): string {
  if (ms <= 0) return 'now';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `in ${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `in ${hr}h`;
  const day = Math.round(hr / 24);
  return `in ${day}d`;
}

/**
 * Schedule controls for unattended deal enqueueing. Sits above the
 * deals table so it's discoverable, but kept to a single line so it
 * doesn't crowd the page. Selection-free by design — see
 * src/main/autoEnqueueScheduler.ts for the rationale (the schedule is
 * an evergreen rule against the live catalog, not a snapshot).
 */
function AutoEnqueueBar({ availableStates }: { availableStates: string[] }) {
  const [cfg, setCfg] = useState<AutoEnqueueCfg | null>(null);
  const [status, setStatus] = useState<AutoEnqueueStatus | null>(null);
  const [busy, setBusy] = useState(false);
  // Tick-tock to make "in 22h" / "2h ago" labels recompute without the
  // user having to click anything. Cheap — we just bump a number.
  const [, setNowTick] = useState(0);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await window.autog.autoEnqueueStatus();
      setStatus(s);
    } catch {
      // Status is purely informational; swallow transport errors so a
      // hiccup doesn't toast on every poll.
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const [s, st] = await Promise.all([
          window.autog.settingsGet(),
          window.autog.autoEnqueueStatus(),
        ]);
        setCfg({
          enabled: s.autoEnqueueEnabled,
          intervalHours: s.autoEnqueueIntervalHours,
          shipToFilter: s.autoEnqueueShipToFilter,
          minMarginPct: s.autoEnqueueMinMarginPct,
          maxPerTick: s.autoEnqueueMaxPerTick,
        });
        setStatus(st);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : 'Failed to load auto-enqueue settings',
        );
      }
    })();
  }, []);

  // Status poll + clock tick: re-fetch real status every 30s, refresh
  // the "ago"/"in" labels every 30s as well. The tick is decoupled
  // from polling so a stalled IPC doesn't freeze the labels.
  useEffect(() => {
    const id = setInterval(() => {
      void refreshStatus();
      setNowTick((n) => n + 1);
    }, 30_000);
    return () => clearInterval(id);
  }, [refreshStatus]);

  const update = useCallback(
    async (patch: Partial<AutoEnqueueCfg>) => {
      if (!cfg) return;
      const next = { ...cfg, ...patch };
      setCfg(next);
      setBusy(true);
      try {
        await window.autog.settingsSet({
          autoEnqueueEnabled: next.enabled,
          autoEnqueueIntervalHours: next.intervalHours,
          autoEnqueueShipToFilter: next.shipToFilter,
          autoEnqueueMinMarginPct: next.minMarginPct,
          autoEnqueueMaxPerTick: next.maxPerTick,
        });
        await refreshStatus();
      } catch (err) {
        // Roll back optimistic change so the UI doesn't lie about
        // what's persisted.
        setCfg(cfg);
        toast.error(
          err instanceof Error ? err.message : 'Failed to save schedule',
        );
      } finally {
        setBusy(false);
      }
    },
    [cfg, refreshStatus],
  );

  if (!cfg) return null;

  const lastResult = status?.lastResult ?? null;
  const lastRunAt = status?.lastRunAt ?? null;
  const nextRunAt = status?.nextRunAt ?? null;
  const now = Date.now();

  return (
    <TooltipProvider>
      <div
        className="rounded-md border border-white/[0.06] bg-white/[0.02]"
        role="region"
        aria-label="Scheduled auto-add"
      >
        {/* Header: title + toggle on opposite ends of one row, with an
            always-visible description directly below so the user
            doesn't have to hover anything to know what the feature
            does. The card border + faint wash make this read as a
            single component rather than another inline filter strip. */}
        <div className="px-4 pt-2.5 pb-2">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xs font-semibold text-foreground/90">
              Auto-add eligible deals
            </h3>
            <label className="flex items-center gap-2 cursor-pointer">
              <span className="text-[11px] text-muted-foreground">
                {cfg.enabled ? 'On' : 'Off'}
              </span>
              <Switch
                checked={cfg.enabled}
                onCheckedChange={(v) => void update({ enabled: v })}
                disabled={busy}
              />
            </label>
          </div>
          <p className="text-[11px] text-muted-foreground leading-snug mt-1 max-w-3xl">
            On the schedule below, AmazonG fetches the live BG deals
            list and queues every active, non-expired deal whose margin
            is at or above the floor and that ships to the selected
            state — capped at <span className="text-foreground/80">max per run</span>. No
            need to pick deals: new ones that show up between runs are
            picked up automatically. Deals already attempted within the
            dedup window are skipped so the same deal isn't bought
            twice in a row.
          </p>
        </div>

        {/* Controls row. Disabled (greyed) when the master toggle is
            off so the user can see what they'd be configuring without
            being able to silently change values that don't take
            effect yet. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 pt-2 pb-2.5 border-t border-white/[0.04]">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>every</span>
          <input
            type="number"
            min={1}
            max={168}
            value={cfg.intervalHours}
            onChange={(e) =>
              setCfg((c) =>
                c ? { ...c, intervalHours: parseInt(e.target.value, 10) || c.intervalHours } : c,
              )
            }
            onBlur={(e) =>
              void update({ intervalHours: clampInterval(e.target.value, cfg.intervalHours) })
            }
            disabled={busy || !cfg.enabled}
            className="h-7 w-14 rounded-md border border-white/10 bg-white/[0.04] px-2 text-xs text-foreground/90 tabular-nums disabled:opacity-50"
          />
          <span>hours</span>
        </label>

        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>ship to</span>
          <select
            value={cfg.shipToFilter}
            onChange={(e) => void update({ shipToFilter: e.target.value })}
            disabled={busy || !cfg.enabled}
            className="h-7 rounded-md border border-white/10 bg-white/[0.04] px-2 text-xs text-foreground/90 tabular-nums disabled:opacity-50"
          >
            <option value="all">All states</option>
            {availableStates.map((s) => (
              <option key={s} value={s}>
                {s.slice(0, 2).toUpperCase()} — {s.replace(/\b\w/g, (c) => c.toUpperCase())}
              </option>
            ))}
            {/* Persisted value isn't in availableStates yet (e.g. the
                catalog hasn't loaded a deal in that state today) —
                surface it anyway so the user sees what's saved. */}
            {!availableStates.includes(cfg.shipToFilter) &&
              cfg.shipToFilter !== 'all' && (
                <option value={cfg.shipToFilter}>
                  {cfg.shipToFilter.slice(0, 2).toUpperCase()} —{' '}
                  {cfg.shipToFilter.replace(/\b\w/g, (c) => c.toUpperCase())}
                </option>
              )}
          </select>
        </label>

        {/* Margin floor. Spelled out as "≥ N %" so the user reads the
            comparison in their head as "anything at or above this gets
            queued". Decimal-friendly (step=0.1) because BG margins
            cluster around the -3% to +5% range. */}
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>
            min margin <span className="text-foreground/80">≥</span>
          </span>
          <input
            type="number"
            step={0.1}
            min={-100}
            max={100}
            placeholder="-3.5"
            value={cfg.minMarginPct}
            onChange={(e) =>
              setCfg((c) => {
                if (!c) return c;
                const n = parseFloat(e.target.value);
                return Number.isFinite(n) ? { ...c, minMarginPct: n } : c;
              })
            }
            onBlur={(e) =>
              void update({ minMarginPct: clampMinMargin(e.target.value, cfg.minMarginPct) })
            }
            disabled={busy || !cfg.enabled}
            // Wider than the other numeric inputs so a value like
            // "-3.5" sits inside the field with breathing room — the
            // negative sign + decimal is easy to misread when cramped.
            className="h-7 w-20 rounded-md border border-white/10 bg-white/[0.04] px-2 text-xs text-foreground/90 tabular-nums disabled:opacity-50"
          />
          <span>%</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="What is min margin?"
                className="inline-flex items-center justify-center rounded-full p-0.5 text-muted-foreground hover:text-foreground/90 hover:bg-white/[0.06]"
              >
                <Info className="size-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-[300px] text-left leading-snug">
              Margin = (payout − retail) ÷ retail × 100. Any deal with a
              margin <span className="text-foreground">at or above</span>{' '}
              this number is eligible to be auto-queued. Default is
              <span className="text-foreground"> −3.5</span> (lets
              through deals where retail is at most 3.5% above payout —
              cashback typically closes that gap). Accepts decimals
              like <span className="text-foreground">-2.7</span> or{' '}
              <span className="text-foreground">0</span>. Set to{' '}
              <span className="text-foreground">-100</span> to disable.
            </TooltipContent>
          </Tooltip>
        </label>

        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>max per run</span>
          <input
            type="number"
            min={1}
            max={1000}
            value={cfg.maxPerTick}
            onChange={(e) =>
              setCfg((c) =>
                c ? { ...c, maxPerTick: parseInt(e.target.value, 10) || c.maxPerTick } : c,
              )
            }
            onBlur={(e) =>
              void update({ maxPerTick: clampMaxPerTick(e.target.value, cfg.maxPerTick) })
            }
            disabled={busy || !cfg.enabled}
            className="h-7 w-16 rounded-md border border-white/10 bg-white/[0.04] px-2 text-xs text-foreground/90 tabular-nums disabled:opacity-50"
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="What is max per run?"
                className="inline-flex items-center justify-center rounded-full p-0.5 text-muted-foreground hover:text-foreground/90 hover:bg-white/[0.06]"
              >
                <Info className="size-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-[300px] text-left leading-snug">
              Safety cap on how many deals one scheduled run will queue.
              Stops a sudden surge of new BG deals from queueing dozens
              of buys at once — e.g. if 80 deals appear after a quiet
              week, only this many get queued; the rest wait for the
              next run. On normal days where a few deals trickle in, the
              cap is never reached.
            </TooltipContent>
          </Tooltip>
        </label>

        {/* Status line on its own track — wraps below the controls on
            narrow widths but stays inline on a wide window. */}
        <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground tabular-nums">
          {!cfg.enabled ? (
            <span>Schedule off</span>
          ) : (
            <>
              <span>
                Last run:{' '}
                <span className="text-foreground/80">
                  {lastRunAt ? timeAgo(lastRunAt) : 'never'}
                </span>
              </span>
              <span aria-hidden>·</span>
              <span>
                Next:{' '}
                <span className="text-foreground/80">
                  {nextRunAt ? fmtUntil(nextRunAt - now) : '—'}
                </span>
              </span>
              {lastResult && (
                <>
                  <span aria-hidden>·</span>
                  <span>
                    Queued{' '}
                    <span className="text-emerald-300">{lastResult.queued}</span>
                    {lastResult.skipped > 0 && (
                      <>
                        , skipped{' '}
                        <span className="text-foreground/70">{lastResult.skipped}</span>
                      </>
                    )}
                    {lastResult.failed > 0 && (
                      <>
                        , failed{' '}
                        <span className="text-red-300">{lastResult.failed}</span>
                      </>
                    )}
                  </span>
                </>
              )}
              {lastResult?.error && (
                <>
                  <span aria-hidden>·</span>
                  <span className="text-red-300" title={lastResult.error}>
                    error
                  </span>
                </>
              )}
            </>
          )}
        </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

export function Deals() {
  const [deals, setDeals] = useState<AmazonDeal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<number>(Date.now());
  // Default: mirror the API's "newest first" order. Click a header to
  // override — second click on the same header flips direction.
  const [sortKey, setSortKey] = useState<SortKey>('discovered');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  // Ship-to-state filter. 'all' = no filter. Default to 'oregon'
  // because that's BG's tax-free warehouse state — the only deals we
  // can actually ship to by default.
  const [stateFilter, setStateFilter] = useState<string>('oregon');
  // Set of dealKeys the user has ticked. Used by the bulk action bar.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Bulk-action progress. While running: { done, total }. null = idle.
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);

  // Selection helpers ----------------------------------------------
  const toggleOne = (dealKey: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(dealKey);
      else next.delete(dealKey);
      return next;
    });
  };

  const runBulkAddToQueue = async (rows: AmazonDeal[]) => {
    if (rows.length === 0) return;
    setBulkProgress({ done: 0, total: rows.length });
    let queued = 0;
    let failed = 0;
    let lastError: string | null = null;
    for (let i = 0; i < rows.length; i++) {
      const d = rows[i]!;
      try {
        await window.autog.dealsTrigger(d.dealId);
        queued++;
      } catch (err) {
        failed++;
        lastError = err instanceof Error ? err.message : String(err);
      }
      setBulkProgress({ done: i + 1, total: rows.length });
    }
    setBulkProgress(null);
    setSelected(new Set());
    if (failed === 0) {
      toast.success(`Added ${queued} to AutoBuy queue`);
    } else if (queued === 0) {
      toast.error(`Queue failed for all ${failed}`, { description: lastError ?? undefined });
    } else {
      toast.warning(`Added ${queued}, ${failed} failed`, { description: lastError ?? undefined });
    }
  };

  const onHeaderClick = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      // First click on a new column: `asc` for product/expires feels
      // natural (A→Z, soonest-first), `desc` for numeric cols
      // (biggest price / margin / newest first) matches user intent.
      setSortDir(key === 'product' || key === 'expires' ? 'asc' : 'desc');
    }
  };

  // Union of every state seen across the current deal list → feeds
  // the filter dropdown. Sorted + uppercased for display. Recomputed
  // only when the deals array changes.
  const availableStates = useMemo(() => {
    const set = new Set<string>();
    for (const d of deals) for (const s of d.shipToStates) set.add(s.toLowerCase());
    return Array.from(set).sort();
  }, [deals]);

  const visibleDeals = useMemo(() => {
    const sf = stateFilter.toLowerCase();
    // Empty `shipToStates` means "ships anywhere" per BG's schema, so
    // those rows always pass the filter.
    const filtered =
      sf === 'all'
        ? deals
        : deals.filter(
            (d) =>
              d.shipToStates.length === 0 ||
              d.shipToStates.some((s) => s.toLowerCase() === sf),
          );
    const copy = [...filtered];
    const dir = sortDir === 'asc' ? 1 : -1;
    copy.sort((a, b) => {
      switch (sortKey) {
        case 'product':
          return dir * a.dealTitle.localeCompare(b.dealTitle);
        case 'pricing':
          return dir * cmpNullable(toNumber(a.price) ?? null, toNumber(b.price) ?? null);
        case 'margin':
          return dir * cmpNullable(marginPct(a), marginPct(b));
        case 'expires':
          return dir * cmpNullable(expiryMs(a.expiryDay), expiryMs(b.expiryDay));
        case 'discovered':
        default:
          return dir * a.discoveredAt.localeCompare(b.discoveredAt);
      }
    });
    return copy;
  }, [deals, sortKey, sortDir, stateFilter]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await window.autog.dealsList();
      setDeals(list);
      setRefreshedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">Deals</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {visibleDeals.length} of {deals.length} · refreshed {timeAgo(refreshedAt)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Ship to</span>
            <select
              value={stateFilter}
              onChange={(e) => setStateFilter(e.target.value)}
              className="h-8 rounded-md border border-white/10 bg-white/[0.04] px-2 text-xs text-foreground/90 hover:bg-white/[0.06] tabular-nums"
            >
              <option value="all">All states</option>
              {availableStates.map((s) => (
                <option key={s} value={s}>
                  {s.slice(0, 2).toUpperCase()} — {s.replace(/\b\w/g, (c) => c.toUpperCase())}
                </option>
              ))}
            </select>
          </label>
          <Button variant="secondary" onClick={() => void refresh()} size="sm" disabled={loading}>
            <RefreshCw className={cn('h-3 w-3 mr-1', loading && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive flex justify-between items-center">
          <span>{error}</span>
          <Button size="sm" variant="ghost" onClick={() => void refresh()}>
            Retry
          </Button>
        </div>
      )}

      <AutoEnqueueBar availableStates={availableStates} />

      <section className="glass flex flex-1 min-h-0 flex-col overflow-hidden">
        {(() => {
          // Selection summary → bulk-action bar. Deals not currently
          // visible (filtered out by ship-to-state) are kept selected
          // so switching filters doesn't silently drop them, but the
          // "N selected" count only reflects what's in view so the
          // user knows exactly what the bulk action will touch.
          const selectedInView = visibleDeals.filter((d) => selected.has(d.dealKey));
          if (selectedInView.length === 0) return null;
          const running = bulkProgress !== null;
          return (
            <div
              // Subtle accent wash so the bar is noticeable without
              // shouting. The CTA itself carries the clickable cue
              // (border + pointer + hover) — no need to over-tint the
              // surrounding strip.
              className="flex flex-wrap items-center gap-3 px-4 py-2 border-b border-white/[0.06] bg-white/[0.03]"
              role="toolbar"
            >
              <span className="text-xs mr-1 tabular-nums">
                {running ? (
                  <span className="text-foreground/80">
                    Queuing {bulkProgress.done}/{bulkProgress.total}…
                  </span>
                ) : (
                  <>
                    <span className="text-foreground font-medium">
                      {selectedInView.length}
                    </span>{' '}
                    <span className="text-muted-foreground">selected</span>
                  </>
                )}
              </span>
              <Button
                // Outline variant with a primary-tinted border + text —
                // clearly a button (visible border, hover-brighten,
                // pointer cursor) without the gradient "hero" look
                // that reads like a static badge. Arrow glyph + action
                // verb make the affordance unmistakable.
                variant="outline"
                size="sm"
                disabled={running}
                onClick={() => void runBulkAddToQueue(selectedInView)}
                className="border-primary/40 text-primary hover:border-primary/70 hover:bg-primary/10 hover:text-primary font-medium"
              >
                <Send className="h-3 w-3 mr-1" />
                Add to AutoBuy Queue
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={running}
                onClick={() => setSelected(new Set())}
              >
                Clear
              </Button>
            </div>
          );
        })()}
        <div className="flex-1 min-h-0 overflow-auto">
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[36px] pl-4 pr-1">
                  <Checkbox
                    aria-label="Select all visible deals"
                    checked={
                      visibleDeals.length > 0 &&
                      visibleDeals.every((d) => selected.has(d.dealKey))
                        ? true
                        : visibleDeals.some((d) => selected.has(d.dealKey))
                          ? 'indeterminate'
                          : false
                    }
                    onCheckedChange={(v) => {
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (v === true) {
                          for (const d of visibleDeals) next.add(d.dealKey);
                        } else {
                          for (const d of visibleDeals) next.delete(d.dealKey);
                        }
                        return next;
                      });
                    }}
                  />
                </TableHead>
                <SortableHead
                  className="w-auto px-4"
                  label="Product"
                  active={sortKey === 'product'}
                  dir={sortDir}
                  onClick={() => onHeaderClick('product')}
                />
                <SortableHead
                  className="w-[160px] pl-1.5 pr-4"
                  label="Pricing"
                  active={sortKey === 'pricing'}
                  dir={sortDir}
                  onClick={() => onHeaderClick('pricing')}
                />
                <SortableHead
                  className="w-[160px] px-4"
                  label="Margin"
                  active={sortKey === 'margin'}
                  dir={sortDir}
                  onClick={() => onHeaderClick('margin')}
                />
                <SortableHead
                  className="w-[130px] px-4"
                  label="Expires"
                  active={sortKey === 'expires'}
                  dir={sortDir}
                  onClick={() => onHeaderClick('expires')}
                />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && deals.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {!loading && deals.length === 0 && !error && (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                    No active deals right now. Hit Refresh if you're expecting some.
                  </TableCell>
                </TableRow>
              )}
              {!loading && deals.length > 0 && visibleDeals.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                    No deals ship to {stateFilter.toUpperCase()}.{' '}
                    <button
                      className="text-primary hover:underline"
                      onClick={() => setStateFilter('all')}
                    >
                      Clear filter
                    </button>
                  </TableCell>
                </TableRow>
              )}
              {visibleDeals.map((d) => {
                const price = toNumber(d.price);
                const oldPrice = toNumber(d.oldPrice);
                const margin =
                  price !== undefined
                    ? computeMargin(price, oldPrice)
                    : { indicator: '', label: '—', className: 'text-muted-foreground' };
                const isSelected = selected.has(d.dealKey);
                return (
                  <TableRow
                    key={d.dealKey}
                    className={cn('hover:bg-accent/30', isSelected && 'bg-accent/20')}
                  >
                    <TableCell className="pl-4 pr-1">
                      <Checkbox
                        aria-label={`Select ${d.dealTitle}`}
                        checked={isSelected}
                        onCheckedChange={(v) => toggleOne(d.dealKey, v === true)}
                      />
                    </TableCell>
                    <TableCell className="px-4">
                      <div className="flex items-center gap-3 min-w-0">
                        <DealImageTile imageUrl={d.imageUrl} />
                        <div className="min-w-0 flex-1">
                          <a
                            href={d.amazonLink}
                            onClick={(e) => openExternal(e, d.amazonLink)}
                            className="font-medium text-xs text-foreground hover:underline hover:decoration-primary"
                          >
                            {truncateAtWord(d.dealTitle, 70)}
                          </a>
                          <div className="flex items-center gap-2 mt-1 flex-wrap">
                            <a
                              href={`https://buyinggroup.com/deal/${d.dealKey}`}
                              onClick={(e) =>
                                openExternal(e, `https://buyinggroup.com/deal/${d.dealKey}`)
                              }
                              className="text-[10px] px-1.5 py-0.5 text-primary rounded hover:underline"
                            >
                              {d.dealId} ↗
                            </a>
                            <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 text-sky-300 rounded">
                              <MapPin className="size-2.5" />
                              {d.shipToStates.length > 0
                                ? d.shipToStates
                                    .map((s) => s.slice(0, 2).toUpperCase())
                                    .join(' | ')
                                : 'All states'}
                            </span>
                            {d.upc && (
                              <span className="text-[10px] px-1.5 py-0.5 text-muted-foreground font-mono tabular-nums">
                                UPC {d.upc}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="pl-1.5 pr-4">
                      <div className="flex flex-col gap-0.5 tabular-nums">
                        <div className="flex items-baseline gap-1.5">
                          <span className="text-[9px] uppercase tracking-wide text-muted-foreground w-10">
                            Payout
                          </span>
                          <span className="text-xs font-semibold text-emerald-300">
                            {price !== undefined ? fmtDollars(price) : '—'}
                          </span>
                        </div>
                        <div className="flex items-baseline gap-1.5">
                          <span className="text-[9px] uppercase tracking-wide text-muted-foreground w-10">
                            Retail
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            {oldPrice !== undefined ? fmtDollars(oldPrice) : '—'}
                          </span>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="px-4">
                      <span
                        className={cn(
                          'text-xs font-medium tabular-nums inline-flex items-center gap-1',
                          margin.className,
                        )}
                      >
                        {margin.indicator && (
                          <span className="text-[10px]">{margin.indicator}</span>
                        )}
                        {margin.label}
                      </span>
                    </TableCell>
                    <TableCell className="px-4 text-xs text-muted-foreground tabular-nums">
                      {d.expiryDay ?? '—'}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  );
}
