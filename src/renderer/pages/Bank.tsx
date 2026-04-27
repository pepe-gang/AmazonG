import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, RotateCw, X } from 'lucide-react';
import type {
  ChaseAccountSnapshot,
  ChaseProfile,
  ChaseRedeemEntry,
} from '../../shared/types.js';
import { AddChaseDialog } from '../components/AddChaseDialog.js';
import { useConfirm } from '../components/ConfirmDialog.js';
import { PlusIcon } from '../components/icons.js';
import { relDate } from '../lib/format.js';
import { sumPaymentAmounts } from '../../shared/chasePayments.js';

/**
 * "Redeem All Accounts" fans out one worker per eligible profile
 * with no concurrency cap — every Chase profile redeems in parallel.
 * Each worker owns its own Chrome window + persistent userDataDir,
 * so they don't conflict on disk. RAM and Chase's anti-bot scoring
 * are the practical limits; the user has explicitly opted into
 * "all browsers running."
 */

/* ============================================================
   Bank tab
   ============================================================
   Home for bank / credit-card account management. Today: Chase
   profile login. Future slices land here too — list cards, pay
   statement, redeem rewards. Kept separate from the Amazon
   Accounts tab because the threat model + data flow are
   different (real-money writes pending, entirely local-only,
   no BG sync).
*/
export function BankView() {
  return (
    <div className="flex flex-1 flex-col gap-3 p-5 min-h-0 overflow-auto">
      <div className="flex flex-col gap-3">
        <ChaseAccountsPanel />
      </div>
    </div>
  );
}

/* ============================================================
   Chase Accounts panel
   ============================================================
   Local-only Chase profile management. Each profile holds the
   user-given label + a Playwright user-data dir at
   userData/chase-profiles/{id}/. Login is hands-on: click
   "Login", a Chrome window opens to chase.com, the user
   authenticates manually (including any 2FA), and the panel
   detects success when the post-login card-summary URL is
   reached. Captures Chase's internal card-account id from the
   URL on the way through. No credentials are stored or synced
   anywhere.
*/
function ChaseAccountsPanel() {
  const [profiles, setProfiles] = useState<ChaseProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  // Per-profile transient state. busy ids = login in flight; row id
  // → 'pending' / 'ok' / 'error: …' so each card can render its own
  // banner without sharing a global error slot.
  const [loginState, setLoginState] = useState<
    Record<string, 'pending' | 'ok' | { error: string } | undefined>
  >({});
  const { confirm, dialog: confirmDialog } = useConfirm();

  const refresh = useCallback(async () => {
    try {
      const list = await window.autog.chaseList();
      setProfiles(list);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onAdd = async (
    label: string,
    credentials: { username: string; password: string },
  ) => {
    const list = await window.autog.chaseAdd(label, credentials);
    setProfiles(list);
    // Auto-kick the login flow against the new profile so the Chase
    // window opens and auto-fills the credentials we just saved.
    // The new profile is the last entry — Add appends.
    const newProfile = list[list.length - 1];
    if (newProfile) {
      void onLogin(newProfile.id);
    }
  };

  const onLogin = async (id: string) => {
    setLoginState((s) => ({ ...s, [id]: 'pending' }));
    try {
      const r = await window.autog.chaseLogin(id);
      if (r.ok) {
        setLoginState((s) => ({ ...s, [id]: 'ok' }));
        // Auto-clear success banner after a few seconds — the row's
        // status pill is the durable signal; the banner is just the
        // immediate feedback.
        setTimeout(() => {
          setLoginState((s) => {
            const { [id]: _, ...rest } = s;
            return rest;
          });
        }, 4000);
        await refresh();
      } else {
        setLoginState((s) => ({ ...s, [id]: { error: r.reason } }));
      }
    } catch (err) {
      setLoginState((s) => ({
        ...s,
        [id]: { error: err instanceof Error ? err.message : String(err) },
      }));
    }
  };

  const onAbort = async (id: string) => {
    await window.autog.chaseAbortLogin(id);
  };

  // Per-row redeem-all state. Distinct from loginState so the two
  // flows don't clobber each other's UI when a user clicks Login then
  // immediately Redeem All. 'pending' = automation in flight; success/
  // no-points/error states carry the message text we render below
  // the card. no_points is informational (neutral styling), error is
  // the only truly red banner.
  type RedeemUiState =
    | 'pending'
    | { ok: true; orderNumber: string; amount: string }
    | { kind: 'no_points'; reason: string }
    | { kind: 'error'; reason: string }
    | undefined;
  const [redeemState, setRedeemState] = useState<Record<string, RedeemUiState>>({});

  // Per-profile redeem-history list. Loaded eagerly when profiles
  // arrive (so the card's right-side "LAST REDEEMED" cell can render
  // without waiting on a click) and re-fetched after every successful
  // redemption. `open` controls whether the inline expanded list under
  // the action row is visible.
  const [historyState, setHistoryState] = useState<
    Record<string, { open: boolean; entries: ChaseRedeemEntry[]; loading: boolean }>
  >({});

  const refreshHistoryFor = useCallback(async (profileId: string) => {
    try {
      const list = await window.autog.chaseRedeemHistory(profileId);
      setHistoryState((h) => {
        const cur = h[profileId];
        return {
          ...h,
          [profileId]: {
            open: cur?.open ?? false,
            entries: list,
            loading: false,
          },
        };
      });
    } catch {
      // Best-effort. On failure leave whatever we had cached so the
      // last-redeem cell doesn't suddenly blank out.
    }
  }, []);

  // Eagerly populate history once profiles arrive. Re-runs whenever
  // the profile list itself changes (add / remove). For profiles
  // without a captured cardAccountId the list will just be empty.
  useEffect(() => {
    for (const p of profiles) {
      void refreshHistoryFor(p.id);
    }
  }, [profiles, refreshHistoryFor]);

  // Per-profile card snapshot (rewards points + current credit
  // balance). Loaded from disk on mount; refreshed once per profile
  // by spawning a Chase window if no cache exists yet. snapshotPending
  // tracks the active fetch so we can show a loading state on the
  // card without blocking other interactions.
  const [snapshotState, setSnapshotState] = useState<
    Record<string, ChaseAccountSnapshot | null | undefined>
  >({});
  const [snapshotPending, setSnapshotPending] = useState<Record<string, boolean>>({});

  // Per-profile snapshot-fetch error message. Cleared on a
  // successful refresh; surfaced inline beneath the card so the
  // user sees *why* the numbers didn't update (most often:
  // expired session). Without this the fetch fails silently and
  // the card just stops refreshing without explanation.
  const [snapshotError, setSnapshotError] = useState<Record<string, string | undefined>>({});

  // Per-profile "pay window is currently open" flag. Set when the
  // user clicks Pay my Balance and the main process opens the Chase
  // window; cleared either when the auto-close watcher fires
  // evtChasePaySuccess (payment completed) or when the user clicks
  // "Close browser" (cancel). Drives the per-card button swap from
  // "Pay my Balance" → "Close browser" so the user can force-quit
  // the Chase window from inside AmazonG without having to find
  // and click the OS X (close) button on the Chrome window.
  const [payingProfiles, setPayingProfiles] = useState<Set<string>>(new Set());
  const markPaying = (id: string, on: boolean) => {
    setPayingProfiles((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const refreshSnapshotFor = useCallback(async (profileId: string) => {
    setSnapshotPending((s) => ({ ...s, [profileId]: true }));
    setSnapshotError((s) => {
      const { [profileId]: _, ...rest } = s;
      return rest;
    });
    try {
      const r = await window.autog.chaseSnapshotRefresh(profileId);
      if (r.ok) {
        setSnapshotState((s) => ({ ...s, [profileId]: r.snapshot }));
      } else {
        setSnapshotError((s) => ({ ...s, [profileId]: r.reason }));
        // Server-side session-expired path also flips the
        // profile's loggedIn flag (see chaseSnapshotRefresh
        // handler in main). Re-fetch the profile list so the
        // card's "Logged in" pill flips to "Not logged in" and
        // the Login button reappears.
        if (/session expired/i.test(r.reason)) {
          void refresh();
        }
      }
    } catch (err) {
      setSnapshotError((s) => ({
        ...s,
        [profileId]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setSnapshotPending((s) => {
        const { [profileId]: _, ...rest } = s;
        return rest;
      });
    }
  }, [refresh]);

  // Listen for the pay-window auto-close event. When the user
  // finishes a payment, the main process detects Chase's
  // "You've scheduled a …" confirmation and emits this event so
  // we can refresh the snapshot — pending charges shift down by
  // the paid amount, in-process payments gain a new entry.
  useEffect(() => {
    const off = window.autog.onChasePaySuccess((profileId) => {
      // Window auto-closes itself after the watcher's read window;
      // mirror that on the renderer so the card flips back from
      // "Close browser" → "Pay my Balance" without a stale button.
      markPaying(profileId, false);
      void refreshSnapshotFor(profileId);
    });
    return off;
  }, [refreshSnapshotFor]);

  // Disk-cache load only. Auto-fetch on Bank tab entry was removed —
  // every visit was kicking off N visible Chase windows, which the
  // user found intrusive. The user now triggers fetches explicitly:
  // either per-card (the refresh icon on the card) or all at once
  // via the "Fetch all" button in the panel header.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const fromDisk: Record<string, ChaseAccountSnapshot | null> = {};
      for (const p of profiles) {
        if (cancelled) return;
        try {
          fromDisk[p.id] = await window.autog.chaseSnapshotGet(p.id);
        } catch {
          fromDisk[p.id] = null;
        }
      }
      if (cancelled) return;
      // Existing in-memory entries (e.g. from a redemption that
      // already triggered a refresh) win over disk.
      setSnapshotState((s) => ({ ...fromDisk, ...s }));
    })();
    return () => {
      cancelled = true;
    };
  }, [profiles]);

  // "Fetch all" handler: throttled snapshot refresh for every profile
  // with a captured card id. We can't fan out fully — Chase's anti-bot
  // rate-limits / stalls dashboard requests when N parallel sessions
  // hit secure.chase.com simultaneously, which makes the recon-bar
  // selector wait silently time out and leaves credit balance blank
  // on most cards. Worker-pool of 2 gives us some throughput without
  // tripping the rate limit. (Bulk redeem deliberately fans out fully
  // because the user opted into "all windows at once" there.)
  const FETCH_ALL_CONCURRENCY = 2;
  const onFetchAll = () => {
    const eligible = profiles.filter((p) => !!p.cardAccountId);
    if (eligible.length === 0) return;
    const queue = [...eligible];
    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        const p = queue.shift();
        if (!p) return;
        await refreshSnapshotFor(p.id);
      }
    };
    const workerCount = Math.min(FETCH_ALL_CONCURRENCY, eligible.length);
    void Promise.all(Array.from({ length: workerCount }, () => worker()));
  };
  const anySnapshotPending = Object.values(snapshotPending).some(Boolean);

  // Panel-level state for the "Redeem All Accounts" bulk action. While
  // bulkInFlight is true, every per-card action is locked to prevent
  // the user from racing the workers.
  // Set of profile ids currently being redeemed by the bulk loop.
  // Multiple ids at once = parallel workers (one per profile).
  // Empty + bulkInFlight=false = idle. The header button + per-card
  // lock derive from this.
  const [bulkRunningIds, setBulkRunningIds] = useState<Set<string>>(new Set());
  const [bulkInFlight, setBulkInFlight] = useState(false);
  // Bulk summary keeps the *labels* (not just counts) of each
  // outcome bucket so the user can act on the failed rows without
  // scrolling through every card. Empty arrays are fine for a
  // run that completed but had no failures, etc.
  const [bulkSummary, setBulkSummary] = useState<{
    total: number;
    succeeded: { id: string; label: string; amount: string }[];
    skipped: { id: string; label: string }[];
    failed: { id: string; label: string; reason: string }[];
    /** True when the user requested a stop and the loop bailed out
     *  before processing every eligible profile. The summary panel
     *  swaps "finished" for "stopped" so the user knows the missing
     *  rows aren't a bug. */
    cancelled: boolean;
  } | null>(null);
  // Cancellation flag — held in a ref because the bulk loop's body
  // is a closure, and a state-based flag would read stale through
  // each iteration. The mirrored state is just for the UI ("Stopping…"
  // label flip); the loop reads the ref. Both are set in onCancelBulk
  // and reset at the start of every bulk run.
  const bulkCancelRef = useRef(false);
  const [bulkCancelRequested, setBulkCancelRequested] = useState(false);

  // Drive a single Chase profile through the automated redemption
  // flow and reflect the outcome into per-row state. Shared between
  // the per-card "Redeem All" button and the bulk "Redeem All Accounts"
  // sweep below — both want the same end state, just different
  // surrounding UX (confirm dialog vs. sequential progress).
  type RedeemOutcome =
    | { ok: true; orderNumber: string; amount: string }
    | { kind: 'no_points'; reason: string }
    | { kind: 'error'; reason: string };

  const runRedeemForProfile = useCallback(
    async (profileId: string): Promise<RedeemOutcome> => {
      setRedeemState((s) => ({ ...s, [profileId]: 'pending' }));
      try {
        const r = await window.autog.chaseRedeemAll(profileId);
        if (r.ok) {
          setRedeemState((s) => ({
            ...s,
            [profileId]: { ok: true, orderNumber: r.orderNumber, amount: r.amount },
          }));
          // Refresh history immediately so the footer's "Last
          // redeemed" line picks up the new row, and refresh the
          // snapshot so the points balance drops to reflect the
          // just-redeemed amount.
          void refreshHistoryFor(profileId);
          void refreshSnapshotFor(profileId);
          return { ok: true, orderNumber: r.orderNumber, amount: r.amount };
        }
        setRedeemState((s) => ({
          ...s,
          [profileId]: { kind: r.kind, reason: r.reason },
        }));
        // Same recovery path as the snapshot flow: when Chase
        // tells us the session is gone, the main process flipped
        // loggedIn=false; pull the fresh profile list so the
        // Login button reappears.
        if (r.kind === 'error' && /session expired/i.test(r.reason)) {
          void refresh();
        }
        return { kind: r.kind, reason: r.reason };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        setRedeemState((s) => ({
          ...s,
          [profileId]: { kind: 'error', reason },
        }));
        return { kind: 'error', reason };
      }
    },
    [refresh, refreshHistoryFor, refreshSnapshotFor],
  );

  // No confirm dialog — the user opted out. The button itself is
  // the affirmation, and the in-flight Chase window remains visible
  // so the user can see + abort if needed.
  const onRedeemAll = (p: ChaseProfile) => {
    void runRedeemForProfile(p.id);
  };

  // Pay my Balance — just opens a Chase window pointed at the
  // pay-card flyout. AmazonG doesn't auto-fill or submit; the user
  // does the entire pay flow themselves in the visible window.
  // Errors (auth, profile-state) bubble back into the per-card
  // banner via redeemState (we reuse the slot since both flows
  // surface "couldn't open Chase" the same way).
  const onPayBalance = async (p: ChaseProfile) => {
    try {
      const r = await window.autog.chasePayBalance(p.id);
      if (r.ok) {
        markPaying(p.id, true);
        return;
      }
      setRedeemState((s) => ({
        ...s,
        [p.id]: { kind: 'error', reason: r.reason },
      }));
      if (/session expired/i.test(r.reason)) {
        void refresh();
      }
    } catch (err) {
      setRedeemState((s) => ({
        ...s,
        [p.id]: {
          kind: 'error',
          reason: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  };

  // "Close browser" button on the card while a pay window is open.
  // Force-quits the Chase Chrome window via session.close() in main.
  // Optimistically flips the renderer flag back so the card returns
  // to "Pay my Balance" immediately — even if the IPC settle is
  // slow, the user has already expressed intent to bail out.
  const onPayCancel = async (id: string) => {
    markPaying(id, false);
    try {
      await window.autog.chasePayCancel(id);
    } catch {
      // No-op — the main handler is best-effort and swallows its
      // own errors. If the close failed for any reason, the worst
      // case is a stranded Chrome window the user can close manually.
    }
  };

  // "Redeem All Accounts" — run runRedeemForProfile sequentially for
  // every profile that has a captured cardAccountId. Sequential, not
  // parallel: each profile owns its own Chrome userDataDir, but Chase
  // is touchier about parallel sessions (anti-bot) and 2FA challenges
  // would be ambiguous if multiple windows were asking at once.
  const onRedeemAllAccounts = () => {
    const eligible = profiles.filter((p) => p.cardAccountId);
    if (eligible.length === 0) return;
    confirm({
      title: `Redeem all points on ${eligible.length} account${
        eligible.length === 1 ? '' : 's'
      }?`,
      message:
        "AmazonG will open each Chase profile's signed-in window in turn, convert every available rewards point to a statement credit on the same card, and move on to the next. Each redemption is final — Chase doesn't reverse statement-credit redemptions. Credits post within 3 business days.",
      confirmLabel: 'Redeem all accounts',
      onConfirm: async () => {
        setBulkSummary(null);
        bulkCancelRef.current = false;
        setBulkCancelRequested(false);
        setBulkInFlight(true);
        setBulkRunningIds(new Set());

        const succeeded: { id: string; label: string; amount: string }[] = [];
        const skipped: { id: string; label: string }[] = [];
        const failed: { id: string; label: string; reason: string }[] = [];

        // Worker-pool pattern: spin up one worker per eligible
        // profile (no concurrency cap), each pulls from the shared
        // queue until empty. With one worker per item the queue
        // empties in one pass — pattern stays for cancel-checking
        // and consistency with the throttled flows.
        // JS is single-threaded so queue.shift() and the outcome
        // pushes are atomic — no need for a mutex. Each worker
        // checks the cancel flag before starting a new task; we
        // can't safely interrupt an in-flight redemption (Chase
        // already received the request and the credit will post
        // regardless), but we can refuse to start the next one.
        const queue = [...eligible];
        const worker = async (): Promise<void> => {
          while (queue.length > 0) {
            if (bulkCancelRef.current) return;
            const p = queue.shift();
            if (!p) return;
            setBulkRunningIds((s) => {
              const next = new Set(s);
              next.add(p.id);
              return next;
            });
            try {
              const r = await runRedeemForProfile(p.id);
              if ('ok' in r) {
                succeeded.push({ id: p.id, label: p.label, amount: r.amount });
              } else if (r.kind === 'no_points') {
                skipped.push({ id: p.id, label: p.label });
              } else {
                failed.push({ id: p.id, label: p.label, reason: r.reason });
              }
            } finally {
              setBulkRunningIds((s) => {
                const next = new Set(s);
                next.delete(p.id);
                return next;
              });
            }
          }
        };
        // No concurrency cap — fan out one worker per profile so
        // every Chrome window opens at once.
        await Promise.all(Array.from({ length: eligible.length }, () => worker()));

        const wasCancelled = bulkCancelRef.current;
        bulkCancelRef.current = false;
        setBulkCancelRequested(false);
        setBulkRunningIds(new Set());
        setBulkInFlight(false);
        setBulkSummary({
          total: eligible.length,
          succeeded,
          skipped,
          failed,
          cancelled: wasCancelled,
        });
      },
    });
  };

  const onCancelBulk = () => {
    bulkCancelRef.current = true;
    setBulkCancelRequested(true);
  };

  const onRemove = (p: ChaseProfile) => {
    confirm({
      title: `Remove "${p.label}"?`,
      message:
        "This deletes the Chase profile and clears its Chrome session data on this device. Cookies, cached logins — gone. You can add it again, but you'll have to log in fresh.",
      confirmLabel: 'Remove',
      danger: true,
      onConfirm: async () => {
        const list = await window.autog.chaseRemove(p.id);
        setProfiles(list);
      },
    });
  };

  return (
    <div className="prefix-panel">
      <div className="prefix-head">
        <div className="min-w-0">
          <div className="prefix-title">Chase Accounts</div>
          <div className="prefix-sub">
            Local-only Chase logins. Click <b>Login</b> on a profile to open
            a Chrome window pointed at chase.com — sign in by hand,
            including any 2FA, then click into the credit card you want
            to track. The window auto-closes once the card&apos;s summary
            page loads. Cookies persist on this device; nothing is
            uploaded to BetterBG.
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {profiles.some((p) => p.cardAccountId) && (
            <button
              type="button"
              className="primary-action"
              onClick={onFetchAll}
              disabled={bulkInFlight || anySnapshotPending}
              title="Open every linked Chase profile in turn and refresh its rewards / balance / pending-charges snapshot"
            >
              {anySnapshotPending ? 'Fetching…' : 'Fetch all'}
            </button>
          )}
          {profiles.some((p) => p.cardAccountId) &&
            (bulkInFlight ? (
              <button
                type="button"
                className="ghost-btn"
                onClick={onCancelBulk}
                disabled={bulkCancelRequested}
                title="Stop the bulk run after the in-flight redemption completes"
              >
                {bulkCancelRequested ? 'Stopping…' : 'Stop after current'}
              </button>
            ) : (
              <button
                type="button"
                className="primary-action danger"
                onClick={onRedeemAllAccounts}
                title="Run Redeem All across every linked Chase account in parallel"
              >
                Redeem All Accounts
              </button>
            ))}
          <button
            type="button"
            className="ghost-btn"
            onClick={() => setAdding((v) => !v)}
            disabled={bulkInFlight}
          >
            <PlusIcon />
            <span>Add Chase</span>
          </button>
        </div>
      </div>
      {bulkSummary && (
        <div className="mt-3 rounded-md border border-white/10 bg-white/[0.02] p-3 text-[11px] flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-2">
            <div className="font-semibold text-white/85">
              {bulkSummary.cancelled ? 'Bulk run stopped' : 'Bulk run finished'}
              &nbsp;&middot;&nbsp;{bulkSummary.succeeded.length} of{' '}
              {bulkSummary.total} redeemed
              {bulkSummary.cancelled &&
              bulkSummary.succeeded.length +
                bulkSummary.skipped.length +
                bulkSummary.failed.length <
                bulkSummary.total
                ? ` (${
                    bulkSummary.total -
                    (bulkSummary.succeeded.length +
                      bulkSummary.skipped.length +
                      bulkSummary.failed.length)
                  } not started)`
                : ''}
            </div>
            <button
              type="button"
              onClick={() => setBulkSummary(null)}
              className="text-[10px] text-muted-foreground hover:text-white/80 underline-offset-2 hover:underline"
            >
              dismiss
            </button>
          </div>
          {bulkSummary.succeeded.length > 0 && (
            <BulkOutcomeList
              tone="emerald"
              heading={`Redeemed (${bulkSummary.succeeded.length})`}
              rows={bulkSummary.succeeded.map((r) => ({
                id: r.id,
                label: r.label,
                detail: r.amount || 'amount unknown',
              }))}
            />
          )}
          {bulkSummary.skipped.length > 0 && (
            <BulkOutcomeList
              tone="amber"
              heading={`Skipped — 0 points (${bulkSummary.skipped.length})`}
              rows={bulkSummary.skipped.map((r) => ({
                id: r.id,
                label: r.label,
                detail: '',
              }))}
            />
          )}
          {bulkSummary.failed.length > 0 && (
            <BulkOutcomeList
              tone="red"
              heading={`Failed (${bulkSummary.failed.length})`}
              rows={bulkSummary.failed.map((r) => ({
                id: r.id,
                label: r.label,
                detail: r.reason,
              }))}
            />
          )}
        </div>
      )}

      <AddChaseDialog
        open={adding}
        onClose={() => setAdding(false)}
        onSubmit={onAdd}
      />

      {/* Card grid. Each profile renders as a credit-card-styled
          block once it has a captured cardAccountId; pre-login
          profiles get a placeholder version of the same shape so the
          layout doesn't shift around once they finish signing in. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3 items-stretch">
        {!loading && profiles.length === 0 && !adding && (
          <div className="text-xs text-muted-foreground italic col-span-full">
            No Chase accounts yet. Click <b>Add Chase</b> to set one up.
          </div>
        )}
        {profiles.map((p) => {
          const state = loginState[p.id];
          const isPending = state === 'pending';
          const justLoggedIn = state === 'ok';
          const errMsg =
            state && typeof state === 'object' && 'error' in state ? state.error : null;
          const redeem = redeemState[p.id];
          const history = historyState[p.id];
          // Lock per-card actions while a bulk sweep is running on
          // any profile — racing the workers could collide with the
          // userDataDir of a profile they're already operating on.
          const bulkLocked = bulkInFlight;
          return (
            <ChaseBankCard
              key={p.id}
              profile={p}
              isPending={isPending}
              justLoggedIn={justLoggedIn}
              errMsg={errMsg}
              redeem={redeem}
              history={history}
              snapshot={snapshotState[p.id] ?? null}
              snapshotLoading={!!snapshotPending[p.id]}
              snapshotError={snapshotError[p.id] ?? null}
              lastRedeemed={history?.entries[0] ?? null}
              bulkLocked={bulkLocked}
              isBulkActive={bulkRunningIds.has(p.id)}
              onLogin={() => void onLogin(p.id)}
              onAbort={() => void onAbort(p.id)}
              onRemove={() => onRemove(p)}
              onRedeemAll={() => onRedeemAll(p)}
              onPayBalance={() => void onPayBalance(p)}
              isPaying={payingProfiles.has(p.id)}
              onPayCancel={() => void onPayCancel(p.id)}
              onRefreshSnapshot={() => void refreshSnapshotFor(p.id)}
            />
          );
        })}
      </div>
      {confirmDialog}
    </div>
  );
}

/**
 * Credit-card-shaped tile. The card itself is the focal point — bank
 * brand top-left, live status pills top-right, then the two numbers
 * the user actually cares about (current credit balance + rewards
 * points balance) rendered big and centered. A subtle footer carries
 * the supporting metadata (account id, last sign-in, last automated
 * redemption). Action buttons live below the card so the card stays
 * a clean visual analogue of the physical card.
 */
function ChaseBankCard({
  profile: p,
  isPending,
  justLoggedIn,
  errMsg,
  redeem,
  snapshot,
  snapshotLoading,
  snapshotError,
  lastRedeemed,
  bulkLocked,
  isBulkActive,
  onLogin,
  onAbort,
  onRemove,
  onRedeemAll,
  onPayBalance,
  isPaying,
  onPayCancel,
  onRefreshSnapshot,
}: {
  profile: ChaseProfile;
  isPending: boolean;
  justLoggedIn: boolean;
  errMsg: string | null;
  redeem:
    | 'pending'
    | { ok: true; orderNumber: string; amount: string }
    | { kind: 'no_points'; reason: string }
    | { kind: 'error'; reason: string }
    | undefined;
  snapshot: ChaseAccountSnapshot | null;
  snapshotLoading: boolean;
  snapshotError: string | null;
  lastRedeemed: ChaseRedeemEntry | null;
  bulkLocked: boolean;
  isBulkActive: boolean;
  onLogin: () => void;
  onAbort: () => void;
  onRemove: () => void;
  onRedeemAll: () => void;
  onPayBalance: () => void;
  isPaying: boolean;
  onPayCancel: () => void;
  onRefreshSnapshot: () => void;
}) {
  const isRedeeming = redeem === 'pending';
  const redeemSuccess =
    redeem && typeof redeem === 'object' && 'ok' in redeem && redeem.ok
      ? redeem
      : null;
  const redeemNoPoints =
    redeem && typeof redeem === 'object' && 'kind' in redeem && redeem.kind === 'no_points'
      ? redeem.reason
      : null;
  const redeemError =
    redeem && typeof redeem === 'object' && 'kind' in redeem && redeem.kind === 'error'
      ? redeem.reason
      : null;

  // Color-code the credit balance: a leading "-$" means Chase owes
  // the user money (credit on the card → green, neutral-good); a
  // bare "$" means the user owes Chase (statement balance →
  // amber, action implied). Empty falls back to muted.
  const balance = snapshot?.creditBalance ?? '';
  const balanceClass = balance.startsWith('-$')
    ? 'text-emerald-300'
    : balance.startsWith('$')
      ? 'text-amber-200'
      : 'text-white/40';

  return (
    <div className="flex flex-col gap-2 h-full">
      <div
        className={
          'relative rounded-xl p-5 min-h-[200px] flex-1 flex flex-col justify-between overflow-hidden border transition-shadow ' +
          (p.loggedIn
            ? 'border-blue-400/30 bg-gradient-to-br from-blue-900/40 via-indigo-900/40 to-blue-950/60 shadow-[0_4px_20px_-6px_rgba(59,130,246,0.35)]'
            : 'border-white/[0.08] bg-gradient-to-br from-zinc-900/70 to-zinc-950/70') +
          // While a fetch is in flight, glow the card with a pulsing
          // blue ring so the loading state is impossible to miss
          // even from across the room. Animate-pulse on the ring
          // matches the spinner's cadence in the corner pill.
          (snapshotLoading
            ? ' ring-2 ring-blue-400/60 ring-offset-2 ring-offset-background animate-pulse'
            : '')
        }
      >
        {/* Decorative gloss arc — the kind of light band that runs
            across real Chase cards. Pure CSS, no asset. */}
        <div
          aria-hidden
          className="absolute -top-16 -right-16 w-48 h-48 rounded-full bg-white/[0.05] blur-3xl pointer-events-none"
        />

        {/* Header: brand left, status + remove right. */}
        <div className="flex items-start justify-between gap-2 relative">
          <div>
            <div className="text-xs uppercase tracking-[0.2em] text-blue-200/80 font-semibold">
              Chase
            </div>
            <div
              className="text-sm font-medium text-white/90 truncate mt-0.5"
              title={p.label}
            >
              {p.label}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {snapshotLoading && (
              <span
                className="text-[11px] px-2 py-1 rounded-full border border-blue-300/60 bg-blue-500/30 text-blue-50 font-medium inline-flex items-center gap-1.5 shadow-[0_0_8px_-2px_rgba(96,165,250,0.6)]"
                aria-live="polite"
              >
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                Fetching&hellip;
              </span>
            )}
            {p.loggedIn ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
                Logged in
              </span>
            ) : (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-zinc-500/30 bg-zinc-500/10 text-zinc-300">
                Not logged in
              </span>
            )}
            {/* Manual refresh — re-runs the snapshot fetch for this
                one card. Hidden until the card has a captured
                cardAccountId since there's nothing to refresh
                otherwise. Disabled while a fetch is already in
                flight (the top-right pill already signals that). */}
            {p.cardAccountId && (
              <button
                type="button"
                onClick={onRefreshSnapshot}
                disabled={isPending || snapshotLoading}
                title="Re-fetch this card's points balance, credit balance, and in-process payments"
                aria-label="Refresh card snapshot"
                className="-mt-1 inline-flex items-center justify-center rounded-md p-1 text-white/50 hover:text-blue-200 hover:bg-blue-500/10 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-white/50 transition-colors"
              >
                <RotateCw className="size-3.5" />
              </button>
            )}
            <button
              type="button"
              onClick={onRemove}
              disabled={isPending || snapshotLoading}
              title="Remove this profile + clear its local Chrome session data"
              aria-label="Remove profile"
              className="-mr-1 -mt-1 inline-flex items-center justify-center rounded-md p-1 text-white/50 hover:text-red-300 hover:bg-red-500/10 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-white/50 transition-colors"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>

        {/* Hero row: balance + points side by side. The two
            numbers the user opens this tab for — large, bold,
            and immediately legible. Dim while a refresh is
            re-reading them so stale values are visible but
            visibly stale. */}
        <div
          className={
            'relative grid grid-cols-2 gap-4 my-2 transition-opacity ' +
            (snapshotLoading && snapshot ? 'opacity-50' : '')
          }
        >
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-blue-200/60">
              Current balance
            </div>
            <div
              className={
                'text-2xl font-mono tabular-nums font-semibold truncate ' + balanceClass
              }
              title={balance || 'Not yet fetched'}
            >
              {balance || (snapshotLoading ? '…' : '—')}
            </div>
          </div>
          <div className="min-w-0 text-right">
            <div className="text-[10px] uppercase tracking-wider text-blue-200/60">
              Rewards
            </div>
            <div
              className="text-2xl font-mono tabular-nums font-semibold text-white/95 truncate"
              title={snapshot?.pointsBalance || 'Not yet fetched'}
            >
              {snapshot?.pointsBalance || (snapshotLoading ? '…' : '—')}
            </div>
          </div>
        </div>

        {/* Staleness indicator. Tells the user how old the displayed
            numbers are so they can mistrust them when they're old.
            Amber once the cache is older than 24h — at that point
            in-process payments may have settled, balances may have
            shifted, and a refresh is warranted. Hidden until we
            have any snapshot at all (the hero row's "—" already
            handles the no-data case). */}
        {snapshot?.fetchedAt && (
          <div
            className={
              'relative text-[10px] tracking-wide ' +
              (Date.now() - new Date(snapshot.fetchedAt).getTime() > 24 * 60 * 60_000
                ? 'text-amber-200/80'
                : 'text-blue-200/50')
            }
            title={`Snapshot captured ${new Date(snapshot.fetchedAt).toLocaleString()}`}
          >
            Updated {relDate(snapshot.fetchedAt)}
          </div>
        )}

        {/* Money-in-flight section — always rendered (even when
            both rows are zero) so cards stay the same height across
            the grid and the section doesn't pop in/out as snapshots
            update. Different tones distinguish the direction:
              Pending charges  → amber/orange (debt going UP)
              In-process pays  → sky/teal     (paying it DOWN)
            Both are invisible in the "Current balance" hero number
            above, which is why we pull them out here. */}
        {snapshot && (
          <div className="relative my-1 pt-2 border-t border-white/10 flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-2">
              <div
                className="text-[10px] uppercase tracking-wider text-amber-300/90"
                title="Charges Chase has authorized but not yet finalized into your statement balance — these will push your balance UP when they post"
              >
                Pending charges
              </div>
              <div className="text-[11px] font-mono tabular-nums text-amber-200 font-semibold">
                {snapshot.pendingCharges || '$0.00'}
              </div>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <div
                className="text-[10px] uppercase tracking-wider text-sky-300/90"
                title="Payments you've scheduled — these will push your balance DOWN when they post"
              >
                {(snapshot.inProcessPayments?.length ?? 0)} payment
                {(snapshot.inProcessPayments?.length ?? 0) === 1 ? '' : 's'} in process
              </div>
              <div
                className="text-[11px] font-mono tabular-nums text-sky-200 font-semibold"
                title="Sum of every in-process payment"
              >
                {snapshot.inProcessPayments && snapshot.inProcessPayments.length > 0
                  ? sumPaymentAmounts(snapshot.inProcessPayments)
                  : '$0.00'}
              </div>
            </div>
          </div>
        )}

        {/* Footer: account id + last sign-in on the left, last
            automated redemption on the right (when there is one).
            Single low-emphasis line so the card stays anchored to
            its hero numbers. */}
        <div className="relative flex items-end justify-between gap-3 text-[10px] text-blue-200/60">
          <div className="min-w-0 flex-1">
            <div className="font-mono tabular-nums truncate">
              {p.cardAccountId ? `ID ${p.cardAccountId}` : 'No card linked yet'}
            </div>
            <div className="mt-0.5">
              {p.lastLoginAt
                ? `Last sign-in ${relDate(p.lastLoginAt)}`
                : 'Sign in to capture card details'}
            </div>
          </div>
          {lastRedeemed && (
            <div className="text-right shrink-0">
              <div className="font-mono tabular-nums text-emerald-300/90">
                {lastRedeemed.amount || '—'}
              </div>
              <div>Last redeemed {relDate(lastRedeemed.ts)}</div>
            </div>
          )}
        </div>
      </div>

      {/* Status banners — same family as before, condensed. Stay
          beneath the card so the card visual is uncluttered. */}
      {isPending && (
        <div className="text-[11px] text-blue-300">
          Browser open — sign in, then <b>click into the credit card</b> to
          track. The card auto-marks once the summary page loads. Click <b>Cancel</b> to abort.
        </div>
      )}
      {justLoggedIn && (
        <div className="text-[11px] text-emerald-300">✓ Logged in successfully.</div>
      )}
      {errMsg && <div className="text-[11px] text-red-300 break-all">{errMsg}</div>}
      {isRedeeming && (
        <div className="text-[11px] text-blue-300">
          {isBulkActive ? 'Bulk run · ' : ''}Redeeming all points to statement
          credit&hellip; window will close once Chase confirms.
        </div>
      )}
      {redeemSuccess && (
        <div className="text-[11px] text-emerald-300 break-all">
          ✓ Redeemed
          {redeemSuccess.amount ? (
            <> <span className="font-semibold">{redeemSuccess.amount}</span></>
          ) : (
            ''
          )}{' '}
          as statement credit
          {redeemSuccess.orderNumber ? ` (order ${redeemSuccess.orderNumber})` : ''}
          . Posts within 3 business days.
        </div>
      )}
      {redeemNoPoints && (
        <div className="text-[11px] text-amber-300/90 break-all">{redeemNoPoints}</div>
      )}
      {redeemError && (
        <div className="text-[11px] text-red-300 break-all">{redeemError}</div>
      )}
      {snapshotError && (
        <div className="text-[11px] text-red-300 break-all">
          Couldn&apos;t fetch balance: {snapshotError}
        </div>
      )}

      {/* Action row. Keep the surface small: Pay-balance is the
          primary call-to-action (when there's a balance to pay),
          Redeem Rewards is the second-most-common, Login appears
          only when the profile is signed out. */}
      <div className="flex items-center gap-2 flex-wrap">
        {isPending ? (
          <button type="button" className="ghost-btn" onClick={onAbort}>
            Cancel
          </button>
        ) : !p.loggedIn ? (
          <button
            type="button"
            className="ghost-btn"
            onClick={onLogin}
            disabled={isRedeeming || bulkLocked || snapshotLoading}
          >
            Login
          </button>
        ) : null}
        {p.cardAccountId && (
          <>
            {isPaying ? (
              <button
                type="button"
                className="ghost-btn"
                onClick={onPayCancel}
                title="Force-close the Chase pay window (cancels the in-flight payment flow without submitting)"
              >
                Close browser
              </button>
            ) : (
              <button
                type="button"
                className="primary-action"
                onClick={onPayBalance}
                disabled={isPending || isRedeeming || bulkLocked || snapshotLoading}
                title="Open the pay-balance dialog: pick amount + bank, AmazonG schedules the payment with Chase"
              >
                Pay my Balance
              </button>
            )}
            <button
              type="button"
              className="primary-action success"
              onClick={onRedeemAll}
              disabled={isPending || isPaying || isRedeeming || bulkLocked || snapshotLoading}
              title="Convert all available points on this card to a statement credit"
            >
              {isRedeeming ? 'Redeeming…' : 'Redeem Rewards'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Color-themed outcome group inside the bulk-run summary. Pulled
 *  out so the three (succeeded / skipped / failed) sections share
 *  the same shape — heading + per-profile lines — without
 *  re-implementing the layout three times. */
function BulkOutcomeList({
  tone,
  heading,
  rows,
}: {
  tone: 'emerald' | 'amber' | 'red';
  heading: string;
  rows: { id: string; label: string; detail: string }[];
}) {
  const headingClass =
    tone === 'emerald'
      ? 'text-emerald-300'
      : tone === 'amber'
        ? 'text-amber-200'
        : 'text-red-300';
  const detailClass =
    tone === 'emerald'
      ? 'text-emerald-300/80'
      : tone === 'amber'
        ? 'text-amber-200/80'
        : 'text-red-300/80';
  return (
    <div className="flex flex-col gap-0.5">
      <div className={`text-[10px] uppercase tracking-wider ${headingClass}`}>
        {heading}
      </div>
      <ul className="flex flex-col gap-0.5 pl-1">
        {rows.map((r) => (
          <li
            key={r.id}
            className="flex items-baseline justify-between gap-2 text-[11px]"
          >
            <span className="text-white/85 truncate" title={r.label}>
              {r.label}
            </span>
            {r.detail && (
              <span
                className={`font-mono tabular-nums ${detailClass} truncate`}
                title={r.detail}
              >
                {r.detail}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

