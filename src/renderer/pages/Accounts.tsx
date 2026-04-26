import { useEffect, useState } from 'react';
import { Switch } from '@/components/ui/switch';
import type { AmazonProfile } from '../../shared/types.js';
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
  return (
    <div className="prefix-panel">
      <div className="prefix-head">
        <div>
          <div className="prefix-title">Buy with Fillers</div>
          <div className="prefix-sub">
            When on, every account&apos;s buy phase places the target item alongside ~10 random
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
