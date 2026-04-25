import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { AmazonProfile, JobAttempt } from '../../shared/types.js';
import { computeProfit, retailPrice } from '../../shared/profit.js';
import { useSettings } from '../hooks/useSettings.js';
import { useConfirm } from './ConfirmDialog.js';
import { StatusBadge } from './StatusBadge.js';
import { formatDate, formatTime } from '../lib/format.js';
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
  STATUS_GROUP_LABEL,
  type JobColumnId,
  type SortDir,
  type SortKey,
  type StatusGroup,
} from '../lib/jobsColumns.js';

export function JobsTable({
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
  const [syncing, setSyncing] = useState(false);
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
    // Pin in-flight rows to the very top, independent of the user's
    // sort. Two buckets get pinned, in this order:
    //   1. `in_progress` — worker is actively driving Playwright now
    //   2. `queued`      — BG has the job, worker hasn't claimed yet
    // Partition is stable so the user's chosen sort still applies
    // within each group. The Active jobs panel above the table
    // surfaces the same set with phase pills + live elapsed timers.
    const inProgress: JobAttempt[] = [];
    const queued: JobAttempt[] = [];
    const rest: JobAttempt[] = [];
    for (const a of filtered) {
      if (a.status === 'in_progress') inProgress.push(a);
      else if (a.status === 'queued') queued.push(a);
      else rest.push(a);
    }
    return inProgress.concat(queued, rest);
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

  const runSync = async () => {
    // Reconcile orphan local Pending rows (worker crashed / app closed
    // mid-buy) against BG's authoritative purchase list. BG's copy is
    // treated as ground truth — any local pending with no match there
    // is flipped to failed so the table stops lying about what's
    // actually running.
    setSyncing(true);
    try {
      const r = await window.autog.jobsReconcileStuck();
      if (r.kind === 'offline') {
        toast.error('Sync failed', {
          description: 'Could not reach BetterBG. Check your connection and try again.',
        });
      } else if (r.marked === 0) {
        toast.success('Already in sync', {
          description: 'No stuck Pending rows — every local attempt matches a BG record.',
        });
      } else {
        toast.success(`Marked ${r.marked} stuck row${r.marked === 1 ? '' : 's'} as Failed`, {
          description: 'Orphan Pending attempts with no BG match were resolved.',
        });
      }
    } catch (err) {
      toast.error('Sync failed', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSyncing(false);
    }
  };

  return (
    // Outer is a plain flex column — the parent DashboardView section
    // already wraps this in `.glass` so we don't need another card
    // surface here. The inner blocks inherit that translucent shell.
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-white/[0.04]">
        <h2 className="text-base font-medium tracking-tight">Amazon Purchases</h2>
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void runSync()}
            disabled={syncing}
            title="Reconcile orphan local Pending rows against BetterBG. Any local Pending row with no matching BG purchase gets flipped to Failed."
          >
            {syncing ? 'Syncing…' : 'Sync with BG'}
          </Button>
          <span className="text-xs text-muted-foreground tabular-nums">
            {visible.length} of {attempts.length} row{attempts.length === 1 ? '' : 's'}
          </span>
        </div>
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
