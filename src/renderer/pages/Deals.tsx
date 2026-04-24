import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, MapPin, Copy, ExternalLink } from 'lucide-react';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { DealImageTile } from '@/components/deal-image-tile';
import { KebabTrigger } from '@/components/kebab-trigger';
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

export function Deals() {
  const [deals, setDeals] = useState<AmazonDeal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<number>(Date.now());

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
            {deals.length} live · refreshed {timeAgo(refreshedAt)}
          </p>
        </div>
        <Button variant="secondary" onClick={() => void refresh()} size="sm" disabled={loading}>
          <RefreshCw className={cn('h-3 w-3 mr-1', loading && 'animate-spin')} />
          Refresh
        </Button>
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
        <div className="flex-1 min-h-0 overflow-auto">
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-auto px-4">Product</TableHead>
                <TableHead className="w-[160px] pl-1.5 pr-4">Pricing</TableHead>
                <TableHead className="w-[160px] px-4">Margin</TableHead>
                <TableHead className="w-[130px] px-4">Expires</TableHead>
                <TableHead className="w-[80px] px-4 text-center">Actions</TableHead>
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
              {deals.map((d) => {
                const price = toNumber(d.price);
                const oldPrice = toNumber(d.oldPrice);
                const margin =
                  price !== undefined
                    ? computeMargin(price, oldPrice)
                    : { indicator: '', label: '—', className: 'text-muted-foreground' };
                return (
                  <TableRow key={d.dealKey} className="hover:bg-accent/30">
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
                    <TableCell className="px-4 text-center">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <KebabTrigger aria-label="Deal actions" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => void window.autog.openExternal(d.amazonLink)}>
                            <ExternalLink className="h-3 w-3 mr-2" /> Open on Amazon
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() =>
                              void window.autog.openExternal(
                                `https://buyinggroup.com/deal/${d.dealKey}`,
                              )
                            }
                          >
                            <ExternalLink className="h-3 w-3 mr-2" /> Open on BetterBG
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => {
                              void navigator.clipboard
                                .writeText(d.dealId)
                                .then(() => toast.success('Deal ID copied', { description: d.dealId }))
                                .catch((err) =>
                                  toast.error('Copy failed', {
                                    description: err instanceof Error ? err.message : String(err),
                                  }),
                                );
                            }}
                          >
                            <Copy className="h-3 w-3 mr-2" /> Copy deal ID
                          </DropdownMenuItem>
                          {d.upc && (
                            <DropdownMenuItem
                              onClick={() => {
                                void navigator.clipboard
                                  .writeText(d.upc!)
                                  .then(() => toast.success('UPC copied', { description: d.upc! }))
                                  .catch((err) =>
                                    toast.error('Copy failed', {
                                      description:
                                        err instanceof Error ? err.message : String(err),
                                    }),
                                  );
                              }}
                            >
                              <Copy className="h-3 w-3 mr-2" /> Copy UPC
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
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
