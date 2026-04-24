import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import type { AmazonProfile, RendererStatus } from '../../shared/types.js';
import { SNAPSHOT_ERROR_GROUPS } from '../../shared/snapshotGroups.js';
import { useSettings } from '../hooks/useSettings.js';
import { useConfirm } from '../components/ConfirmDialog.js';
import { PencilIcon, PlusIcon, UsersIcon } from '../components/icons.js';
import { formatBytes, formatDate, relDate, shortEmail } from '../lib/format.js';

/* ============================================================
   Accounts view (full page)
   ============================================================ */
export function AccountsView({
  profiles,
  workerRunning,
  identity,
}: {
  profiles: AmazonProfile[];
  workerRunning: boolean;
  identity: RendererStatus['identity'];
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
            Account settings are locked while the worker is running. Click <b>Stop</b> in the
            header to edit accounts, prefixes, or headless mode.
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
        <LiveModePanel />
        <AllowedPrefixesPanel />
        <HeadlessTogglePanel profiles={profiles} />
        <AutoStartWorkerPanel />
        <BuyWithFillersPanel />
        <SnapshotSettingsPanel />
        <AccountsList profiles={profiles} />
        <BetterBGConnectionPanel identity={identity} workerRunning={workerRunning} />
      </div>
      {lockedToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 glass-strong px-4 py-2 text-sm rounded-full shadow-lg z-50" role="status">
          Stop the worker first — settings can't be changed while jobs are polling.
        </div>
      )}
    </div>
  );
}

/* ============================================================
   Dry-run banner (toggle)
   ============================================================ */
function LiveModePanel() {
  const { settings, busy, update } = useSettings();
  if (!settings) return null;
  const live = !settings.buyDryRun;
  return (
    <div className="prefix-panel">
      <div className="prefix-head">
        <div>
          <div className="prefix-title">Live mode</div>
          <div className="prefix-sub">
            When on, real Amazon orders are placed. When off, dry-run — runs the full flow
            (including saved-address mutations like BG1/BG2) but stops before clicking Place Order.
          </div>
        </div>
        <label
          className="flex items-center gap-2 cursor-pointer"
          title={live ? 'Real orders will be placed' : 'Dry-run — no orders placed'}
        >
          <Switch
            checked={live}
            onCheckedChange={(v) => void update({ buyDryRun: !v })}
            disabled={busy}
          />
          <span className="text-xs font-medium text-foreground/80 min-w-[24px]">
            {live ? 'On' : 'Off'}
          </span>
        </label>
      </div>
    </div>
  );
}

/**
 * BetterBG identity + disconnect action. Moved out of the header so
 * the glass top chrome stays focused on worker state (Start/Stop,
 * uptime) and irreversible "detach this device" lives with the other
 * settings. Uses ConfirmDialog for the "really disconnect?" prompt so
 * it matches the glass look of everything else.
 */
function BetterBGConnectionPanel({
  identity,
  workerRunning,
}: {
  identity: RendererStatus['identity'];
  workerRunning: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const { confirm, dialog: confirmDialog } = useConfirm();

  const startDisconnect = () => {
    confirm({
      title: 'Disconnect from BetterBG?',
      message:
        'The saved Secret Key is removed and this device stops claiming jobs. You\'ll need to paste the key again to reconnect. Your Amazon profiles + their saved sessions are untouched.',
      confirmLabel: 'Disconnect',
      danger: true,
      onConfirm: async () => {
        setBusy(true);
        try {
          await window.autog.identityDisconnect();
        } finally {
          setBusy(false);
        }
      },
    });
  };

  return (
    <div className="prefix-panel">
      <div className="prefix-head">
        <div className="min-w-0">
          <div className="prefix-title">BetterBG connection</div>
          <div className="prefix-sub">
            This device is linked to {identity?.userEmail ?? 'your BetterBG account'} via a
            saved Secret Key. The worker uses that key to claim jobs. Disconnect to unlink
            the device — you can re-paste the key later to reconnect.
          </div>
          {identity?.last4 && (
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="uppercase tracking-wider text-[10px]">Key</span>
              <span className="font-mono text-foreground/70">…{identity.last4}</span>
              {identity.keyCreatedAt && (
                <>
                  <span className="text-muted-foreground/60">·</span>
                  <span>added {formatDate(identity.keyCreatedAt)}</span>
                </>
              )}
            </div>
          )}
        </div>
        <Button
          variant="destructive"
          size="sm"
          onClick={startDisconnect}
          disabled={busy || workerRunning}
          title={
            workerRunning
              ? 'Stop the worker first — can\'t disconnect while jobs are polling'
              : 'Unlink this device from BetterBG'
          }
        >
          Disconnect
        </Button>
      </div>
      {confirmDialog}
    </div>
  );
}

function AutoStartWorkerPanel() {
  const { settings, busy, update } = useSettings();
  if (!settings) return null;
  const on = settings.autoStartWorker;
  return (
    <div className="prefix-panel">
      <div className="prefix-head">
        <div>
          <div className="prefix-title">Auto-start worker</div>
          <div className="prefix-sub">
            When on, the polling worker starts as soon as AmazonG launches (assuming you're
            connected to BetterBG). Pairs well with leaving the app running in the background —
            you don't have to click Start every time.
          </div>
        </div>
        <label
          className="flex items-center gap-2 cursor-pointer"
          title={on ? 'Worker starts on launch' : 'Worker waits for you to click Start'}
        >
          <Switch
            checked={on}
            onCheckedChange={(v) => void update({ autoStartWorker: v })}
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

function SnapshotSettingsPanel() {
  const { settings, busy, update } = useSettings();
  const [diskUsage, setDiskUsage] = useState<{ count: number; bytes: number } | null>(null);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    void window.autog.snapshotsDiskUsage().then(setDiskUsage);
  }, []);

  const clearSnapshots = async () => {
    if (!confirm('Delete all snapshot files (screenshots, HTML, traces)? Job history and logs are kept.')) return;
    setClearing(true);
    try {
      await window.autog.snapshotsClearAll();
      setDiskUsage({ count: 0, bytes: 0 });
    } finally {
      setClearing(false);
    }
  };

  if (!settings) return null;
  const on = settings.snapshotOnFailure;
  const groups = settings.snapshotGroups ?? [];
  const allSelected = groups.length === 0;

  const toggleGroup = (id: string) => {
    if (allSelected) {
      // Switching from "all" to specific: select everything except the one we're toggling off
      const next = SNAPSHOT_ERROR_GROUPS.map((g) => g.id).filter((g) => g !== id);
      void update({ snapshotGroups: next });
    } else if (groups.includes(id)) {
      const next = groups.filter((g) => g !== id);
      void update({ snapshotGroups: next });
    } else {
      // If adding this would select all, go back to empty (= all)
      const next = [...groups, id];
      if (next.length >= SNAPSHOT_ERROR_GROUPS.length) {
        void update({ snapshotGroups: [] });
      } else {
        void update({ snapshotGroups: next });
      }
    }
  };

  return (
    <div className="prefix-panel">
      <div className="prefix-head">
        <div>
          <div className="prefix-title">Capture snapshots on failure</div>
          <div className="prefix-sub">
            When on, AmazonG saves a screenshot and HTML snapshot of the page whenever a checkout
            error occurs. Snapshots appear in the log viewer for debugging. Stored locally, cleaned
            up automatically after 30 days.
          </div>
        </div>
        <label
          className="flex items-center gap-2 cursor-pointer"
          title={on ? 'Snapshots enabled' : 'Snapshots disabled'}
        >
          <Switch
            checked={on}
            onCheckedChange={(v) => void update({ snapshotOnFailure: v })}
            disabled={busy}
          />
          <span className="text-xs font-medium text-foreground/80 min-w-[24px]">
            {on ? 'On' : 'Off'}
          </span>
        </label>
      </div>
      {on && (
        <div className="snapshot-groups">
          <div className="snapshot-groups-head">
            <span className="prefix-sub">Capture errors:</span>
            <button
              className="ghost-btn snapshot-all-btn"
              onClick={() => void update({ snapshotGroups: [] })}
              disabled={busy || allSelected}
            >
              {allSelected ? 'All selected' : 'Select all'}
            </button>
          </div>
          <div className="snapshot-group-list">
            {SNAPSHOT_ERROR_GROUPS.map((g) => {
              const checked = allSelected || groups.includes(g.id);
              return (
                <label key={g.id} className="snapshot-group-item">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleGroup(g.id)}
                    disabled={busy}
                  />
                  <span>{g.label}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}
      {diskUsage && diskUsage.count > 0 && (
        <div className="snapshot-disk">
          <span className="snapshot-disk-label">
            {diskUsage.count} snapshot{diskUsage.count !== 1 ? 's' : ''} · {formatBytes(diskUsage.bytes)}
          </span>
          <button
            className="ghost-btn snapshot-clear-btn"
            onClick={() => void clearSnapshots()}
            disabled={clearing}
          >
            {clearing ? 'Clearing…' : 'Clear all snapshots'}
          </button>
        </div>
      )}
    </div>
  );
}

function HeadlessTogglePanel({ profiles }: { profiles: AmazonProfile[] }) {
  const { settings, busy, update } = useSettings();
  const [applying, setApplying] = useState(false);
  if (!settings) return null;
  // Master toggle state is derived from the per-profile switches. When
  // there are no profiles yet, fall back to the global default so the user
  // sees a non-empty state.
  const on =
    profiles.length > 0
      ? profiles.every((p) => p.headless !== false)
      : settings.headless;
  const toggle = async () => {
    const next = !on;
    setApplying(true);
    try {
      // Serialize the per-profile writes — the main-side updateProfile
      // reads + writes profiles.json, so running them in parallel
      // clobbers state (last writer wins). Sequential keeps every update.
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
            any individual account below to Visible and this master switch turns off automatically.
            Takes effect on the next worker Start.
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

function AllowedPrefixesPanel() {
  const { settings, busy, update } = useSettings();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  useEffect(() => {
    if (settings) setDraft(settings.allowedAddressPrefixes.join(', '));
  }, [settings]);

  const save = async () => {
    const list = draft
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    await update({ allowedAddressPrefixes: list });
    setEditing(false);
  };

  if (!settings) return null;

  return (
    <div className="prefix-panel">
      <div className="prefix-head">
        <div>
          <div className="prefix-title">Allowed House-Number Prefixes</div>
          <div className="prefix-sub">
            Checkout only proceeds if the Amazon delivery address's street line starts with one of
            these house numbers (e.g. <code>13132</code> matches{' '}
            <code>13132 NE Portland Way</code>). If the current address doesn't match, AmazonG
            opens the picker and selects the matching saved address.
          </div>
        </div>
        {!editing && (
          <button className="ghost-btn" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <div className="prefix-edit">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="13132, 13130, 1146"
          />
          <button className="primary-action" onClick={() => void save()} disabled={busy}>
            Save
          </button>
          <button
            className="ghost-btn"
            onClick={() => {
              setEditing(false);
              setDraft(settings.allowedAddressPrefixes.join(', '));
            }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="prefix-chips">
          {settings.allowedAddressPrefixes.length === 0 ? (
            <span className="prefix-empty">None — address verification is off</span>
          ) : (
            settings.allowedAddressPrefixes.map((p) => (
              <span key={p} className="prefix-chip">
                {p}
              </span>
            ))
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
    Record<string, { requireMinCashback: boolean }>
  >({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const map = await window.autog.profilesRemoteSettings();
        if (!cancelled) setRemoteSettings(map ?? {});
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
    const next = !current;
    // Optimistic update — flip immediately, roll back on PATCH failure.
    setRemoteSettings((prev) => ({ ...prev, [key]: { requireMinCashback: next } }));
    try {
      await window.autog.profilesSetRequireMinCashback(email, next);
    } catch (err) {
      setRemoteSettings((prev) => ({ ...prev, [key]: { requireMinCashback: current } }));
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
