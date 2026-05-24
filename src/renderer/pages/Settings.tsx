import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import type { RendererStatus } from '../../shared/types.js';
import { useSettings } from '../hooks/useSettings.js';
import { useConfirm } from '../components/ConfirmDialog.js';
import { formatDate } from '../lib/format.js';

/* ============================================================
   Settings view (full page)
   Split out of AccountsView so the Accounts page stays focused on
   per-account management. Anything global — address prefixes,
   headless default, auto-start, parallel buys, BG link — lives here.
   ============================================================ */
export function SettingsView({
  workerRunning,
  identity,
}: {
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
            to change prefixes, headless, auto-start, or parallel buys.
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
        <AllowedPrefixesPanel />
        <AutoStartWorkerPanel />
        <ParallelBuysPanel />
        <BetterBGConnectionPanel identity={identity} workerRunning={workerRunning} />
      </div>
      {lockedToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 glass-strong px-4 py-2 text-sm rounded-full shadow-lg z-50" role="status">
          Stop the worker first — settings can't be changed while the worker is running.
        </div>
      )}
    </div>
  );
}

/* ============================================================
   Parallel buys (account-fanout cap)
   ============================================================ */
const PARALLEL_MIN = 1;
const PARALLEL_MAX = 5;

function ParallelBuysPanel() {
  const { settings, busy, update } = useSettings();
  if (!settings) return null;
  // Defensive default: existing installs may have a settings.json that
  // predates this field, in which case the IPC payload comes back
  // missing it and the stepper would render `NaN` / blank. Show 3
  // until the user clicks +/-, which persists the field for real.
  const parallel = settings.maxConcurrentBuys ?? 3;
  const setParallel = (v: number) => {
    const clamped = Math.max(PARALLEL_MIN, Math.min(PARALLEL_MAX, Math.round(v)));
    void update({ maxConcurrentBuys: clamped });
  };
  return (
    <div className="prefix-panel">
      <div className="prefix-head">
        <div>
          <div className="prefix-title">Parallel buys</div>
          <div className="prefix-sub">
            How many Amazon accounts can run a deal at the same time.
            Each account opens its own Chrome window. <b>Higher</b> means
            more deals caught quickly when several of your accounts are
            eligible — but uses more memory and runs hotter on your
            laptop. <b>Lower</b> is quieter and cooler. Default is{' '}
            <b>3</b>, tuned for typical Apple Silicon Macs; dial down to{' '}
            <b>1</b> on older or fanless laptops if you hear fans
            spinning. Applies to both single-mode and filler-mode buys.
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setParallel(parallel - 1)}
            disabled={busy || parallel <= PARALLEL_MIN}
            aria-label="Decrease parallel buys"
            className="h-7 w-7 rounded-md border border-white/10 bg-white/[0.04] text-foreground/80 hover:bg-white/[0.08] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            −
          </button>
          <span className="tabular-nums w-7 text-center text-base font-medium">
            {parallel}
          </span>
          <button
            type="button"
            onClick={() => setParallel(parallel + 1)}
            disabled={busy || parallel >= PARALLEL_MAX}
            aria-label="Increase parallel buys"
            className="h-7 w-7 rounded-md border border-white/10 bg-white/[0.04] text-foreground/80 hover:bg-white/[0.08] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            +
          </button>
          <span className="text-xs text-muted-foreground ml-1">
            accounts
          </span>
        </div>
      </div>
      <div className="text-[11px] text-muted-foreground/70 mt-3">
        Range {PARALLEL_MIN}–{PARALLEL_MAX}. Going higher than 3 may
        trigger Amazon's anti-bot checks. Changes apply on the next
        deal AmazonG claims (no need to stop / restart the worker —
        settings are re-read every claim).
      </div>
    </div>
  );
}

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
              ? 'Stop the worker first — can\'t disconnect while the worker is running'
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
            When on, the worker starts as soon as AmazonG launches (assuming you're
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

