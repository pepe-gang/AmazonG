import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, MapPin, ChevronDown, ChevronUp, ChevronsUpDown, Send } from 'lucide-react';
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
 *  column so deals with the biggest rebate float to the top. Returns
 *  null when either side is missing so callers can send these rows to
 *  one end of the list regardless of sort direction. */
function marginPct(d: AmazonDeal): number | null {
  const price = toNumber(d.price);
  const oldPrice = toNumber(d.oldPrice);
  if (price === undefined || oldPrice === undefined || oldPrice === 0) return null;
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
              // Strong tint + inset top highlight makes the bar stand out
              // from the table header it's pinned above. Not so loud that
              // it competes with the glass surface — just enough to cue
              // "something here is actionable".
              className="flex flex-wrap items-center gap-3 px-4 py-2.5 border-b border-white/10 bg-accent/60 shadow-[inset_0_1px_0_0_rgb(255_255_255_/_0.04)]"
              role="toolbar"
            >
              <span className="text-xs font-medium text-foreground/90 mr-1 tabular-nums">
                {running ? (
                  <>Queuing {bulkProgress.done}/{bulkProgress.total}…</>
                ) : (
                  <>
                    <span className="text-foreground">{selectedInView.length}</span>{' '}
                    <span className="text-muted-foreground">selected</span>
                  </>
                )}
              </span>
              <Button
                // `default` variant uses the teal accent-gradient with a
                // glow shadow — the most emphatic affordance in the
                // shadcn button palette. Pair with a bigger size + bold
                // weight so it reads from across the screen.
                variant="default"
                size="default"
                disabled={running}
                onClick={() => void runBulkAddToQueue(selectedInView)}
                className="font-semibold"
              >
                <Send className="h-3.5 w-3.5 mr-1.5" />
                Add {selectedInView.length} to AutoBuy Queue
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
