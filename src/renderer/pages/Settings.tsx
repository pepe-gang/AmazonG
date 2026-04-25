import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import type { AmazonProfile, RendererStatus } from '../../shared/types.js';
import { SNAPSHOT_ERROR_GROUPS } from '../../shared/snapshotGroups.js';
import { useSettings } from '../hooks/useSettings.js';
import { useConfirm } from '../components/ConfirmDialog.js';
import { formatBytes, formatDate } from '../lib/format.js';

/* ============================================================
   Settings view (full page)
   Split out of AccountsView so the Accounts page stays focused on
   per-account management. Anything global — live/dry-run, address
   prefixes, headless default, auto-start, snapshots, BG link — lives
   here.
   ============================================================ */
export function SettingsView({
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
            Settings are locked while the worker is running. Click <b>Stop</b> in the header
            to change live mode, prefixes, headless, auto-start, or snapshots.
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
          e.preventDefault();
          e.stopPropagation();
          handleLockedClick();
        }}
      >
        <LiveModePanel />
        <AllowedPrefixesPanel />
        <AutoStartWorkerPanel />
        <DebuggingModeGroup>
          <HeadlessTogglePanel profiles={profiles} />
          <SnapshotSettingsPanel />
        </DebuggingModeGroup>
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
   Debugging Mode group
   ============================================================
   Visual container that groups the developer / debugging toggles
   ("Headless mode", "Capture snapshots on failure") under one
   labeled box. Pure layout — children render as the same panels
   they did before, just nested inside a glass container with a
   header. No state, no behavior change.
*/
function DebuggingModeGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="prefix-panel">
      <div className="prefix-head">
        <div>
          <div className="prefix-title">Debugging Mode</div>
          <div className="prefix-sub">
            Toggles useful for inspecting checkout runs and capturing what
            went wrong on a failure. Off by default for normal day-to-day
            operation.
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-3 mt-3">{children}</div>
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
 * BetterBG identity + disconnect action. Lives with the other global
 * settings — irreversible "detach this device" belongs here, not in
 * the per-account list.
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
      const next = SNAPSHOT_ERROR_GROUPS.map((g) => g.id).filter((g) => g !== id);
      void update({ snapshotGroups: next });
    } else if (groups.includes(id)) {
      const next = groups.filter((g) => g !== id);
      void update({ snapshotGroups: next });
    } else {
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
            any individual account on the Accounts page to Visible and this master switch turns
            off automatically. Takes effect on the next worker Start.
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
