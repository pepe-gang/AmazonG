import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import type { AmazonProfile, RendererStatus } from '../../shared/types.js';
import type { FillerPool } from '../../shared/ipc.js';
import { useSettings } from '../hooks/useSettings.js';
import { useConfirm } from '../components/ConfirmDialog.js';
import { formatDate } from '../lib/format.js';

/* ============================================================
   Settings view (full page)
   Organized into three sections so the user can mentally map a knob
   to the right place at a glance:
     1. Auto-Buy — every knob that affects how a buy runs
     2. Worker   — app-side runtime (auto-start, etc.)
     3. BetterBG — identity / disconnect
   Per-account toggles (enable / autoBuy / per-account filler / login)
   stay on the Accounts tab — they're row-context, not global state.
   ============================================================ */
export function SettingsView({
  workerRunning,
  identity,
  profiles,
}: {
  workerRunning: boolean;
  identity: RendererStatus['identity'];
  profiles: AmazonProfile[];
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
            to change anything below.
          </span>
        </div>
      )}
      <div
        className={
          'flex flex-col gap-5 ' +
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
        <SettingsSection
          title="Auto-Buy"
          sub="How each buy runs — fillers, retries, gates, concurrency."
          headerExtra={<ResetAutoBuyDefaultsButton profiles={profiles} />}
        >
          <BuyWithFillersPanel profiles={profiles} />
          <ParallelBuysPanel />
          <AllowedPrefixesPanel />
          <PrimeCheckTogglePanel />
          <BgNameTogglePanel />
        </SettingsSection>

        <SettingsSection title="Worker" sub="App-side runtime defaults.">
          <AutoStartWorkerPanel />
        </SettingsSection>

        <SettingsSection title="BetterBG" sub="Identity for this device.">
          <BetterBGConnectionPanel identity={identity} workerRunning={workerRunning} />
        </SettingsSection>
      </div>
      {lockedToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 glass-strong px-4 py-2 text-sm rounded-full shadow-lg z-50" role="status">
          Stop the worker first — settings can't be changed while the worker is running.
        </div>
      )}
    </div>
  );
}

/** Section header + child stack. Adds a visible label so the three
 *  groupings (Auto-Buy / Worker / BetterBG) read clearly without an
 *  accordion or extra route. `headerExtra` mounts to the right of the
 *  title row — used by Auto-Buy to surface its "Reset to defaults"
 *  button without nesting it inside any individual panel. */
function SettingsSection({
  title,
  sub,
  headerExtra,
  children,
}: {
  title: string;
  sub?: string;
  headerExtra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-3 pb-1 border-b border-white/[0.06]">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-foreground/85">{title}</h2>
          {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
        </div>
        {headerExtra}
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
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
  // missing it and the stepper would render `NaN` / blank. Show 5
  // (the current factory default) until the user clicks +/-, which
  // persists the field for real.
  const parallel = settings.maxConcurrentBuys ?? 5;
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
            <b>5</b> on Apple Silicon Macs; dial down to <b>1</b> on
            older or fanless laptops if you hear fans spinning.
            Applies to both single-mode and filler-mode buys.
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
        Range {PARALLEL_MIN}–{PARALLEL_MAX}. Changes apply on the next
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


/* ============================================================
   Auto-Buy panels (moved from Accounts.tsx — they're all
   global/worker-wide toggles, not per-account row context)
   ============================================================ */

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

      {/* Filler count + attempt plan. Both hidden when the master Filler
          toggle is off — they have no effect there. */}
      {on && (
      <div className="mt-3 pt-3 border-t border-white/[0.04]">
        <div className="text-xs font-medium text-foreground/80">
          Filler Count
        </div>
        <div className="text-[11px] text-muted-foreground leading-snug mt-0.5 max-w-md">
          Number of random filler items added alongside the target.
          Higher = better disguise but slower checkout + higher risk
          of <code>no_filler_candidates</code> when Amazon rate-limits
          search. Default 8. (The Eero pool keeps a hardcoded 5
          regardless — its candidate pool is smaller.)
        </div>
        <div className="mt-2 flex items-center gap-2">
          <input
            type="number"
            min={1}
            max={20}
            step={1}
            value={settings.fillerCount ?? 8}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              if (!Number.isFinite(n)) return;
              void update({ fillerCount: Math.max(1, Math.min(20, n)) });
            }}
            disabled={busy}
            className="bg-transparent border border-white/10 rounded px-2 py-1 text-xs text-foreground/90 w-20"
          />
          <span className="text-[11px] text-muted-foreground">
            fillers per buy (1–20)
          </span>
        </div>
        {/* Browser-search fallback — opt-in, off by default. */}
        <div className="mt-4 flex items-start justify-between gap-3 max-w-md">
          <div>
            <div className="text-xs font-medium text-foreground/80">
              Browser-search fallback
            </div>
            <div className="text-[11px] text-muted-foreground leading-snug mt-0.5">
              When Amazon rate-limits the filler search (the{' '}
              <code>no_filler_candidates</code> failure), retry the search in
              a real browser tab instead of giving up. More reliable under
              rate-limits, but adds a browser navigation + latency per
              affected buy. Off by default. Takes effect on the next worker
              Start.
            </div>
          </div>
          <label className="flex items-center gap-2 cursor-pointer shrink-0 pt-0.5">
            <Switch
              checked={settings.fillerBrowserFallback === true}
              onCheckedChange={(v) => void update({ fillerBrowserFallback: v })}
              disabled={busy}
            />
            <span className="text-xs font-medium text-foreground/80 min-w-[24px]">
              {settings.fillerBrowserFallback === true ? 'On' : 'Off'}
            </span>
          </label>
        </div>
        <div className="text-xs font-medium text-foreground/80 mt-4">
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
        {/* Auto-rebuy lives under Buy-with-Fillers because every rebuy
            runs in filler mode — exposing it outside this section would
            misleadingly imply non-filler rebuys are possible. Hidden
            when fillers are off, per user spec 2026-05-26. */}
        <div className="mt-4">
          <AutoRebuyOnCancelPanel />
        </div>
      </div>
      )}
    </div>
  );
}

/* ============================================================
   Auto-rebuy on cancel (numeric — max chain depth)
   Persists on BG.User via /api/user/auto-buy (NOT in settings.json).
   ============================================================ */
const REBUY_MIN = 0;
const REBUY_MAX = 10;

function AutoRebuyOnCancelPanel() {
  const [value, setValue] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const prefs = await window.autog.userAutoBuyGet();
        if (cancelled) return;
        if (!prefs) {
          setValue(0);
          setError('Connect to BetterBG to load this setting.');
          return;
        }
        setValue(prefs.autoRebuyOnCancelMax);
      } catch (err) {
        if (cancelled) return;
        setValue(0);
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = async (next: number) => {
    const clamped = Math.max(REBUY_MIN, Math.min(REBUY_MAX, Math.round(next)));
    if (clamped === value) return;
    const prev = value;
    setValue(clamped);
    setSaving(true);
    setError(null);
    try {
      const saved = await window.autog.userAutoBuySet(clamped);
      setValue(saved.autoRebuyOnCancelMax);
    } catch (err) {
      setValue(prev);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (value === null) return null;
  const isOff = value === 0;
  return (
    <div className="prefix-panel">
      <div className="prefix-head">
        <div>
          <div className="prefix-title">Auto-rebuy on cancel</div>
          <div className="prefix-sub">
            When Amazon cancels a placed order, automatically queue a
            filler-mode rebuy 5 minutes later on the same account.
            Counts the rebuy chain — if a rebuy is also cancelled, we
            retry again, up to this many total retries. <b>0</b>{' '}
            disables. <b>1</b> means one retry. <b>2</b> means: retry,
            and if that&apos;s also cancelled, retry once more.
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => void persist(value - 1)}
            disabled={saving || value <= REBUY_MIN}
            aria-label="Decrease max retries"
            className="h-7 w-7 rounded-md border border-white/10 bg-white/[0.04] text-foreground/80 hover:bg-white/[0.08] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            −
          </button>
          <span className="tabular-nums w-7 text-center text-base font-medium">
            {value}
          </span>
          <button
            type="button"
            onClick={() => void persist(value + 1)}
            disabled={saving || value >= REBUY_MAX}
            aria-label="Increase max retries"
            className="h-7 w-7 rounded-md border border-white/10 bg-white/[0.04] text-foreground/80 hover:bg-white/[0.08] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            +
          </button>
          <span className="text-xs text-muted-foreground ml-1">
            {isOff ? 'off' : value === 1 ? 'retry' : 'retries'}
          </span>
        </div>
      </div>
      <div className="text-[11px] text-muted-foreground/70 mt-3">
        Range {REBUY_MIN}–{REBUY_MAX}. Persists on BetterBG and is
        shared across every device connected with this API key.
        Cancellations during the fetch-tracking phase (shipped items)
        are never auto-rebought regardless of this setting.
        {error && (
          <span className="block mt-1 text-rose-300/90">⚠ {error}</span>
        )}
      </div>
    </div>
  );
}

function PrimeCheckTogglePanel() {
  const { settings, update, busy } = useSettings();
  if (!settings) return null;
  // Label semantics: switch is "Prime check enabled". On = enforce
  // (default). Off = skip the badge check worker-wide. Stored as
  // `bypassPrimeCheck` so the polarity matches BG's per-job flag.
  const enforced = settings.bypassPrimeCheck !== true;
  const toggle = async () => {
    await update({ bypassPrimeCheck: enforced });
  };
  return (
    <div className="prefix-panel">
      <div className="prefix-head">
        <div>
          <div className="prefix-title">Prime check</div>
          <div className="prefix-sub">
            Enforce Amazon&apos;s visible ✓prime badge before placing
            an order. On (default) is safe — the worker refuses to
            buy when the badge is missing. Turn off if the static
            parser is misreading the badge across the board and
            you&apos;d rather buy than fail with{' '}
            <code>not_prime</code> or <code>prime_unconfirmed</code>.
            Takes effect on the next worker Start. Applies to every
            account; BG&apos;s per-job &quot;Bypass Prime check&quot;
            still wins for jobs that opt in.
          </div>
        </div>
        <label
          className="flex items-center gap-2 cursor-pointer"
          title={
            enforced
              ? 'Prime check enforced — orders only when ✓prime badge is visible'
              : 'Prime check off — buys regardless of Prime badge'
          }
        >
          <Switch
            checked={enforced}
            onCheckedChange={() => void toggle()}
            disabled={busy}
          />
          <span className="text-xs font-medium text-foreground/80 min-w-[24px]">
            {enforced ? 'On' : 'Off'}
          </span>
        </label>
      </div>
    </div>
  );
}

function BgNameTogglePanel() {
  const { settings, update, busy } = useSettings();
  if (!settings) return null;
  // Treat any non-false (incl. undefined on a fresh-from-disk read) as
  // on, matching the worker-side default.
  const on = settings.bgNameToggleEnabled !== false;
  const toggle = async () => {
    await update({ bgNameToggleEnabled: !on });
  };
  return (
    <div className="prefix-panel">
      <div className="prefix-head">
        <div>
          <div className="prefix-title">BG1/BG2 address toggle</div>
          <div className="prefix-sub">
            When the /spc cashback gate misses the floor, the worker can
            recover by editing the saved-address name suffix between
            &quot;(BG1)&quot; and &quot;(BG2)&quot; (or appending
            &quot;(BG1)&quot; the first time) and re-rendering checkout.
            Turn this off if the recovery is wasted time on your
            accounts (the buys still fail at cashback_gate) or you
            manage the suffix manually on Amazon. Takes effect on the
            next worker Start.
          </div>
        </div>
        <label
          className="flex items-center gap-2 cursor-pointer"
          title={on ? 'BG1/BG2 toggle recovery enabled' : 'Toggle recovery disabled — cashback misses fail fast'}
        >
          <Switch
            checked={on}
            onCheckedChange={() => void toggle()}
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

/* ============================================================
   Reset Auto-Buy defaults
   Single-click "back to factory" for the Auto-Buy section. The
   values written here are the user-validated defaults pinned in
   v0.13.93 (matching the DEFAULTS in src/main/settings.ts):
     buyWithFillers           true   (every account, plus the global flag)
     fillerCount              8
     fillerAttempts           ['eero']
     maxConcurrentBuys        5
     bypassPrimeCheck         false  (Prime check ON)
     bgNameToggleEnabled      false  (BG1/BG2 toggle OFF)
     autoRebuyOnCancelMax     2      (BG-side write via /api/user/auto-buy)
   ============================================================ */
function ResetAutoBuyDefaultsButton({ profiles }: { profiles: AmazonProfile[] }) {
  const { update } = useSettings();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [busy, setBusy] = useState(false);

  const onReset = () => {
    confirm({
      title: 'Reset Auto-Buy to defaults?',
      message:
        'Resets every Auto-Buy setting to the recommended defaults: ' +
        'Buy with Fillers on (every account), Filler Count 8, ' +
        'Filler Attempts [Eero], Parallel Buys 5, Prime check on, ' +
        'BG1/BG2 toggle off, Auto-rebuy on cancel 2. ' +
        'Other sections (Worker, BetterBG) are untouched.',
      confirmLabel: 'Reset',
      onConfirm: async () => {
        setBusy(true);
        try {
          // Flip every Amazon profile's per-account filler flag ON to
          // match the new global default — the BuyWithFillersPanel's
          // "all on?" derivation reads the per-account values, so this
          // keeps the master switch's UI consistent.
          for (const p of profiles) {
            try {
              await window.autog.profilesSetBuyWithFillers(p.email, true);
            } catch {
              /* per-account failure shouldn't block the global reset */
            }
          }
          await update({
            buyWithFillers: true,
            fillerCount: 8,
            fillerAttempts: ['eero'],
            maxConcurrentBuys: 5,
            bypassPrimeCheck: false,
            bgNameToggleEnabled: false,
          });
          // Auto-rebuy lives on BG.User, not settings.json. Best-effort
          // write — failure surfaces in the AutoRebuyOnCancelPanel's
          // error line on its next refresh.
          try {
            await window.autog.userAutoBuySet(2);
          } catch {
            /* see comment above */
          }
        } finally {
          setBusy(false);
        }
      },
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={onReset}
        disabled={busy}
        className="text-[11px] px-2 py-1 rounded border border-white/15 bg-white/[0.04] text-foreground/80 hover:bg-white/[0.08] hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
        title="Reset every Auto-Buy setting to the recommended defaults"
      >
        {busy ? 'Resetting…' : 'Reset to defaults'}
      </button>
      {confirmDialog}
    </>
  );
}
