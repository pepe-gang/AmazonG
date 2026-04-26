import { useCallback, useEffect, useState } from 'react';
import { Switch } from '@/components/ui/switch';
import type { AmazonProfile, ChaseProfile } from '../../shared/types.js';
import { useSettings } from '../hooks/useSettings.js';
import { useConfirm } from '../components/ConfirmDialog.js';
import { PencilIcon, PlusIcon, UsersIcon } from '../components/icons.js';
import { relDate, shortEmail } from '../lib/format.js';

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
        <BuyWithFillersPanel />
        <HeadlessTogglePanel profiles={profiles} />
        <AccountsList profiles={profiles} />
        <ChaseAccountsPanel />
      </div>
      {lockedToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 glass-strong px-4 py-2 text-sm rounded-full shadow-lg z-50" role="status">
          Stop the worker first — accounts can't be changed while jobs are polling.
        </div>
      )}
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

function BuyWithFillersPanel() {
  const { settings, busy, update } = useSettings();
  if (!settings) return null;
  const on = settings.buyWithFillers;
  const wheyOn = settings.wheyProteinFillerOnly;
  return (
    <div className="prefix-panel">
      <div className="prefix-head">
        <div>
          <div className="prefix-title">Buy with Fillers</div>
          <div className="prefix-sub">
            When on, every account&apos;s buy phase places the target item alongside ~8 random
            Prime fillers, then cancels the fillers once the order is verified. Applies globally
            to all enabled accounts. Caps worker concurrency to 1 account at a time. Shows as
            &quot;Filler&quot; in the Buy Mode column. Takes effect on the next worker Start.
          </div>
        </div>
        <label
          className="flex items-center gap-2 cursor-pointer"
          title={on ? 'Filler mode enabled — all accounts' : 'Filler mode disabled'}
        >
          <Switch
            checked={on}
            onCheckedChange={(v) => void update({ buyWithFillers: v })}
            disabled={busy}
          />
          <span className="text-xs font-medium text-foreground/80 min-w-[24px]">
            {on ? 'On' : 'Off'}
          </span>
        </label>
      </div>

      {/* Whey-only sub-toggle. Disabled when the master Filler toggle
          is off because it has no effect outside filler mode. Sits
          inside the same panel since it only modifies filler picker
          behavior, not a separate feature. */}
      <div className="flex items-start justify-between gap-3 mt-3 pt-3 border-t border-white/[0.04]">
        <div className="min-w-0">
          <div className="text-xs font-medium text-foreground/80">
            Whey Protein Filler only
          </div>
          <div className="text-[11px] text-muted-foreground leading-snug mt-0.5 max-w-md">
            Restrict fillers to whey-protein items only — 10&ndash;12 per buy
            (random count). Same Prime + $20&ndash;$100 rules. Across the up-to-3
            cashback retries, the picker remembers what it tried so each
            retry lands different items. No effect when Buy with Fillers is off.
          </div>
        </div>
        <label
          className="flex items-center gap-2 cursor-pointer"
          title={
            !on
              ? wheyOn
                ? 'Whey-only pool will activate when Buy with Fillers is enabled'
                : 'Will use the general pool when Buy with Fillers is enabled'
              : wheyOn
                ? 'Whey-only pool active'
                : 'Using the general impulse pool'
          }
        >
          <Switch
            checked={wheyOn}
            onCheckedChange={(v) => void update({ wheyProteinFillerOnly: v })}
            disabled={busy}
          />
          <span className="text-xs font-medium text-foreground/80 min-w-[24px]">
            {wheyOn ? 'On' : 'Off'}
          </span>
        </label>
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
                      className="flex items-center gap-2 cursor-pointer"
                      title={
                        !p.loggedIn
                          ? 'Sign in first to enable this account'
                          : p.enabled
                            ? 'Enabled — included when the worker fans out a job'
                            : 'Disabled — worker skips this account'
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

      {confirmDialog}
      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </div>
  );
}

/* ============================================================
   Chase Accounts panel
   ============================================================
   Local-only Chase profile management. Each profile holds the
   user-given label + a Playwright user-data dir at
   userData/chase-profiles/{id}/. Login is hands-on:
   click "Login", a Chrome window opens to chase.com, the user
   authenticates manually (including any 2FA), and the panel
   detects success when the post-login dashboard URL is reached.
   No credentials are stored or synced anywhere.
*/
function ChaseAccountsPanel() {
  const [profiles, setProfiles] = useState<ChaseProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState('');
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

  const onAdd = async () => {
    const label = newLabel.trim();
    if (!label) return;
    const list = await window.autog.chaseAdd(label);
    setProfiles(list);
    setNewLabel('');
    setAdding(false);
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
            including any 2FA, and the window auto-closes once the dashboard
            loads. Cookies persist on this device; nothing is uploaded to
            BetterBG.
          </div>
        </div>
        <button
          type="button"
          className="ghost-btn"
          onClick={() => setAdding((v) => !v)}
        >
          <PlusIcon />
          <span>Add Chase</span>
        </button>
      </div>

      {adding && (
        <div className="flex items-center gap-2 mt-3">
          <input
            type="text"
            placeholder='Label (e.g. "Personal Chase", "Business Chase")'
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onAdd();
              if (e.key === 'Escape') {
                setNewLabel('');
                setAdding(false);
              }
            }}
            className="flex-1 h-8 rounded-md border border-white/10 bg-white/[0.04] px-3 text-sm text-foreground/90"
          />
          <button
            type="button"
            className="primary-btn-inline"
            onClick={() => void onAdd()}
            disabled={!newLabel.trim()}
          >
            Add
          </button>
          <button
            type="button"
            className="ghost-btn"
            onClick={() => {
              setNewLabel('');
              setAdding(false);
            }}
          >
            Cancel
          </button>
        </div>
      )}

      <div className="flex flex-col gap-2 mt-3">
        {!loading && profiles.length === 0 && !adding && (
          <div className="text-xs text-muted-foreground italic">
            No Chase accounts yet. Click <b>Add Chase</b> to set one up.
          </div>
        )}
        {profiles.map((p) => {
          const state = loginState[p.id];
          const isPending = state === 'pending';
          const justLoggedIn = state === 'ok';
          const errMsg =
            state && typeof state === 'object' && 'error' in state ? state.error : null;
          return (
            <div
              key={p.id}
              className="flex items-start justify-between gap-3 rounded-md border border-white/[0.06] bg-white/[0.02] px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground/90">
                    {p.label}
                  </span>
                  {p.loggedIn ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
                      Logged in
                    </span>
                  ) : (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-zinc-500/30 bg-zinc-500/10 text-zinc-300">
                      Not logged in
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  {p.lastLoginAt
                    ? `Last login ${relDate(p.lastLoginAt)}`
                    : 'Never logged in on this device'}
                </div>
                {isPending && (
                  <div className="text-[11px] text-blue-300 mt-1">
                    Browser open — sign in there. This panel will mark the row
                    once the Chase dashboard loads. Click <b>Cancel</b> to abort.
                  </div>
                )}
                {justLoggedIn && (
                  <div className="text-[11px] text-emerald-300 mt-1">
                    ✓ Logged in successfully.
                  </div>
                )}
                {errMsg && (
                  <div className="text-[11px] text-red-300 mt-1 break-all">
                    {errMsg}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {isPending ? (
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={() => void onAbort(p.id)}
                  >
                    Cancel
                  </button>
                ) : (
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={() => void onLogin(p.id)}
                  >
                    {p.loggedIn ? 'Re-login' : 'Login'}
                  </button>
                )}
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => void onRemove(p)}
                  disabled={isPending}
                  title="Remove profile + clear local Chrome session data"
                >
                  Remove
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {confirmDialog}
    </div>
  );
}
