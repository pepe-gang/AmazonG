import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Switch } from '@/components/ui/switch';
import type { AmazonProfile, CreditCardSafe } from '../../shared/types.js';
import type { FillerPool } from '../../shared/ipc.js';
import { useSettings } from '../hooks/useSettings.js';
import { useConfirm } from '../components/ConfirmDialog.js';
import { PencilIcon, PlusIcon, UsersIcon } from '../components/icons.js';
import { relDate, shortEmail } from '../lib/format.js';

/** In-renderer broadcast fired when the payment-card vault changes
 *  (add / remove). The CreditCardsPanel owns the mutations; the
 *  per-account card dropdown in AccountsList listens so it doesn't
 *  show a stale snapshot from its own mount time. */
const CARDS_EVENT = 'autog:cards-changed';

/* ============================================================
   Accounts view (full page)
   Per-account management lives here. Global toggles (live mode,
   prefixes, headless default, auto-start, snapshots, BG link) moved
   to the Settings page.
   ============================================================ */
export function AccountsView({
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
    <div className="flex flex-1 flex-col gap-3 p-5 min-h-0 overflow-auto">
      {workerRunning && (
        <div
          className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-sm text-amber-100"
          role="alert"
        >
          <span>🔒</span>
          <span>
            Account changes are locked while the worker is running. Click <b>Stop</b> in the
            header to add, remove, or sign in to accounts.
          </span>
        </div>
      )}
      <div
        className={
          'flex flex-col gap-3 ' +
          (workerRunning ? 'opacity-60 pointer-events-none' : '')
        }
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
        <EnabledTogglePanel profiles={profiles} />
        <BuyWithFillersPanel profiles={profiles} />
        <HeadlessTogglePanel profiles={profiles} />
      </div>
      {/* Cards panel sits OUTSIDE the worker-locked block — the
          "Verify your card" challenge fires mid-buy, so a card must
          be addable while the worker is running. It renders above the
          accounts list so payment setup is the first thing visible. */}
      <CreditCardsPanel />
      <div
        className={
          'flex flex-col gap-3 ' +
          (workerRunning ? 'opacity-60 pointer-events-none' : '')
        }
        aria-disabled={workerRunning}
        onClickCapture={(e) => {
          if (!workerRunning) return;
          e.preventDefault();
          e.stopPropagation();
          handleLockedClick();
        }}
      >
        <AccountsList profiles={profiles} />
      </div>
      {lockedToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 glass-strong px-4 py-2 text-sm rounded-full shadow-lg z-50" role="status">
          Stop the worker first — accounts can't be changed while jobs are polling.
        </div>
      )}
    </div>
  );
}

/* ============================================================
   Payment cards — feeds the worker's "Verify your card" handler.
   When Amazon interrupts Place Order asking for a card's full
   number, the worker matches the "ending in NNNN" hint against this
   list and fills it. Numbers are encrypted at rest via the OS
   keychain and never leave the main process.
   ============================================================ */
function CreditCardsPanel() {
  const [cards, setCards] = useState<CreditCardSafe[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [labelDraft, setLabelDraft] = useState('');
  const [numberDraft, setNumberDraft] = useState('');
  const [expiryDraft, setExpiryDraft] = useState('');
  const [cvvDraft, setCvvDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const reload = async () => {
      try {
        const list = await window.autog.cardsList();
        if (!cancelled) setCards(list);
      } catch {
        if (!cancelled) setCards([]);
      }
    };
    void reload();
    // A BG cross-device sync at startup can replace the local card
    // vault — reload when main signals it so the list isn't stale.
    const unsubSync = window.autog.onSyncApplied(() => void reload());
    return () => {
      cancelled = true;
      unsubSync();
    };
  }, []);

  const resetDraft = () => {
    setLabelDraft('');
    setNumberDraft('');
    setExpiryDraft('');
    setCvvDraft('');
  };

  const add = async () => {
    setError(null);
    setBusy(true);
    try {
      const next = await window.autog.cardsAdd({
        label: labelDraft,
        number: numberDraft,
        expiry: expiryDraft,
        cvv: cvvDraft,
      });
      setCards(next);
      window.dispatchEvent(new CustomEvent(CARDS_EVENT));
      resetDraft();
      setAdding(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to add card');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      setCards(await window.autog.cardsRemove(id));
      window.dispatchEvent(new CustomEvent(CARDS_EVENT));
    } finally {
      setBusy(false);
    }
  };

  if (!cards) return null;

  return (
    <div className="prefix-panel">
      <div className="prefix-head">
        <div>
          <div className="prefix-title">Payment Cards</div>
          <div className="prefix-sub">
            When Amazon interrupts checkout with a “Verify your card”
            prompt, AmazonG matches the card’s last 4 digits against this
            list and re-enters the full number automatically. Numbers are
            encrypted on this device via the OS keychain — never logged,
            never shown again, never sent to BetterBG.
          </div>
        </div>
        {!adding && (
          <button className="ghost-btn" onClick={() => setAdding(true)}>
            Add card
          </button>
        )}
      </div>
      {adding && (
        <div className="prefix-edit" style={{ flexWrap: 'wrap' }}>
          <input
            type="text"
            autoComplete="off"
            value={labelDraft}
            onChange={(e) => setLabelDraft(e.target.value)}
            placeholder="Label (e.g. Chase Visa)"
          />
          <input
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={numberDraft}
            onChange={(e) => setNumberDraft(e.target.value)}
            placeholder="Full card number"
          />
          <input
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={expiryDraft}
            onChange={(e) => setExpiryDraft(e.target.value)}
            placeholder="MM/YY"
            style={{ maxWidth: 90 }}
          />
          <input
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={cvvDraft}
            onChange={(e) => setCvvDraft(e.target.value)}
            placeholder="CVV"
            style={{ maxWidth: 80 }}
          />
          <button
            className="primary-action"
            onClick={() => void add()}
            disabled={busy || numberDraft.replace(/\D/g, '').length < 13}
          >
            Save
          </button>
          <button
            className="ghost-btn"
            onClick={() => {
              setAdding(false);
              resetDraft();
              setError(null);
            }}
          >
            Cancel
          </button>
          {error && (
            <span style={{ color: '#fca5a5', fontSize: 12, width: '100%' }}>
              {error}
            </span>
          )}
        </div>
      )}
      <div className="prefix-chips">
        {cards.length === 0 ? (
          <span className="prefix-empty">
            No cards saved — “Verify your card” prompts will still fail to
            a manual step
          </span>
        ) : (
          cards.map((c) => (
            <span key={c.id} className="prefix-chip">
              {c.label} ···· {c.last4}
              {c.expiry ? ` · ${c.expiry}` : ''}
              <button
                className="ghost-btn"
                style={{ marginLeft: 6, padding: '0 4px' }}
                onClick={() => void remove(c.id)}
                disabled={busy}
                title="Remove this card"
              >
                ✕
              </button>
            </span>
          ))
        )}
      </div>
    </div>
  );
}

function HeadlessTogglePanel({ profiles }: { profiles: AmazonProfile[] }) {
  const { settings, busy, update } = useSettings();
  const [applying, setApplying] = useState(false);
  if (!settings) return null;
  const on =
    profiles.length > 0
      ? profiles.every((p) => p.headless !== false)
      : settings.headless;
  const toggle = async () => {
    const next = !on;
    setApplying(true);
    try {
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
            any individual account below to Visible and this master switch turns off
            automatically. Takes effect on the next worker Start.
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
          className="flex items-center gap-2 cursor-pointer"
          title={on ? 'Headless: all accounts run hidden' : 'At least one account is set to Visible'}
        >
          <Switch
            checked={on}
            onCheckedChange={() => void toggle()}
            disabled={busy || applying}
          />
          <span className="text-xs font-medium text-foreground/80 min-w-[56px]">
            {on ? 'Headless' : 'Visible'}
          </span>
        </label>
      </div>
    </div>
  );
}

function EnabledTogglePanel({ profiles }: { profiles: AmazonProfile[] }) {
  const { busy } = useSettings();
  const [applying, setApplying] = useState(false);
  if (profiles.length === 0) return null;
  const on = profiles.every((p) => p.enabled);
  const offCount = profiles.filter((p) => !p.enabled).length;
  const toggle = async () => {
    const next = !on;
    setApplying(true);
    try {
      for (const p of profiles) {
        await window.autog.profilesSetEnabled(p.email, next);
      }
    } finally {
      setApplying(false);
    }
  };
  return (
    <div className="prefix-panel">
      <div className="prefix-head">
        <div>
          <div className="prefix-title">Account participation</div>
          <div className="prefix-sub">
            Master switch — toggle to enable or disable every account at once. Disabled accounts
            stay signed in but the worker skips them on Start. Flipping an individual account
            below updates this switch automatically.
            {offCount > 0 && (
              <>
                {' '}
                <span className="muted">
                  ({offCount} of {profiles.length} currently disabled)
                </span>
              </>
            )}
          </div>
        </div>
        <label
          className="flex items-center gap-2 cursor-pointer"
          title={on ? 'All accounts enabled' : 'At least one account is disabled'}
        >
          <Switch
            checked={on}
            onCheckedChange={() => void toggle()}
            disabled={busy || applying}
          />
          <span className="text-xs font-medium text-foreground/80 min-w-[56px]">
            {on ? 'All on' : `${profiles.length - offCount}/${profiles.length}`}
          </span>
        </label>
      </div>
    </div>
  );
}

function BuyWithFillersPanel({ profiles }: { profiles: AmazonProfile[] }) {
  const { settings, busy, update } = useSettings();
  const [applying, setApplying] = useState(false);
  if (!settings) return null;
  const on =
    profiles.length > 0
      ? profiles.every((p) => p.buyWithFillers === true)
      : settings.buyWithFillers;
  const fillerAttempts = settings.fillerAttempts;
  const setAttemptPool = (idx: number, pool: FillerPool) =>
    update({
      fillerAttempts: fillerAttempts.map((p, i) => (i === idx ? pool : p)),
    });
  const addAttempt = () => {
    if (fillerAttempts.length >= 5) return undefined;
    return update({
      fillerAttempts: [
        ...fillerAttempts,
        fillerAttempts[fillerAttempts.length - 1] ?? 'eero',
      ],
    });
  };
  const removeAttempt = (idx: number) => {
    if (fillerAttempts.length <= 1) return undefined;
    return update({
      fillerAttempts: fillerAttempts.filter((_, i) => i !== idx),
    });
  };
  const anyOff = profiles.some((p) => p.buyWithFillers !== true);
  const toggle = async () => {
    const next = !on;
    setApplying(true);
    try {
      for (const p of profiles) {
        await window.autog.profilesSetBuyWithFillers(p.email, next);
      }
      await update({ buyWithFillers: next });
    } finally {
      setApplying(false);
    }
  };
  return (
    <div className="prefix-panel">
      <div className="prefix-head">
        <div>
          <div className="prefix-title">Buy with Fillers</div>
          <div className="prefix-sub">
            When enabled, every account&apos;s buy phase places the target item alongside ~8
            random Prime fillers, then cancels the fillers once the order is verified. Flip any
            individual account below off and this master switch turns off automatically. Caps
            worker concurrency to 1 account at a time. Shows as &quot;Filler&quot; in the Buy
            Mode column. Takes effect on the next worker Start.
            {anyOff && profiles.length > 0 && (
              <>
                {' '}
                <span className="muted">
                  ({profiles.filter((p) => p.buyWithFillers !== true).length} of {profiles.length}{' '}
                  currently off)
                </span>
              </>
            )}
          </div>
        </div>
        <label
          className="flex items-center gap-2 cursor-pointer"
          title={on ? 'Filler mode enabled — all accounts' : 'At least one account is set to Off'}
        >
          <Switch
            checked={on}
            onCheckedChange={() => void toggle()}
            disabled={busy || applying}
          />
          <span className="text-xs font-medium text-foreground/80 min-w-[24px]">
            {on ? 'On' : 'Off'}
          </span>
        </label>
      </div>

      {/* Filler-attempt plan. Each row sets one attempt's pool; the
          number of rows is the retry count. Hidden entirely when the
          master Filler toggle is off — it has no effect there. */}
      {on && (
      <div className="mt-3 pt-3 border-t border-white/[0.04]">
        <div className="text-xs font-medium text-foreground/80">
          Filler Attempts
        </div>
        <div className="text-[11px] text-muted-foreground leading-snug mt-0.5 max-w-md">
          How many times a filler buy retries, and which search-term
          pool each attempt uses. Attempt 1 runs first; later attempts
          fire only if an earlier one fails with a recoverable error.
          Eero / Amazon Basics use narrow brand-specific term lists;
          General uses the broad impulse mix.
        </div>
        <div className="mt-2 flex flex-col gap-1.5">
          {fillerAttempts.map((pool, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <span className="text-[11px] text-muted-foreground w-16 shrink-0">
                Attempt {idx + 1}
              </span>
              <select
                className="bg-transparent border border-white/10 rounded px-2 py-1 text-xs text-foreground/90 cursor-pointer"
                value={pool}
                onChange={(e) =>
                  void setAttemptPool(idx, e.target.value as FillerPool)
                }
                disabled={busy}
              >
                <option value="general">General mix</option>
                <option value="eero">Amazon Eero</option>
                <option value="amazon-basics">Amazon Basics</option>
              </select>
              {fillerAttempts.length > 1 && (
                <button
                  className="text-[11px] text-red-400 hover:text-red-300 px-1.5 py-1 rounded border border-red-500/30 hover:border-red-500/50 cursor-pointer disabled:opacity-40"
                  onClick={() => void removeAttempt(idx)}
                  disabled={busy}
                  title="Remove this attempt"
                  aria-label={`Remove attempt ${idx + 1}`}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
        {fillerAttempts.length < 5 && (
          <button
            className="mt-2 text-[11px] text-foreground/80 hover:text-foreground px-2 py-1 rounded border border-white/10 cursor-pointer disabled:opacity-40"
            onClick={() => void addAttempt()}
            disabled={busy}
          >
            + Add attempt
          </button>
        )}
      </div>
      )}
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

function AccountsList({ profiles }: { profiles: AmazonProfile[] }) {
  const [busyEmail, setBusyEmail] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [toast, setToast] = useState<string | null>(null);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [refreshingEmail, setRefreshingEmail] = useState<string | null>(null);
  const [draggingEmail, setDraggingEmail] = useState<string | null>(null);
  const [dropTargetEmail, setDropTargetEmail] = useState<string | null>(null);
  // Remote per-account settings live on BG (worker reads them to gate
  // buys). We only carry them in renderer state for the toggle UX —
  // source of truth stays server-side. Email keys are lowercased.
  const [remoteSettings, setRemoteSettings] = useState<
    Record<string, { requireMinCashback: boolean; bgAccountId: string | null }>
  >({});
  // The user's BGAccount list — drives the per-account "Submit
  // tracking to" dropdown. Empty list when the user hasn't connected
  // any BG account yet (the dropdown disables itself).
  const [bgAccounts, setBgAccounts] = useState<
    { id: string; label: string; username: string }[]
  >([]);
  // Per-Amazon-account BG address editing. Each profile has its own
  // optional `bgAddress` field stored in profiles.json; clicking "Edit
  // Address" opens a modal pre-filled with the saved values.
  const [addingAddrEmail, setAddingAddrEmail] = useState<string | null>(null);
  const [editAddrEmail, setEditAddrEmail] = useState<string | null>(null);
  // Per-row Actions dropdown — only one menu can be open at a time so
  // this is a single shared "which row's menu is showing" string
  // (email key). Click outside / Escape closes; close also fires when
  // an item is selected so the user doesn't have to dismiss manually
  // after clicking through.
  const [openMenuEmail, setOpenMenuEmail] = useState<string | null>(null);
  // Saved payment cards (safe view) — drives the per-account card
  // dropdown. Reloaded on a BG cross-device sync.
  const [cards, setCards] = useState<CreditCardSafe[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await window.autog.profilesRemoteSettings();
        if (cancelled) return;
        setRemoteSettings(r?.settings ?? {});
        setBgAccounts(r?.bgAccounts ?? []);
      } catch {
        // Quiet failure — if BG is offline the toggle falls back to
        // "require" (default true) visually. Buy flow already fails
        // closed on fetch errors.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load saved payment cards for the per-account card dropdown.
  // Reload on a BG cross-device sync (which can replace the vault)
  // AND on a local add/remove in the Payment Cards panel — otherwise
  // the dropdown shows whatever the vault held at mount time.
  useEffect(() => {
    let cancelled = false;
    const reload = async () => {
      try {
        const list = await window.autog.cardsList();
        if (!cancelled) setCards(list);
      } catch {
        if (!cancelled) setCards([]);
      }
    };
    void reload();
    const unsubSync = window.autog.onSyncApplied(() => void reload());
    const onCards = () => void reload();
    window.addEventListener(CARDS_EVENT, onCards);
    return () => {
      cancelled = true;
      unsubSync();
      window.removeEventListener(CARDS_EVENT, onCards);
    };
  }, []);

  const setCard = async (email: string, cardId: string | null) => {
    try {
      await window.autog.profilesSetCard(email, cardId);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    }
  };

  const doAddBgAddress = async (email: string) => {
    if (addingAddrEmail) return;
    setAddingAddrEmail(email);
    try {
      const r = await window.autog.profilesAddBgAddress(email);
      if (r.ok) {
        showToast(`BG address added to ${email}`);
      } else {
        const detail = r.detail ? ` — ${r.detail}` : '';
        showToast(`Add BG address failed: ${r.reason ?? 'unknown'}${detail}`);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    } finally {
      setAddingAddrEmail(null);
    }
  };

  const toggleRequireMinCashback = async (email: string) => {
    const key = email.toLowerCase();
    const current = remoteSettings[key]?.requireMinCashback ?? true;
    const currentBgAccountId = remoteSettings[key]?.bgAccountId ?? null;
    const next = !current;
    // Optimistic update — flip immediately, roll back on PATCH failure.
    setRemoteSettings((prev) => ({
      ...prev,
      [key]: { requireMinCashback: next, bgAccountId: currentBgAccountId },
    }));
    try {
      await window.autog.profilesSetRequireMinCashback(email, next);
    } catch (err) {
      setRemoteSettings((prev) => ({
        ...prev,
        [key]: { requireMinCashback: current, bgAccountId: currentBgAccountId },
      }));
      showToast(err instanceof Error ? err.message : String(err));
    }
  };

  const setBgAccount = async (email: string, bgAccountId: string | null) => {
    const key = email.toLowerCase();
    const current = remoteSettings[key];
    const requireMinCashback = current?.requireMinCashback ?? true;
    const previous = current?.bgAccountId ?? null;
    if (previous === bgAccountId) return;
    // Optimistic.
    setRemoteSettings((prev) => ({
      ...prev,
      [key]: { requireMinCashback, bgAccountId },
    }));
    try {
      await window.autog.profilesSetBgAccount(email, bgAccountId);
    } catch (err) {
      setRemoteSettings((prev) => ({
        ...prev,
        [key]: { requireMinCashback, bgAccountId: previous },
      }));
      showToast(err instanceof Error ? err.message : String(err));
    }
  };

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
    confirm({
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

  const toggleAutoBuy = async (email: string, autoBuy: boolean) => {
    try {
      await window.autog.profilesSetAutoBuy(email, autoBuy);
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
                    <div className="flex flex-col gap-1.5">
                      <label
                        className="flex items-center gap-2 cursor-pointer"
                        title={
                          !p.loggedIn
                            ? 'Sign in first to enable this account'
                            : p.enabled
                              ? 'Enabled — account participates in the worker (buy + verify + tracking)'
                              : 'Disabled — worker skips this account on EVERY phase (buy, verify, tracking)'
                        }
                      >
                        <Switch
                          checked={p.loggedIn && p.enabled}
                          disabled={!p.loggedIn}
                          onCheckedChange={(v) => void toggleEnabled(p.email, v)}
                        />
                        <span className="text-xs font-medium text-foreground/80 min-w-[56px]">
                          {p.enabled ? 'Enabled' : 'Disabled'}
                        </span>
                      </label>
                      <label
                        className="flex items-center gap-2 cursor-pointer"
                        title={
                          !p.loggedIn
                            ? 'Sign in first to enable this account'
                            : !p.enabled
                              ? 'Enable the account first — Auto Buy is ignored when the account is Disabled'
                              : p.autoBuy
                                ? 'Auto Buy on — account claims new buy jobs'
                                : 'Auto Buy off — account skips new buys but still verifies + tracks existing orders'
                        }
                      >
                        <Switch
                          checked={p.loggedIn && p.enabled && p.autoBuy}
                          disabled={!p.loggedIn || !p.enabled}
                          onCheckedChange={(v) => void toggleAutoBuy(p.email, v)}
                        />
                        <span className="text-xs font-medium text-foreground/80 min-w-[56px]">
                          {p.autoBuy ? 'Auto Buy' : 'No Buy'}
                        </span>
                      </label>
                    </div>
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
                  <div className="account-bg-route">
                    {/* Per-account auto-submit routing for carrier tracking.
                        "None" is the default — opt-in only, so a fresh
                        install never auto-submits anything until the user
                        explicitly picks a BG account. The actual submit
                        logic lives on BG side (step 2); the dropdown just
                        persists the routing field. */}
                    <label
                      className="flex items-center gap-2"
                      title="When set, AmazonG automatically submits carrier tracking codes captured for buys on this Amazon account to the selected buyinggroup.com account. Set to None to disable auto-submit."
                    >
                      <span className="text-xs font-medium text-foreground/80 whitespace-nowrap">
                        Auto-submit tracking to
                      </span>
                      <select
                        value={remoteSettings[p.email.toLowerCase()]?.bgAccountId ?? ''}
                        onChange={(e) => {
                          const v = e.target.value;
                          void setBgAccount(p.email, v === '' ? null : v);
                        }}
                        className="text-xs bg-white/[0.03] border border-white/10 rounded-md px-2 py-1 text-foreground/90 focus:outline-none focus:border-white/30"
                      >
                        <option value="">None — don&apos;t submit</option>
                        {bgAccounts.map((bg) => (
                          <option key={bg.id} value={bg.id}>
                            {bg.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {/* Per-account payment card. Multiple accounts may
                        point at the same card — it's just a reference
                        into the vault. */}
                    <label
                      className="flex items-center gap-2"
                      title="The saved payment card AmazonG uses for this Amazon account at checkout."
                    >
                      <span className="text-xs font-medium text-foreground/80 whitespace-nowrap">
                        Payment card
                      </span>
                      <select
                        value={p.cardId ?? ''}
                        onChange={(e) => {
                          const v = e.target.value;
                          void setCard(p.email, v === '' ? null : v);
                        }}
                        className="text-xs bg-white/[0.03] border border-white/10 rounded-md px-2 py-1 text-foreground/90 focus:outline-none focus:border-white/30"
                      >
                        <option value="">None</option>
                        {cards.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.label} ···· {c.last4}
                          </option>
                        ))}
                        {/* Keep a stale assignment visible even if the
                            card was removed from the vault. */}
                        {p.cardId && !cards.some((c) => c.id === p.cardId) && (
                          <option value={p.cardId}>(card removed)</option>
                        )}
                      </select>
                    </label>
                  </div>
                )}
                {!isRenaming && (
                  <div className="account-actions">
                    <label
                      className="flex items-center gap-2 cursor-pointer"
                      title={
                        p.headless !== false
                          ? 'Headless ON — worker runs this account without showing a browser window'
                          : 'Headless OFF — worker shows the Chromium window for this account (useful for debugging)'
                      }
                    >
                      <Switch
                        checked={p.headless !== false}
                        onCheckedChange={(v) =>
                          void window.autog.profilesSetHeadless(p.email, v)
                        }
                      />
                      <span className="text-xs font-medium text-foreground/80">Headless</span>
                    </label>
                    <label
                      className="flex items-center gap-2 cursor-pointer"
                      title={
                        p.buyWithFillers
                          ? 'Buy-with-Fillers ON for this account — places target alongside ~10 filler items, cancels fillers after verify'
                          : 'Buy-with-Fillers OFF — this account follows the global setting (or plain Buy Now if global is off too)'
                      }
                    >
                      <Switch
                        checked={p.buyWithFillers}
                        onCheckedChange={(v) =>
                          void window.autog.profilesSetBuyWithFillers(p.email, v)
                        }
                      />
                      <span className="text-xs font-medium text-foreground/80">Fillers</span>
                    </label>
                    {(() => {
                      // Cashback gate — server-side setting on BG, reflected
                      // here for flip. ON (default) = worker enforces the 6%
                      // floor for this account. OFF = buy regardless of %.
                      const require =
                        remoteSettings[p.email.toLowerCase()]?.requireMinCashback ?? true;
                      return (
                        <label
                          className="flex items-center gap-2 cursor-pointer"
                          title={
                            require
                              ? 'Cashback gate ON — buys only when cashback ≥ the worker floor (6% default). Click to allow any %.'
                              : 'Cashback gate OFF — buys regardless of cashback. Click to re-enable the 6% floor.'
                          }
                        >
                          <Switch
                            checked={require}
                            onCheckedChange={() => void toggleRequireMinCashback(p.email)}
                          />
                          <span className="text-xs font-medium text-foreground/80">
                            Require ≥ 6% CB
                          </span>
                        </label>
                      );
                    })()}
                    {!p.loggedIn && (
                      // Sign-in stays prominent (primary action) because
                      // a not-signed-in account can't do anything until
                      // it's signed in — burying it in the dropdown
                      // would be a UX trap.
                      <button
                        className="primary-action"
                        disabled={busyEmail === p.email}
                        onClick={() => void doLogin(p.email)}
                      >
                        {busyEmail === p.email ? 'Opening…' : 'Sign in'}
                      </button>
                    )}
                    <ActionsMenu
                      profile={p}
                      open={openMenuEmail === p.email}
                      onOpenChange={(open) => setOpenMenuEmail(open ? p.email : null)}
                      busy={busyEmail === p.email}
                      addingAddr={addingAddrEmail === p.email}
                      onYourOrders={() => void window.autog.profilesOpenOrders(p.email)}
                      onSetEditAddress={() => setEditAddrEmail(p.email)}
                      onAddToAmazon={() => void doAddBgAddress(p.email)}
                      onRemove={() => void doRemove(p.email)}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {confirmDialog}
      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}
      {editAddrEmail && (
        <BGAddressDialog
          email={editAddrEmail}
          initial={
            profiles.find((p) => p.email.toLowerCase() === editAddrEmail.toLowerCase())
              ?.bgAddress ?? null
          }
          onClose={() => setEditAddrEmail(null)}
          onError={(msg) => showToast(msg)}
        />
      )}
    </div>
  );
}

/** Per-row Actions dropdown. Consolidates Your Orders / Set-Edit
 *  Address / Add to Amazon / Remove into one menu so the row doesn't
 *  span a full screen width. Sign-in is intentionally NOT in here —
 *  it stays as a prominent primary button when the account is signed
 *  out, since it's the gating action for everything else. */
function ActionsMenu(props: {
  profile: AmazonProfile;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  addingAddr: boolean;
  onYourOrders: () => void;
  onSetEditAddress: () => void;
  onAddToAmazon: () => void;
  onRemove: () => void;
}) {
  const { profile: p } = props;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Portal-positioned menu coords. Computed from the trigger's
  // bounding rect when the menu opens — `position: fixed` so it
  // floats above every account card regardless of stacking context.
  // Previously a sibling absolute-positioned menu got clipped by
  // the next row's card (it has its own border/background and
  // higher document order). Portal + fixed coords sidesteps both.
  const [coords, setCoords] = useState<{ top: number; right: number } | null>(null);

  useLayoutEffect(() => {
    if (!props.open || !triggerRef.current) {
      setCoords(null);
      return;
    }
    const r = triggerRef.current.getBoundingClientRect();
    setCoords({
      top: r.bottom + 4,
      // right-anchor: viewport-right - trigger-right (so the menu
      // extends leftward from the trigger's right edge, matching
      // the previous .actions-menu absolute-positioned layout)
      right: window.innerWidth - r.right,
    });
  }, [props.open]);

  // Close on click outside + Escape. The trigger and menu both
  // need to count as "inside" so clicking inside the menu doesn't
  // also close it.
  useEffect(() => {
    if (!props.open) return;
    const onDocClick = (e: MouseEvent) => {
      const tgt = e.target as Node;
      if (triggerRef.current?.contains(tgt)) return;
      if (menuRef.current?.contains(tgt)) return;
      props.onOpenChange(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onOpenChange(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [props.open, props]);

  const close = () => props.onOpenChange(false);
  const addr = p.bgAddress;
  const addrTitle = addr
    ? `${addr.fullName}\n${addr.street1}\n${addr.city}, ${addr.state} ${addr.zip}`
    : null;

  return (
    <div className="actions-menu-wrap">
      <button
        ref={triggerRef}
        type="button"
        className="ghost-btn"
        aria-haspopup="menu"
        aria-expanded={props.open}
        onClick={() => props.onOpenChange(!props.open)}
      >
        Actions ▾
      </button>
      {props.open && coords && createPortal(
        <div
          ref={menuRef}
          className="actions-menu"
          role="menu"
          style={{ top: coords.top, right: coords.right }}
        >
          {p.loggedIn && (
            <button
              type="button"
              role="menuitem"
              className="actions-menu-item"
              onClick={() => {
                props.onYourOrders();
                close();
              }}
            >
              Your Orders ↗
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="actions-menu-item"
            title={addrTitle ? `Saved BG address:\n${addrTitle}` : undefined}
            onClick={() => {
              props.onSetEditAddress();
              close();
            }}
          >
            {addr ? 'Edit Address' : 'Set Address'}
          </button>
          {p.loggedIn && addr && (
            <button
              type="button"
              role="menuitem"
              className="actions-menu-item"
              disabled={props.addingAddr}
              title={`Add saved BG address to Amazon's address book.\n\n${addrTitle}`}
              onClick={() => {
                props.onAddToAmazon();
                close();
              }}
            >
              {props.addingAddr ? 'Adding…' : 'Add to Amazon'}
            </button>
          )}
          <div className="actions-menu-divider" />
          <button
            type="button"
            role="menuitem"
            className="actions-menu-item actions-menu-item--danger"
            disabled={props.busy}
            onClick={() => {
              props.onRemove();
              close();
            }}
          >
            Remove
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}

/** Per-account BG address edit dialog. Holds form state locally, saves
 *  via profiles:set-bg-address. Empty all-required-fields clears the
 *  saved address (passes null to the IPC). */
function BGAddressDialog(props: {
  email: string;
  initial: import('../../shared/types.js').BGAddress | null;
  onClose: () => void;
  onError: (msg: string) => void;
}) {
  const [fullName, setFullName] = useState(props.initial?.fullName ?? '');
  const [phone, setPhone] = useState(props.initial?.phone ?? '');
  const [street1, setStreet1] = useState(props.initial?.street1 ?? '');
  const [street2, setStreet2] = useState(props.initial?.street2 ?? '');
  const [city, setCity] = useState(props.initial?.city ?? '');
  const [state, setState] = useState(props.initial?.state ?? '');
  const [zip, setZip] = useState(props.initial?.zip ?? '');
  const [saving, setSaving] = useState(false);

  const canSave =
    fullName.trim().length > 0 &&
    phone.trim().length > 0 &&
    street1.trim().length > 0 &&
    city.trim().length > 0 &&
    state.trim().length === 2 &&
    zip.trim().length >= 5;

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await window.autog.profilesSetBgAddress(props.email, {
        fullName: fullName.trim(),
        phone: phone.trim(),
        street1: street1.trim(),
        street2: street2.trim() ? street2.trim() : null,
        city: city.trim(),
        state: state.trim().toUpperCase(),
        zip: zip.trim(),
      });
      // Profiles state refreshes via evt:profiles broadcast — just close.
      props.onClose();
    } catch (err) {
      props.onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await window.autog.profilesSetBgAddress(props.email, null);
      props.onClose();
    } catch (err) {
      props.onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={props.onClose}
    >
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-xl p-5 w-[420px] max-w-[95vw] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold text-zinc-100 mb-1">BG receiving address</div>
        <div className="text-xs text-zinc-500 mb-3 break-all">{props.email}</div>
        <div className="grid grid-cols-2 gap-2">
          <div className="col-span-2">
            <label className="block text-[10px] uppercase tracking-wide text-zinc-500 mb-1">
              Full name *
            </label>
            <input
              className="w-full bg-black/40 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:border-zinc-600"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Thi Ngoc Nguyen (BG1)"
            />
          </div>
          <div className="col-span-2">
            <label className="block text-[10px] uppercase tracking-wide text-zinc-500 mb-1">Phone *</label>
            <input
              className="w-full bg-black/40 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:border-zinc-600"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="(503) 555-0100"
            />
          </div>
          <div className="col-span-2">
            <label className="block text-[10px] uppercase tracking-wide text-zinc-500 mb-1">
              Street address *
            </label>
            <input
              className="w-full bg-black/40 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:border-zinc-600"
              value={street1}
              onChange={(e) => setStreet1(e.target.value)}
              placeholder="13130 NE AIRPORT WAY"
            />
          </div>
          <div className="col-span-2">
            <label className="block text-[10px] uppercase tracking-wide text-zinc-500 mb-1">Unit / suite</label>
            <input
              className="w-full bg-black/40 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:border-zinc-600"
              value={street2}
              onChange={(e) => setStreet2(e.target.value)}
              placeholder="(optional)"
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-zinc-500 mb-1">City *</label>
            <input
              className="w-full bg-black/40 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:border-zinc-600"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              placeholder="Portland"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-zinc-500 mb-1">
                State *
              </label>
              <input
                className="w-full bg-black/40 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-200 uppercase focus:outline-none focus:border-zinc-600"
                value={state}
                onChange={(e) => setState(e.target.value.toUpperCase().slice(0, 2))}
                placeholder="OR"
                maxLength={2}
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-zinc-500 mb-1">ZIP *</label>
              <input
                className="w-full bg-black/40 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:border-zinc-600"
                value={zip}
                onChange={(e) => setZip(e.target.value)}
                placeholder="97230"
              />
            </div>
          </div>
        </div>
        <div className="mt-4 flex items-center justify-between gap-2">
          <button
            type="button"
            className="text-xs text-zinc-500 hover:text-rose-300 underline-offset-2 hover:underline"
            disabled={saving || !props.initial}
            onClick={() => void clear()}
          >
            Clear saved address
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="px-3 py-1.5 rounded-full text-xs border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
              onClick={props.onClose}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="button"
              className="px-3 py-1.5 rounded-full text-xs border bg-amber-500/10 border-amber-500/30 text-amber-200 hover:bg-amber-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={!canSave || saving}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
