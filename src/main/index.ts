import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IPC, type Settings } from '../shared/ipc.js';
import { createBGClient, type ServerPurchase } from '../bg/client.js';
import { addAmazonAddress, fetchAmazonAddress } from '../actions/addAddress.js';
import type { BGAddress } from '../shared/types.js';
import { startWorker, type WorkerHandle } from '../workflows/pollAndScrape.js';
import * as redisSubscriber from './redisSubscriber.js';
import { signalWake } from './redisWakeSignal.js';
import { startBgRelay } from './bgRelay.js';
import { addLogSink, logger } from '../shared/logger.js';
import {
  appendLogBatch as storeAppendLogBatch,
  clearAll as storeClearAll,
  clearCanceled as storeClearCanceled,
  clearFailed as storeClearFailed,
  createAttempt as storeCreateAttempt,
  deleteAttempt as storeDeleteAttempt,
  deleteAttempts as storeDeleteAttempts,
  flushAttempts as storeFlushAttempts,
  getAttempt as storeGetAttempt,
  listAttempts as storeListAttempts,
  pruneOlderThan,
  readLogs as storeReadLogs,
  updateAttempt as storeUpdateAttempt,
} from './jobStore.js';
import {
  classifyOrphans,
  STALE_PENDING_REASON,
} from './jobReconcile.js';
import { verifyOrder } from '../actions/verifyOrder.js';
import { fetchTracking } from '../actions/fetchTracking.js';
import { makeAttemptId } from '../shared/sanitize.js';
import type { JobAttempt, JobAttemptStatus, LogEvent } from '../shared/types.js';
import { BGApiError } from '../shared/errors.js';
import { loadIdentity, saveIdentity, clearIdentity } from './identity.js';
import { loadSettings, saveSettings } from './settings.js';
import { planSync } from './syncPlan.js';
import {
  loadProfiles,
  newProfile,
  removeProfile as removeProfileFn,
  reorderProfiles,
  updateProfile,
  upsertProfile,
} from './profiles.js';
import {
  addCard,
  updateCard,
  getCardNumberByLast4,
  getFullCardById,
  listCards,
  removeCard,
  exportCardsWithNumbers,
  replaceCardsFromSync,
} from './cardVault.js';
import {
  createChaseProfile,
  loadChaseProfiles,
  removeChaseProfile,
  updateChaseProfile,
  exportChaseProfilesForSync,
  replaceChaseProfilesFromSync,
} from './chaseProfiles.js';
import {
  attachChaseKeepalive,
  attachSessionAutoSave,
  attemptChaseAutoLogin,
  fetchChaseAccountSnapshot,
  openChaseSession,
  openChasePayPage,
  redeemAllToStatementCredit,
  type ChaseSession,
} from './chaseDriver.js';
import {
  clearChaseCredentials,
  getChaseCredentials,
  hasChaseCredentials,
  setChaseCredentials,
} from './chaseCredentials.js';
import {
  appendRedeemEntry,
  clearRedeemHistory,
  listRedeemHistory,
} from './chaseRedeemHistory.js';
import {
  clearAccountSnapshot,
  getAccountSnapshot,
  setAccountSnapshot,
} from './chaseAccountSnapshotStore.js';
import { openSession } from '../browser/driver.js';
import { snapshotDir, snapshotsDiskUsage, clearAllSnapshots } from '../browser/snapshot.js';
import { compareSemver } from '../shared/version.js';
import { isLoggedInAmazon, loginAmazon } from '../actions/loginAmazon.js';
import type { AmazonProfile, CreditCardSafe, CreditCardInput, CreditCardEdit, IdentityInfo, RendererStatus } from '../shared/types.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

app.setName('AmazonG');
// Override the OS-level process label so the macOS dock / Activity
// Monitor / Cmd-Tab show "AmazonG" instead of the underlying
// "Electron" binary name. Only matters in dev (`npm run dev`) where
// no .app wrapper exists; the packaged build's Info.plist already
// supplies CFBundleName from package.json's productName. Setting
// process.title is cheap and idempotent — also makes ps + top read
// "AmazonG" which is nicer for debugging.
process.title = 'AmazonG';

// When packaged, Playwright needs to find the Chromium binary that
// electron-builder bundled under `Resources/playwright-browsers`. The
// `installPlaywrightBrowsers.ts` prepackage script downloads into
// `build-browsers/` and extraResources ships it into the .app. This env
// var has to be set BEFORE any `require('playwright')` that triggers
// browser discovery (driver.ts imports it lazily at session time, so
// setting here is safe).
//
// We also set it when running from an app bundle even if Electron doesn't
// report isPackaged (e.g. debug builds), by detecting resourcesPath
// containing a playwright-browsers directory.
import { existsSync } from 'node:fs';

const bundledBrowsers = join(process.resourcesPath, 'playwright-browsers');
if (existsSync(bundledBrowsers)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = bundledBrowsers;
} else if (app.isPackaged) {
  // Packaged but browsers missing — log so we can diagnose.
  console.error(
    `[AmazonG] PLAYWRIGHT_BROWSERS_PATH target missing: ${bundledBrowsers}`
  );
}

let mainWindow: BrowserWindow | null = null;
let worker: WorkerHandle | null = null;
let identity: IdentityInfo | null = null;
let apiKey: string | null = null;
let lastError: string | null = null;

/**
 * Reference to the IPC handler's redeem function, captured during
 * registerIpcHandlers so the auto-redeem scheduler can invoke it
 * directly (without round-tripping through ipcRenderer.invoke).
 * Null until the IPC handlers register; the scheduler's tick checks
 * for null defensively.
 */
let triggerChaseRedeem:
  | ((id: string) => Promise<import('../shared/types.js').ChaseRedeemResult>)
  | null = null;

/** Interval handle for the auto-redeem scheduler tick, cleared on quit. */
let chaseAutoRedeemTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Handle for the BG.com fetch relay (long-poll loop, 6 concurrent
 * workers). Started when identity becomes available; stopped on
 * disconnect / quit. Null when not running.
 */
let bgRelayHandle: { stop: () => Promise<void> } | null = null;

/**
 * Tick once a minute through the Chase profile list, firing
 * performChaseRedeem on any profile whose schedule is due. Stamps
 * `autoRedeem.lastRunAt` regardless of outcome so a single attempt
 * counts as today's run (preventing retry-loop hammering even if the
 * redeem itself errored). Records the outcome on
 * `autoRedeem.lastRunResult` for the UI.
 *
 * Sequential, not concurrent — multiple Chase profiles all due at
 * the same minute fire one after another so they don't race the
 * userDataDir lock or BG SSO redirect handling.
 */
async function chaseAutoRedeemTick(): Promise<void> {
  if (!triggerChaseRedeem) return;
  const { selectDueProfiles } = await import('./chaseRedeemScheduler.js');
  const settings = await loadSettings().catch(() => null);
  const globalTime = settings?.chaseAutoRedeemTime ?? '15:00';
  const profiles = await loadChaseProfiles().catch(() => []);
  const due = selectDueProfiles(profiles, globalTime);
  if (due.length === 0) return;
  logger.info('chase.autoRedeem.tick', {
    count: due.length,
    ids: due.map((p) => p.id),
  });
  for (const p of due) {
    try {
      const result = await triggerChaseRedeem(p.id);
      const kind: 'ok' | 'no_points' | 'error' = result.ok
        ? 'ok'
        : result.kind === 'no_points'
          ? 'no_points'
          : 'error';
      const error = result.ok ? null : result.reason ?? null;
      // Re-read the profile in case it mutated mid-run (user
      // toggled the switch off, etc.) so the patch doesn't clobber
      // a fresh enabled-state change.
      const fresh = (await loadChaseProfiles()).find((x) => x.id === p.id);
      if (!fresh) continue;
      await updateChaseProfile(p.id, {
        autoRedeem: {
          enabled: fresh.autoRedeem?.enabled ?? false,
          time: fresh.autoRedeem?.time ?? '15:00',
          lastRunAt: new Date().toISOString(),
          lastRunResult: kind,
          lastRunError: error,
        },
      });
      logger.info('chase.autoRedeem.fired', {
        id: p.id,
        result: kind,
        ...(error ? { error } : {}),
      });
      // On success, report it to BG so the user gets an in-app
      // notification (+ web push) with the redeemed amount — the
      // schedule fires unattended, so this surfaces it without the
      // user opening the desktop app. Best-effort.
      if (result.ok && apiKey) {
        try {
          const settingsNow = await loadSettings();
          await createBGClient(
            settingsNow.bgBaseUrl,
            apiKey,
          ).reportChaseRedeem({
            profileLabel: fresh.label,
            amount: result.amount,
            pointsRedeemed: result.pointsRedeemed,
            orderNumber: result.orderNumber,
          });
        } catch (err) {
          logger.info('chase.autoRedeem.notify.skip', {
            id: p.id,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      logger.warn('chase.autoRedeem.tick.error', {
        id: p.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Push the updated profile list to the renderer so the Bank tab
  // reflects the new lastRunAt without a manual refresh.
  await broadcastChaseProfiles().catch(() => undefined);
}

async function broadcastChaseProfiles(): Promise<void> {
  const list = await loadChaseProfiles().catch(() => []);
  mainWindow?.webContents.send(IPC.evtChaseProfiles, list);
}

// User-driven Playwright sessions kept open for "Your Orders" windows. Keyed
// by Amazon profile email. We track these so repeated clicks focus the
// existing window instead of trying to launch another persistent context
// against the same (still-locked) userDataDir.
import type { DriverSession } from '../browser/driver.js';
const openOrderSessions = new Map<string, { session: DriverSession }>();

// In-flight Chase login cancellers. Keyed by chase profile id; the
// stored function closes the browser context + flips the local
// `aborted` flag so the awaiting handler returns a cancellation
// instead of a spurious "browser closed" error. Single-flight per
// profile (Chromium refuses to open the same user-data dir twice
// anyway).
const chaseLoginAborts = new Map<string, () => void>();

// User-driven Chase Chromium windows that aren't part of the login
// flow — currently just the Redeem Rewards page. Tracked per profile
// so a second click on Redeem Rewards focuses the existing window
// instead of trying to open another persistent context against the
// same userDataDir (Chromium refuses, throws). Cleared when the
// context's `close` event fires (user shut the window).
//
// Split into two maps by purpose so the wrong window doesn't get
// brought to front when the user clicks the other action (pass-4
// audit #7): a Pay click while a Rewards window is open used to
// surface the Rewards window because both shared one map. Each
// handler now checks its own map first (= bringToFront) and the
// other map second (= refuse with "another Chase window is open
// for this profile"). The userDataDir lock is still respected
// because both maps key on profileId and only one window can hold
// the lock at a time.
const chaseRewardsActionSessions = new Map<string, ChaseSession>();
const chasePayActionSessions = new Map<string, ChaseSession>();

// Coalesced log fan-out. Workers emit 50–200 events per buy phase; a naive
// sink would do that many IPCs and that many appendFile syscalls per profile
// per minute, which keeps the M-series chip out of its low-power state.
// Buffer for LOG_FLUSH_MS, then send one IPC carrying the batch and one
// appendFile per attempt. Hoisted to module scope so the before-quit hook
// can drain pending writes before the process exits.
const LOG_FLUSH_MS = 200;
const ipcLogBuffer: LogEvent[] = [];
const diskLogBuffers = new Map<string, LogEvent[]>();
let ipcFlushTimer: ReturnType<typeof setTimeout> | null = null;
let diskFlushTimer: ReturnType<typeof setTimeout> | null = null;

function flushIpcLogs(): void {
  if (ipcFlushTimer) {
    clearTimeout(ipcFlushTimer);
    ipcFlushTimer = null;
  }
  if (ipcLogBuffer.length === 0) return;
  const batch = ipcLogBuffer.splice(0, ipcLogBuffer.length);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.evtLog, batch);
  }
}

async function flushDiskLogs(): Promise<void> {
  if (diskFlushTimer) {
    clearTimeout(diskFlushTimer);
    diskFlushTimer = null;
  }
  const writes: Promise<void>[] = [];
  for (const [attemptId, bucket] of diskLogBuffers) {
    if (bucket.length === 0) continue;
    const batch = bucket.splice(0, bucket.length);
    writes.push(storeAppendLogBatch(attemptId, batch).catch(() => undefined));
  }
  diskLogBuffers.clear();
  await Promise.all(writes);
}

function status(): RendererStatus {
  return {
    connected: identity !== null,
    running: worker !== null,
    identity,
    lastError,
  };
}

function broadcastStatus(): void {
  mainWindow?.webContents.send(IPC.evtStatus, status());
}

async function broadcastProfiles(list?: AmazonProfile[]): Promise<void> {
  const payload = list ?? (await loadProfiles());
  mainWindow?.webContents.send(IPC.evtProfiles, payload);
}

/**
 * Push a single Amazon profile's displayName to BG so the dashboard's
 * Account column can render the human-friendly name. Best-effort:
 * silently no-ops when not connected to BG, and swallows transport
 * errors — the local rename UX must never block on this. Logs at
 * debug level so a BG hiccup is traceable without surfacing as a
 * user-visible warning.
 */
async function syncDisplayNameToBG(
  email: string,
  displayName: string | null,
): Promise<void> {
  if (!apiKey) return;
  try {
    const settings = await loadSettings();
    const bg = createBGClient(settings.bgBaseUrl, apiKey);
    await bg.setAmazonAccountDisplayName(email, displayName);
  } catch (err) {
    logger.debug('profile.displayName.sync.error', {
      email,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Push every locally-known profile's displayName to BG in one pass.
 * Called once on app start (after identity is loaded) so a brand-new
 * BG side picks up names from the user's existing AmazonG state
 * without them having to manually re-rename each profile. Sequential
 * to keep the desktop's outbound HTTP polite — there are typically
 * <20 accounts, so total time is bounded. Best-effort throughout.
 */
async function bulkSyncDisplayNamesToBG(): Promise<void> {
  if (!apiKey) return;
  let profiles: AmazonProfile[] = [];
  try {
    profiles = await loadProfiles();
  } catch {
    return;
  }
  if (profiles.length === 0) return;
  for (const p of profiles) {
    await syncDisplayNameToBG(p.email.toLowerCase(), p.displayName ?? null);
  }
}

/**
 * Cross-PC sync: fetch the AmazonAccount list from BG and create local
 * profile rows for any account on BG that isn't already in the local
 * profiles.json. Used at startup so a fresh AmazonG install on a new
 * machine pre-populates the Accounts page with email + displayName,
 * leaving the user just needing to click Login on each one.
 *
 * Conservative merge — only ever ADDS rows, never modifies or removes
 * existing local entries. Local-only state (loggedIn, lastLoginAt,
 * enabled, headless, buyWithFillers) is the source of truth for
 * already-known profiles. Best-effort: a network blip just leaves the
 * user with whatever's already on disk.
 */
async function pullAmazonAccountsFromBG(): Promise<void> {
  if (!apiKey) return;
  const settingsNow = await loadSettings().catch(() => null);
  if (!settingsNow) return;
  let bgList: { accounts: { email: string; displayName: string | null }[] };
  try {
    const bg = createBGClient(settingsNow.bgBaseUrl, apiKey);
    bgList = await bg.listAmazonAccounts();
  } catch (err) {
    logger.info('pullAmazonAccountsFromBG.skip', {
      reason: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (bgList.accounts.length === 0) return;

  const local = await loadProfiles().catch(() => [] as AmazonProfile[]);
  const localEmails = new Set(local.map((p) => p.email.toLowerCase()));

  let added = 0;
  for (const acc of bgList.accounts) {
    const email = acc.email.toLowerCase();
    if (localEmails.has(email)) continue;
    await upsertProfile(newProfile(email, acc.displayName ?? undefined));
    added++;
  }
  if (added > 0) {
    logger.info('pullAmazonAccountsFromBG.added', { count: added });
    await broadcastProfiles();
  }
}

/**
 * Push the user's payment cards + Buy-with-Fillers config to BG's
 * cross-device sync so other machines pick them up. Best-effort —
 * never throws; callers fire-and-forget. See src/app/api/autog/sync
 * on the BG side. A sync failure must never break the local
 * card/settings change that triggered it.
 */
async function pushSyncToBG(): Promise<void> {
  if (!apiKey) return;
  try {
    const settingsNow = await loadSettings();
    const cards = await exportCardsWithNumbers();
    // Account assignments, keyed by lowercased email:
    //   cardAssignments    — { email → cardId }   for cards
    //   addressAssignments — { email → BGAddress } for receiving addresses
    const profiles = await loadProfiles().catch(() => [] as AmazonProfile[]);
    const cardAssignments: Record<string, string> = {};
    const addressAssignments: Record<string, BGAddress> = {};
    for (const p of profiles) {
      if (p.cardId) cardAssignments[p.email.toLowerCase()] = p.cardId;
      if (p.bgAddress) addressAssignments[p.email.toLowerCase()] = p.bgAddress;
    }
    const chaseProfilesMeta = await exportChaseProfilesForSync().catch(
      () => [] as Awaited<ReturnType<typeof exportChaseProfilesForSync>>,
    );
    // Attach Chase login credentials (plaintext) so a second machine
    // can auto-fill the login form — only the OTP step stays manual.
    const chaseProfiles = await Promise.all(
      chaseProfilesMeta.map(async (p) => {
        const creds = await getChaseCredentials(p.id).catch(() => null);
        return creds
          ? { ...p, username: creds.username, password: creds.password }
          : p;
      }),
    );
    const bg = createBGClient(settingsNow.bgBaseUrl, apiKey);
    await bg.putSync({
      cards,
      cardAssignments,
      buyWithFillers: settingsNow.buyWithFillers,
      fillerAttempts: settingsNow.fillerAttempts,
      chaseProfiles,
      addressAssignments,
    });
    logger.info('sync.push.ok', {
      cards: cards.length,
      assignments: Object.keys(cardAssignments).length,
      addresses: Object.keys(addressAssignments).length,
      chaseProfiles: chaseProfiles.length,
    });
  } catch (err) {
    logger.info('sync.push.skip', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Pull the user's synced cards + Buy-with-Fillers config from BG and
 * apply them to local disk. Runs once at startup. Best-effort.
 *
 * The merge decision (seed when BG is empty, the empty-remote card-
 * wipe guard, which settings to apply) lives in the pure `planSync`
 * — see src/main/syncPlan.ts + tests/unit/syncPlan.test.ts. This
 * function just fetches the blob and executes the plan.
 */
async function pullSyncFromBG(): Promise<void> {
  if (!apiKey) return;
  let settingsNow: Settings;
  let blob;
  try {
    settingsNow = await loadSettings();
    blob = await createBGClient(settingsNow.bgBaseUrl, apiKey).getSync();
  } catch (err) {
    logger.info('sync.pull.skip', {
      reason: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const localCards = await listCards().catch(() => []);
  const localChaseProfiles = await loadChaseProfiles().catch(() => []);
  const plan = planSync(blob, localCards.length, localChaseProfiles.length);

  if (Object.keys(plan.settingsPatch).length > 0) {
    await saveSettings({ ...settingsNow, ...plan.settingsPatch });
  }
  if (plan.cards) {
    try {
      await replaceCardsFromSync(plan.cards);
    } catch (err) {
      logger.info('sync.pull.cards.skip', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Apply account→card and account→BG-address assignments — set each
  // local profile's cardId / bgAddress from the synced maps.
  if (plan.cardAssignments || plan.addressAssignments) {
    const localProfiles = await loadProfiles().catch(() => [] as AmazonProfile[]);
    const localEmails = new Set(localProfiles.map((p) => p.email.toLowerCase()));
    for (const [email, cardId] of Object.entries(plan.cardAssignments ?? {})) {
      if (localEmails.has(email)) {
        await updateProfile(email, { cardId }).catch(() => undefined);
      }
    }
    for (const [email, bgAddress] of Object.entries(
      plan.addressAssignments ?? {},
    )) {
      if (localEmails.has(email)) {
        await updateProfile(email, { bgAddress }).catch(() => undefined);
      }
    }
    await broadcastProfiles();
  }
  // Apply synced Chase profiles — mirror semantics, see
  // replaceChaseProfilesFromSync. Login session stays local.
  if (plan.chaseProfiles) {
    try {
      await replaceChaseProfilesFromSync(plan.chaseProfiles);
      // Apply synced login credentials, re-encrypted into this
      // machine's keychain. Field-preserving: a profile synced
      // without credentials leaves any local copy untouched (the
      // source device may simply have failed to decrypt its own).
      for (const p of plan.chaseProfiles) {
        if (p.username && p.password) {
          await setChaseCredentials(p.id, {
            username: p.username,
            password: p.password,
          }).catch(() => undefined);
        }
      }
      await broadcastChaseProfiles();
    } catch (err) {
      logger.info('sync.pull.chaseProfiles.skip', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (plan.pushLocal) await pushSyncToBG();
  if (plan.applied) {
    logger.info('sync.pull.applied', {
      cards: plan.cards?.length ?? 0,
      assignments: plan.cardAssignments
        ? Object.keys(plan.cardAssignments).length
        : 0,
      addresses: plan.addressAssignments
        ? Object.keys(plan.addressAssignments).length
        : 0,
      chaseProfiles: plan.chaseProfiles?.length ?? 0,
    });
    mainWindow?.webContents.send(IPC.evtSyncApplied);
  }
}

// Coalesce job-list broadcasts so a fan-out across N profiles doesn't
// fire 2N+ full-list IPC sends. 250ms trailing timer collapses burst
// updates further than the previous 100ms — not perceptibly less
// "live" to the user, but ~2.5× fewer renderer wake-ups (and the
// JobsTable re-renders + re-blurs that come with each one) during
// fan-outs across multiple profiles.
let jobsBroadcastTimer: NodeJS.Timeout | null = null;
function scheduleBroadcastJobs(): void {
  if (jobsBroadcastTimer) return;
  jobsBroadcastTimer = setTimeout(() => {
    jobsBroadcastTimer = null;
    void listMergedAttempts()
      .then((list) => mainWindow?.webContents.send(IPC.evtJobs, list))
      .catch(() => undefined);
  }, 250);
}

function toNumOrNull(v: string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function serverRowToJobAttempt(s: ServerPurchase): JobAttempt {
  return {
    attemptId: s.attemptId,
    jobId: s.jobId,
    amazonEmail: s.amazonEmail ?? '',
    phase: s.phase,
    dealKey: s.dealKey,
    dealId: s.dealId,
    dealTitle: s.dealTitle ?? null,
    productUrl: s.productUrl ?? '',
    maxPrice: toNumOrNull(s.maxPrice),
    price: toNumOrNull(s.price),
    quantity: s.quantity ?? null,
    cost: s.placedPrice ?? null,
    cashbackPct: s.placedCashbackPct ?? null,
    orderId: s.placedOrderId ?? null,
    status: s.status,
    error: s.error,
    // Surface filler-mode when BG marked the parent job viaFiller
    // (rebuys, filler-verify offshoots). Without this, server-only
    // rows — which is what shows up after the local attempt is
    // evicted from job-attempts.json by the 1000-row ring buffer or
    // the 30-day prune — flip to 'single' even though the buy
    // actually ran with fillers. NOTE: a fresh non-rebuy buy that
    // ran in filler mode purely because of the global buyWithFillers
    // toggle has parent.viaFiller=false on BG, so it still flips
    // post-prune; making that case durable needs an AutoBuyPurchase
    // column (separate migration).
    buyMode: s.viaFiller ? 'filler' : 'single',
    dryRun: false,
    trackingIds: s.trackingIds ?? null,
    // BG now serves fillerOrderIds in /api/autog/purchases. Read it so
    // the column survives the local 30-day prune — pre-fix the field
    // was hardcoded to null here, which silently dropped filler order
    // ids from the table once the local entry aged out. Empty array
    // when the server row is non-filler or hasn't been backfilled yet
    // (matches the type's "single-mode → []" convention).
    fillerOrderIds: s.fillerOrderIds ?? null,
    // Per-filler-order state-machine status (from BG's
    // FillerCancelTask table). Null on single-mode buys + on pre-
    // feature BG deployments that don't surface the field. JobsTable
    // colors chips per status.
    fillerCancelTasks: Array.isArray(s.fillerCancelTasks)
      ? s.fillerCancelTasks.map((t) => ({
          id: t.id,
          amazonOrderId: t.amazonOrderId,
          status: t.status,
          attempts: t.attempts,
        }))
      : null,
    productTitle: null,
    stage: null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/**
 * Merge server-sourced purchases (authoritative for cross-device state)
 * with the local attempts file (authoritative for dry-run rows and any
 * just-written row whose /status POST hasn't landed yet).
 *
 * Merge key is (jobId, amazonEmail) — BOTH sides know these fields, and
 * AutoBuyPurchase.id (server) ≠ makeAttemptId() (local), so we can't key
 * on attemptId. When both exist, we take the server row but keep the
 * local attemptId so "View logs" still resolves the on-disk JSONL file.
 *
 * If the server call fails (offline, 401, etc.) we fall back to local
 * only so the table keeps rendering.
 */
async function listMergedAttempts(): Promise<JobAttempt[]> {
  const local = await storeListAttempts();
  if (!apiKey) return local;

  let serverRows: ServerPurchase[] = [];
  try {
    const settings = await loadSettings();
    const bg = createBGClient(settings.bgBaseUrl, apiKey);
    serverRows = await bg.listPurchases(500);
  } catch (err) {
    logger.warn('listPurchases failed; falling back to local attempts', {
      err: err instanceof Error ? err.message : String(err),
    });
    return local;
  }

  const keyOf = (a: { jobId: string; amazonEmail: string | null }): string =>
    `${a.jobId}__${a.amazonEmail ?? '__none__'}`;

  const merged = new Map<string, JobAttempt>();
  for (const s of serverRows) {
    if (!s.amazonEmail) continue; // synthetic "no-attempt-yet" rows — skip
    merged.set(keyOf(s), serverRowToJobAttempt(s));
  }
  for (const l of local) {
    const k = keyOf(l);
    const existing = merged.get(k);
    if (existing) {
      // Prefer server trackingIds when non-empty. BG now returns [] for
      // purchases without any codes (since the Postgres column defaults
      // to an empty array), so a plain `??` would pick the empty array
      // over a local non-empty list and clobber a freshly-run manual
      // Fetch Tracking.
      const serverHasCodes = !!(existing.trackingIds && existing.trackingIds.length > 0);
      // Prefer local TERMINAL status (cancelled_by_amazon | failed) over
      // server's non-terminal status. The local-only verify path
      // (`jobsVerifyOrder` IPC handler from the dashboard's Re-verify
      // Pending button) flips the row to cancelled_by_amazon on disk
      // but doesn't POST to BG — so the server still says "verified"
      // until the next worker-claimed verify cycle. Without this guard
      // the merge silently clobbers the local cancellation back to
      // verified and the row stays in the Pending bucket. Local
      // 'verified' / 'completed' / 'awaiting_verification' do NOT win
      // here — those are intermediate and the server is authoritative.
      const preferLocalStatus =
        l.status === 'cancelled_by_amazon' || l.status === 'failed';
      merged.set(k, {
        ...existing,
        attemptId: l.attemptId,
        dryRun: l.dryRun,
        ...(preferLocalStatus
          ? { status: l.status, error: l.error ?? existing.error }
          : {}),
        trackingIds: serverHasCodes ? existing.trackingIds : l.trackingIds,
        // Keep a locally-captured retail price visible even if the
        // /status POST never persisted it on BG (older rows, transient
        // sync failure, or a buy whose confirmation parser didn't find
        // a final price — local still has the PDP fallback).
        cost: existing.cost ?? l.cost,
        // BG now derives buyMode from the parent AutoBuyJob.viaFiller
        // (set on rebuys + filler-verify offshoots). Either side
        // saying 'filler' is enough — local is authoritative for
        // fresh just-ran buys; server is authoritative once the
        // local attempt is evicted from job-attempts.json. Falling
        // through to 'single' only when both agree.
        buyMode:
          l.buyMode === 'filler' || existing.buyMode === 'filler'
            ? 'filler'
            : 'single',
        // For fillerOrderIds: prefer whichever side has a non-empty
        // list. Local is up-to-the-second (the buy just persisted them
        // before the /status POST landed), but BG is durable past the
        // local 30-day prune. After prune the local field is null/[],
        // so the server's snapshot wins. Same shape rule as trackingIds.
        fillerOrderIds:
          l.fillerOrderIds && l.fillerOrderIds.length > 0
            ? l.fillerOrderIds
            : (existing.fillerOrderIds ?? l.fillerOrderIds),
        // Per-filler-order cancel-state-machine status. Server is
        // always authoritative — it owns the FillerCancelTask table.
        // Local doesn't track per-task state.
        fillerCancelTasks: existing.fillerCancelTasks ?? l.fillerCancelTasks,
        productTitle: l.productTitle,
      });
    } else {
      merged.set(k, l);
    }
  }

  // Auto-prune local orphans in two passes (see jobReconcile.ts for the
  // pure classifier + thresholds):
  //
  // (a) Terminal orphans (failed | cancelled_by_amazon) with no BG
  //     match — drop entirely. BG either never persisted them or the
  //     user deleted them server-side (e.g. via the dashboard's
  //     "Delete cancelled & failed" button). 60s grace window
  //     protects against the race where /status hasn't yet synced a
  //     fresh local fail to BG.
  //
  // (b) Pending orphans (queued | in_progress | awaiting_verification)
  //     with no BG match AND older than 30 min — flip to 'failed'.
  //     Worker crashed mid-buy / app closed before /status reported /
  //     BG timed out the claim and another instance finished the work.
  //     Without this auto-flip the row sits stranded in 'queued' /
  //     'in_progress' forever (surfacing as "Active jobs" or Pending
  //     in the purchases table) until the user manually clicks "Sync
  //     with BG". 30-min window matches `jobsReconcileStuck` and is
  //     well past any normal buy time. We only mark locally — the
  //     manual "Sync with BG" button still handles BG-side
  //     `deletePurchases` cleanup separately, so this auto-path stays
  //     side-effect-free against BG. On the NEXT broadcast the
  //     now-failed row enters case (a) above and is pruned for good
  //     (or matched against BG if the server caught up). The merged
  //     map also gets bumped here so the row reflects 'failed' in the
  //     SAME response without waiting for the next broadcast cycle.
  const serverKeys = new Set(serverRows.map((s) => keyOf(s)));
  const now = Date.now();
  const { terminalOrphanIds: orphanIds, stalePendingIds } = classifyOrphans({
    local,
    serverKeys,
    now,
  });

  for (const id of orphanIds) {
    // Find the local row by attemptId to delete from the merged map.
    const row = local.find((l) => l.attemptId === id);
    if (row) merged.delete(keyOf(row));
  }
  for (const id of stalePendingIds) {
    const row = local.find((l) => l.attemptId === id);
    if (!row) continue;
    const k = keyOf(row);
    const existing = merged.get(k);
    if (existing) {
      merged.set(k, {
        ...existing,
        status: 'failed',
        error: STALE_PENDING_REASON,
        updatedAt: new Date(now).toISOString(),
      });
    }
  }

  if (orphanIds.length > 0) {
    await storeDeleteAttempts(orphanIds).catch((err) => {
      logger.warn('listMergedAttempts.orphanPrune.error', {
        count: orphanIds.length,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }

  if (stalePendingIds.length > 0) {
    logger.info('listMergedAttempts.stalePendingFlipped', {
      count: stalePendingIds.length,
    });
    // Persist sequentially via storeUpdateAttempt so each write goes
    // through the same JSON-store flush any normal status update uses.
    // Failures don't block the merge — the in-memory `merged` map
    // already reflects the flip, so the user sees the corrected status
    // this broadcast; on-disk store catches up next time if a write
    // missed.
    for (const attemptId of stalePendingIds) {
      await storeUpdateAttempt(attemptId, {
        status: 'failed',
        error: STALE_PENDING_REASON,
      }).catch((err) => {
        logger.warn('listMergedAttempts.stalePendingFlip.error', {
          attemptId,
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  // Respect the user's local "deleted from view" set. Server rows for
  // these ids otherwise rematerialize every merge because BG still
  // holds them. Also prune any ids whose rows are no longer in either
  // source so the set doesn't grow unbounded.
  const settingsNow = await loadSettings();
  const hidden = new Set(settingsNow.hiddenAttemptIds ?? []);
  if (hidden.size > 0) {
    const remaining: JobAttempt[] = [];
    const stillReferenced = new Set<string>();
    for (const a of merged.values()) {
      if (hidden.has(a.attemptId)) {
        stillReferenced.add(a.attemptId);
        continue;
      }
      remaining.push(a);
    }
    // Evict hidden ids that no longer appear anywhere — keeps the list
    // small as BG's 500-row window rotates older purchases out.
    if (stillReferenced.size !== hidden.size) {
      const pruned = settingsNow.hiddenAttemptIds.filter((id) => stillReferenced.has(id));
      await saveSettings({ ...settingsNow, hiddenAttemptIds: pruned });
    }
    return remaining.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  return Array.from(merged.values()).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}

/**
 * Resolve every local attempt that was actively executing (`in_progress`)
 * when the worker stopped or crashed. Routes each one based on the
 * `stage` flag the worker writes around the Place Order click:
 *
 *   - stage === 'placing' → "unknown outcome" zone. Amazon may or
 *     may not have accepted the click, so auto-retry would risk a
 *     duplicate order. Flip to `failed` with a manual-review error
 *     and POST per-purchase failure to BG so the dashboard shows it.
 *
 *   - stage !== 'placing' → safe to retry from scratch. Reset the
 *     local row to `queued` and call BG's /requeue so the job goes
 *     back into the claim queue immediately (bypasses BG's 10-min
 *     stale-claim timeout). Worker picks it up on next poll.
 *
 * `queued` attempts are intentionally untouched — the corresponding
 * BG job was never claimed by this run, so the natural claim cycle
 * will re-issue it on restart.
 *
 * Called from every stop path: the Stop button, app close / before-quit,
 * disconnect, and startup (to recover crash casualties). Idempotent.
 *
 * We don't await the in-flight worker loop before running this sweep.
 * Any natural failure write that lands afterwards (e.g. a Playwright
 * "Target closed" error caught by runForProfile) will overwrite our
 * entry with the true reason — "latest update wins" is correct.
 */
async function abortPendingAttempts(reason: string): Promise<void> {
  const all = await storeListAttempts();
  const running = all.filter((a) => a.status === 'in_progress');
  if (running.length === 0) return;

  const unsafe = running.filter((a) => a.stage === 'placing');
  const safe = running.filter((a) => a.stage !== 'placing');
  logger.info('abort.pending.sweep.start', {
    count: running.length,
    unsafe: unsafe.length,
    safe: safe.length,
    reason,
  });

  const manualReviewMsg = `${reason} — stopped mid-Place-Order; Amazon may or may not have accepted the order, manual review required`;

  for (const a of unsafe) {
    await storeUpdateAttempt(a.attemptId, {
      status: 'failed',
      error: manualReviewMsg,
    }).catch(() => undefined);
  }
  for (const a of safe) {
    // Reset cleanly so the next claim produces a fresh attempt in
    // the same row. Clear cost/cashback/orderId too — those came
    // from the abandoned run and don't apply to a fresh retry.
    await storeUpdateAttempt(a.attemptId, {
      status: 'queued',
      error: null,
      stage: null,
      cost: null,
      cashbackPct: null,
      orderId: null,
    }).catch(() => undefined);
  }

  if (apiKey) {
    const settings = await loadSettings();
    const bg = createBGClient(settings.bgBaseUrl, apiKey);

    // Unsafe rows: report failure to BG so the dashboard flags them.
    const unsafeByJob = new Map<string, JobAttempt[]>();
    for (const a of unsafe) {
      const arr = unsafeByJob.get(a.jobId) ?? [];
      arr.push(a);
      unsafeByJob.set(a.jobId, arr);
    }
    const queuedJobIds = new Set(
      all.filter((a) => a.status === 'queued').map((a) => a.jobId),
    );
    for (const [jobId, items] of unsafeByJob) {
      const phase = items[0]!.phase;
      const jobStatus = queuedJobIds.has(jobId) ? ('partial' as const) : ('failed' as const);
      const body =
        phase === 'buy'
          ? {
              status: jobStatus,
              error: manualReviewMsg,
              purchases: items.map((a) => ({
                amazonEmail: a.amazonEmail,
                status: 'failed' as const,
                error: manualReviewMsg,
              })),
            }
          : { status: jobStatus, error: manualReviewMsg };
      try {
        await bg.reportStatus(jobId, body);
      } catch (err) {
        logger.warn('abort.bg.report.error', {
          jobId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Safe rows: requeue on BG so the worker can re-claim without
    // waiting the 10-minute stale-claim timeout. One requeue per
    // unique jobId — multiple profiles on the same job share one job
    // row on BG, so one call unblocks all of them.
    const safeJobIds = new Set(safe.map((a) => a.jobId));
    for (const jobId of safeJobIds) {
      try {
        await bg.requeueJob(jobId);
      } catch (err) {
        logger.warn('abort.bg.requeue.error', {
          jobId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  scheduleBroadcastJobs();
  logger.info('abort.pending.sweep.done', {
    count: running.length,
    unsafe: unsafe.length,
    safe: safe.length,
  });
}

function profileDir(): string {
  return join(app.getPath('userData'), 'amazon-profiles');
}

const ONBOARDING_SIZE = { width: 500, height: 580 } as const;
const APP_SIZE = { width: 1800, height: 1150 } as const;

/** Icon path for dev runs only. Packaged builds get the icon from
 *  the .app bundle (electron-builder bakes resources/icon.icns into
 *  Contents/Resources/), so we don't need to set anything at runtime
 *  there. Returns null when packaged or when the file is missing,
 *  letting callers no-op cleanly. */
function devIconPath(): string | null {
  if (app.isPackaged) return null;
  const p = join(__dirname, '../../resources/icon.png');
  return existsSync(p) ? p : null;
}

function createWindow(): void {
  const connected = identity !== null;
  const size = connected ? APP_SIZE : ONBOARDING_SIZE;
  const icon = devIconPath();
  mainWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: connected ? 1100 : size.width,
    minHeight: connected ? 700 : size.height,
    resizable: connected,
    maximizable: connected,
    fullscreenable: connected,
    title: 'AmazonG',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: '#f8fafc',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Chromium's spellcheck runs a background dictionary load + scan
      // on every editable text input. AmazonG only has the search bar,
      // a few prefix inputs, and account-label inputs — none of them
      // need spellcheck. Default-true cost is small but constant; off
      // is free and shaves a process worker.
      spellcheck: false,
      // Default is true; setting explicitly so a future copy-paste of
      // this block doesn't accidentally flip it. Throttling means a
      // hidden window's setInterval / requestAnimationFrame go nearly
      // idle — load-bearing for our paused-when-hidden contract.
      backgroundThrottling: true,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function resizeToConnected(): void {
  if (!mainWindow) return;
  mainWindow.setResizable(true);
  mainWindow.setMaximizable(true);
  mainWindow.setFullScreenable(true);
  mainWindow.setMinimumSize(1100, 700);
  mainWindow.setSize(APP_SIZE.width, APP_SIZE.height, true);
  mainWindow.center();
}

function resizeToOnboarding(): void {
  if (!mainWindow) return;
  mainWindow.setMinimumSize(ONBOARDING_SIZE.width, ONBOARDING_SIZE.height);
  mainWindow.setSize(ONBOARDING_SIZE.width, ONBOARDING_SIZE.height, true);
  mainWindow.setResizable(false);
  mainWindow.setMaximizable(false);
  mainWindow.setFullScreenable(false);
  mainWindow.center();
}

/**
 * Start the polling worker with the current persisted settings + identity.
 * Called from the workerStart IPC handler AND from the auto-start hook
 * on app launch when settings.autoStartWorker is on.
 *
 * No-op if the worker is already running. Throws if there's no
 * connected BG identity yet — caller decides whether to surface that.
 */
/**
 * Idempotent start for the BG.com fetch relay. Spawns 6 concurrent
 * long-poll workers; each pulls one RemoteFetchJob from BG, executes
 * it from this machine's IP, and posts the response back. Ignored
 * when already running OR when not connected to BG.
 */
async function startBgRelayNow(): Promise<void> {
  if (bgRelayHandle) return;
  if (!apiKey) return;
  const settings = await loadSettings();
  const bg = createBGClient(settings.bgBaseUrl, apiKey);
  bgRelayHandle = startBgRelay({ bg });
  logger.info('bgRelay.started');
}

async function startWorkerNow(): Promise<void> {
  if (worker) return;
  if (!apiKey) throw new Error('not connected');
  const settings = await loadSettings();
  const bg = createBGClient(settings.bgBaseUrl, apiKey);
  worker = startWorker({
    bg,
    userDataRoot: profileDir(),
    debugDir: join(app.getPath('userData'), 'debug-screenshots'),
    snapshotOnFailure: settings.snapshotOnFailure,
    snapshotGroups: settings.snapshotGroups,
    headless: settings.headless,
    buyDryRun: settings.buyDryRun,
    buyWithFillers: settings.buyWithFillers,
    minCashbackPct: settings.minCashbackPct,
    allowedAddressPrefixes: settings.allowedAddressPrefixes,
    // Default true (legacy behavior); the user can dial off via
    // Settings → Accounts. Read at worker-start time — to retune you
    // need to bounce the worker (matches how minCashbackPct and the
    // address prefixes work today).
    bgNameToggleEnabled: settings.bgNameToggleEnabled !== false,
    // Hot-reload parallelism settings per claim — Settings page
    // changes (Parallel buys + Filler add-to-cart speed) take effect
    // on the next deal without requiring a worker restart.
    loadParallelism: async () => {
      const s = await loadSettings();
      return {
        maxConcurrentBuys: s.maxConcurrentBuys,
        fillerAttempts: s.fillerAttempts,
        surgicalCashbackRecovery: s.experimental?.surgicalCashbackRecovery === true,
      };
    },
    listEligibleProfiles: async () => {
      // Returns ALL signed-in profiles, including disabled ones. Disabling
      // an account blocks new buys but lets verify and fetch_tracking
      // continue running for that account's in-flight orders (otherwise a
      // mid-day disable would orphan every awaiting_verification /
      // pending_tracking row for that account). The buy-vs-lifecycle
      // split is enforced in handleJob: buy-phase fans out only to
      // `enabled` accounts, lifecycle phases use this list as-is.
      const list = await loadProfiles();
      return list.filter((p) => p.loggedIn);
    },
    markProfileSignedOut: async (email: string) => {
      // Worker → main bridge: verify / fetch_tracking phases detected
      // Amazon's /ap/signin redirect on this profile's HTTP requests,
      // so the cached `loggedIn: true` flag is stale. Flip it and
      // broadcast so the renderer's "Signed out" pill appears
      // immediately on the JobsTable + Accounts tab — same channel
      // the manual Refresh and Sign-in flows use.
      await updateProfile(email, { loggedIn: false });
      await broadcastProfiles();
    },
    // Lets the worker see Chromium contexts opened elsewhere in the
    // app (currently just the "View Order" click). Without this, a
    // manual force-verify while the user still has an order tab open
    // fails with "profile in use by another open window" — Chromium's
    // SingletonLock on the userDataDir only permits one process per
    // profile. Reusing the existing context avoids that lock entirely.
    findExistingSession: (email) =>
      openOrderSessions.get(email)?.session ?? null,
    // Auto-handle Amazon's "Verify your card" challenge: look up the
    // full card number from the encrypted local vault by its last 4.
    // Returns null when no card matches → worker falls back to the
    // legacy action_required fail.
    resolveCardNumber: (last4: string) => getCardNumberByLast4(last4),
    // Resolve the account's assigned vault card for the checkout
    // payment auto-add. Returns null when the id is unknown.
    resolveCardById: (id: string) => getFullCardById(id),
    jobAttempts: {
      async create(partial) {
        try {
          const a = await storeCreateAttempt(partial);
          scheduleBroadcastJobs();
          return a;
        } catch (err) {
          // Many worker call sites do `.catch(() => undefined)` on
          // these store writes — a failure here previously vanished
          // with zero signal, letting on-disk state silently diverge
          // from memory (verify could then miss filler context).
          // Log centrally, then rethrow so the existing call-site
          // contract is unchanged.
          logger.warn('jobAttempts.create.failed', {
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      },
      async update(attemptId, patch, opts) {
        try {
          const a = await storeUpdateAttempt(attemptId, patch, opts);
          scheduleBroadcastJobs();
          return a;
        } catch (err) {
          logger.warn('jobAttempts.update.failed', {
            attemptId,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      },
      get: storeGetAttempt,
      async recentOrderIdsForEmail(amazonEmail, withinMs) {
        try {
          const all = await storeListAttempts();
          const cutoffMs = Date.now() - withinMs;
          const emailLower = amazonEmail.toLowerCase();
          const ids: string[] = [];
          for (const a of all) {
            if (a.amazonEmail?.toLowerCase() !== emailLower) continue;
            const created = new Date(a.createdAt).getTime();
            if (!Number.isFinite(created) || created < cutoffMs) continue;
            if (a.orderId) ids.push(a.orderId);
            if (Array.isArray(a.fillerOrderIds)) {
              for (const f of a.fillerOrderIds) {
                if (typeof f === 'string' && f) ids.push(f);
              }
            }
          }
          return Array.from(new Set(ids));
        } catch {
          return [];
        }
      },
    },
  });
  lastError = null;
  broadcastStatus();

  // Path C: start the Redis pub/sub subscriber if the user has
  // opted in. Failure is non-fatal — the scheduler's idle wait
  // race still works; the wake side just never fires.
  if (settings.useRedisPush === true) {
    await redisSubscriber
      .start({
        fetchTokenAndChannel: () => bg.getRedisToken(),
        onWake: () => signalWake(),
        onDuplicateInstanceWarning: () => {
          logger.warn('worker.duplicate_instance.detected', {
            note: 'Another AmazonG instance appears active for this user. The atomic claim prevents duplicate orders, but two instances polling the same queue waste resources. Stop one to clean up.',
          });
        },
        onStatus: (s, detail) =>
          logger.info('worker.redisSubscriber.status', { status: s, detail }),
      })
      .catch((err) => {
        logger.warn('worker.redisSubscriber.start_failed', {
          error: err instanceof Error ? err.message : String(err),
          note: 'Falling back to polling. Safety-net poll still active.',
        });
      });
  }
}

app.whenReady().then(async () => {
  // Dev-mode dock icon. Packaged builds inherit the icon from the
  // .app bundle's Info.plist; running `npm run dev` doesn't, so the
  // dock would otherwise show the generic Electron mark.
  const devIcon = devIconPath();
  if (devIcon && process.platform === 'darwin') {
    app.dock?.setIcon(devIcon);
  }

  // Per-attempt log routing: callers can pass `attemptId` directly (wins
  // over jobId+profile) — verify/fetch_tracking phases roll the BUY
  // attempt row forward, so their logs need to land on the buy row, not
  // on a phantom file derived from their own jobId.
  // Both sinks coalesce via the module-level buffers; see flushIpcLogs /
  // flushDiskLogs and the before-quit drain.
  addLogSink((ev) => {
    ipcLogBuffer.push(ev);
    if (!ipcFlushTimer) ipcFlushTimer = setTimeout(flushIpcLogs, LOG_FLUSH_MS);
  });
  addLogSink((ev) => {
    const data = ev.data as Record<string, unknown> | undefined;
    const explicit = typeof data?.attemptId === 'string' ? data.attemptId : null;
    let attemptId: string | null = explicit;
    if (!attemptId) {
      const jobId = typeof data?.jobId === 'string' ? data.jobId : null;
      const profile = typeof data?.profile === 'string' ? data.profile : null;
      if (!jobId || !profile) return;
      attemptId = makeAttemptId(jobId, profile);
    }
    let bucket = diskLogBuffers.get(attemptId);
    if (!bucket) {
      bucket = [];
      diskLogBuffers.set(attemptId, bucket);
    }
    bucket.push(ev);
    if (!diskFlushTimer) diskFlushTimer = setTimeout(flushDiskLogs, LOG_FLUSH_MS);
  });

  // Drop attempts older than 30 days at startup so the table stays manageable.
  await pruneOlderThan(Date.now() - 30 * 24 * 60 * 60 * 1000).catch(() => 0);

  const stored = await loadIdentity();
  if (stored) {
    identity = stored.identity;
    apiKey = stored.apiKey;
  }

  registerIpcHandlers();
  createWindow();
  broadcastStatus();

  // Anything still queued / in_progress at launch is a crash casualty
  // from a previous session — the worker isn't running yet, nothing is
  // going to finish those attempts on its own. Mark them failed so the
  // Jobs table doesn't show stale "Pending" rows forever.
  await abortPendingAttempts('AmazonG exited mid-run (recovered at startup)').catch(
    (err) => logger.warn('abort.startup.error', { error: String(err) }),
  );

  // Auto-start the worker if the setting is on AND we have a connected
  // identity. Wrap in try/catch so a missing-identity case (e.g. the user
  // disconnected, then enabled auto-start, then relaunched) doesn't crash
  // the launch — we just log and let them flip Start manually.
  try {
    const settings = await loadSettings();
    if (settings.autoStartWorker && apiKey) {
      logger.info('worker.autostart');
      await startWorkerNow();
    }
  } catch (err) {
    logger.warn('worker.autostart.error', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Auto-enqueue scheduler is removed in favor of BetterBG's Auto Trigger
  // (per-user schedule configured in the BG dashboard). Keep imports
  // compiling but never start the loop — pre-existing users with an
  // enabled flag in settings.json no longer have it run silently.

  // Bidirectional Amazon-account sync at startup.
  //
  //  1. Pull from BG  — pre-populate local profiles.json with any
  //     AmazonAccount rows that exist on BG but not on this machine.
  //     Lets the user move between PCs and have all their account
  //     emails + names already there; they just click Login per
  //     account to attach a fresh local browser session.
  //  2. Push to BG    — push every local profile's displayName up so
  //     BG's Account column can render the friendly name. Idempotent
  //     for already-synced rows. Catches users who renamed offline.
  //
  // Both detached from the whenReady chain via void — no reason to
  // block window creation on a network round-trip. Pull runs first
  // so the push has the merged list to operate on.
  void (async () => {
    await pullSyncFromBG();
    await pullAmazonAccountsFromBG();
    await bulkSyncDisplayNamesToBG();
  })();

  // BG.com fetch relay — long-polls /api/autog/remote-fetch/claim
  // and executes BG.com fetches from this machine's IP. Started
  // here when identity was loaded from disk on launch (so an
  // already-connected user picks up relay work without having to
  // re-paste their key).
  if (apiKey) {
    void startBgRelayNow();
  }

  // Auto-redeem scheduler — ticks every 60s, fires
  // performChaseRedeem on profiles whose schedule is due. Cheap loop:
  // single profiles.json read + an in-memory filter when nothing's
  // due (most ticks). Cleared in before-quit.
  // Run an immediate first tick after a small delay so a user who
  // launches the app right at their scheduled time doesn't wait up
  // to a full minute for the scheduler's first sweep.
  setTimeout(() => {
    void chaseAutoRedeemTick();
  }, 5_000);
  chaseAutoRedeemTimer = setInterval(() => {
    void chaseAutoRedeemTick();
  }, 60_000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  // Close the worker's Chromium processes AND any "Your Orders" / Order-ID
  // click windows when the app's UI goes away — otherwise those Chromiums
  // stay visible as orphan windows (especially on macOS, where the app
  // stays alive after the main window closes).
  try {
    await closeAllChromiumSessions();
  } catch (err) {
    logger.warn('app.windows.cleanup.error', { error: String(err) });
  }
  if (process.platform !== 'darwin') app.quit();
});

/**
 * Close every Playwright-launched Chromium context we own so they don't
 * linger as zombie windows after the app quits. Covers the worker's
 * per-profile sessions plus the "Your Orders" / Order-ID click sessions
 * (openOrderSessions), and any other long-lived sessions we spawn.
 */
async function closeAllChromiumSessions(): Promise<void> {
  const hadWorker = worker !== null;
  if (worker) {
    try {
      await worker.stop();
    } catch (err) {
      logger.warn('worker.stop.error', { error: String(err) });
    }
    await redisSubscriber.stop().catch(() => undefined);
    worker = null;
  }
  if (hadWorker) {
    await abortPendingAttempts('AmazonG closed mid-run').catch((err) => {
      logger.warn('abort.pending.error', { error: String(err) });
    });
  }
  const orderSessions = Array.from(openOrderSessions.values());
  openOrderSessions.clear();
  await Promise.allSettled(
    orderSessions.map(async ({ session }) => {
      try {
        await session.close();
      } catch (err) {
        logger.warn('amazon.orders.close.error', { error: String(err) });
      }
    }),
  );
}

// Intercept the first quit, run cleanup, then quit for real. Without this
// hook the Playwright Chromium processes (each profile's persistent
// context) outlive the Electron app and stay visible as orphan windows.
//
// Hard deadline: cleanup is bounded at 2s. If the relay/Chromium tear-down
// hangs (e.g. a wedged BG long-poll, a Chromium context refusing to close),
// we exit anyway — the OS reaps the orphans. Without this cap, a single
// stuck task can make the app feel impossible to force-quit.
let quittingCleanly = false;
const QUIT_CLEANUP_DEADLINE_MS = 2_000;
app.on('before-quit', async (e) => {
  if (quittingCleanly) return;
  e.preventDefault();
  // Stop the auto-redeem scheduler so a tick mid-shutdown can't fire
  // an Amazon-style retry against a context we're about to tear down.
  if (chaseAutoRedeemTimer) {
    clearInterval(chaseAutoRedeemTimer);
    chaseAutoRedeemTimer = null;
  }

  const cleanup = (async () => {
    // Stop the BG.com fetch relay — aborts in-flight long-polls so
    // workers exit immediately instead of waiting on a 25s hold.
    if (bgRelayHandle) {
      await bgRelayHandle.stop().catch(() => undefined);
      bgRelayHandle = null;
    }
    try {
      await closeAllChromiumSessions();
    } catch (err) {
      logger.warn('app.quit.cleanup.error', { error: String(err) });
    }
    // Flush any pending (debounced) attempt-row writes. Without this a
    // quit / restart abandons jobStore's in-memory cache and every row
    // not yet on disk is lost — the ghost-order bug (placed order,
    // zero local trace). Awaited so the write completes before exit.
    try {
      await storeFlushAttempts();
    } catch {
      // best-effort — never block shutdown on this
    }
    // Drain buffered logs before exit. The IPC drain is best-effort (the
    // renderer may already be torn down); the disk drain is awaited so
    // the last <200ms of events survive the shutdown.
    flushIpcLogs();
    try {
      await flushDiskLogs();
    } catch {
      // Already swallowed inside flushDiskLogs; defensive double-catch.
    }
  })();

  const deadline = new Promise<'deadline'>((resolve) =>
    setTimeout(() => resolve('deadline'), QUIT_CLEANUP_DEADLINE_MS),
  );
  const winner = await Promise.race([cleanup.then(() => 'clean' as const), deadline]);
  if (winner === 'deadline') {
    logger.warn('app.quit.cleanup.timeout', { ms: QUIT_CLEANUP_DEADLINE_MS });
  }
  quittingCleanly = true;
  app.quit();
});

function registerIpcHandlers(): void {
  ipcMain.handle(IPC.identityGet, () => identity);

  ipcMain.handle(IPC.identityConnect, async (_e, key: string): Promise<IdentityInfo> => {
    const settings = await loadSettings();
    const bg = createBGClient(settings.bgBaseUrl, key);
    let me: IdentityInfo;
    try {
      me = await bg.me();
    } catch (err) {
      throw friendlyConnectError(err);
    }
    identity = me;
    apiKey = key;
    lastError = null;
    await saveIdentity({ apiKey: key, identity: me });
    resizeToConnected();
    broadcastStatus();
    // Start the BG.com fetch relay now that we have a valid AutoG
    // key. Relay long-polls /api/autog/remote-fetch/claim and
    // executes BG.com fetches from this machine's IP. Idempotent —
    // skip if already running (e.g. user re-connected without
    // disconnecting first).
    void startBgRelayNow();
    return me;
  });

  ipcMain.handle(IPC.identityDisconnect, async () => {
    if (worker) {
      await worker.stop();
      worker = null;
      await redisSubscriber.stop().catch(() => undefined);
      await abortPendingAttempts('stopped by user (disconnect)');
    }
    // Stop the relay loop so we don't keep polling /claim with a
    // dead key. Restarted on the next connect.
    if (bgRelayHandle) {
      await bgRelayHandle.stop().catch(() => undefined);
      bgRelayHandle = null;
    }
    identity = null;
    apiKey = null;
    await clearIdentity();
    resizeToOnboarding();
    broadcastStatus();
  });

  ipcMain.handle(
    IPC.fetchStatsGet,
    async (_e, range: 'today' | '7d' | 'lifetime') => {
      if (!apiKey) return null;
      const settings = await loadSettings();
      const bg = createBGClient(settings.bgBaseUrl, apiKey);
      return bg.getFetchStatsSummary(range).catch(() => null);
    },
  );

  ipcMain.handle(IPC.workerStart, () => startWorkerNow());

  ipcMain.handle(IPC.workerStop, async () => {
    if (!worker) return;
    await worker.stop();
    worker = null;
    await redisSubscriber.stop().catch(() => undefined);
    await abortPendingAttempts('stopped by user');
    broadcastStatus();
  });

  ipcMain.handle(IPC.statusGet, () => status());

  ipcMain.handle(IPC.settingsGet, () => loadSettings());

  ipcMain.handle(IPC.settingsSet, async (_e, partial: Partial<Settings>) => {
    const current = await loadSettings();
    const merged = { ...current, ...partial };
    await saveSettings(merged);
    // hiddenAttemptIds feeds listMergedAttempts; toggling it must
    // re-broadcast so rows appear/disappear without a manual refresh.
    if (partial.hiddenAttemptIds !== undefined) scheduleBroadcastJobs();
    // Buy-with-Fillers config is cross-device synced — push on change.
    if (
      partial.buyWithFillers !== undefined ||
      partial.fillerAttempts !== undefined
    ) {
      void pushSyncToBG();
    }
    return merged;
  });

  ipcMain.handle(IPC.openExternal, async (_e, url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('invalid url');
    await shell.openExternal(url);
  });

  ipcMain.handle(IPC.appVersion, () => app.getVersion());

  ipcMain.handle(IPC.versionCheck, async () => {
    const current = app.getVersion();
    const platformKey =
      process.platform === 'darwin' ? 'darwin' :
      process.platform === 'win32' ? 'win32' :
      process.platform === 'linux' ? 'linux' : null;
    if (!apiKey) {
      const error = 'not connected to BG — paste a Secret Key in Settings';
      logger.warn('version.check.skip.no_apikey', {});
      return { updateAvailable: false, latest: null, current, downloadUrl: null, error };
    }
    try {
      const settings = await loadSettings();
      const bg = createBGClient(settings.bgBaseUrl, apiKey);
      const info = await bg.checkVersion();
      if (!info.latestVersion) {
        const error = `BG returned no version (manifest empty or malformed at ${settings.bgBaseUrl}/api/autog/version)`;
        logger.warn('version.check.empty_manifest', { bgBaseUrl: settings.bgBaseUrl });
        return { updateAvailable: false, latest: null, current, downloadUrl: null, error };
      }
      const updateAvailable = compareSemver(info.latestVersion, current) > 0;
      const urls = info.downloadUrls ?? {};
      const downloadUrl = (platformKey && urls[platformKey]) || urls.darwin || null;
      logger.info('version.check.ok', {
        current,
        latest: info.latestVersion,
        updateAvailable,
      });
      return {
        updateAvailable,
        latest: info.latestVersion,
        current,
        downloadUrl,
        error: null,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.warn('version.check.error', { error });
      return {
        updateAvailable: false,
        latest: null,
        current,
        downloadUrl: null,
        error: `version check failed: ${error.slice(0, 200)}`,
      };
    }
  });

  // If settings are updated while the worker is running (e.g. prefixes or
  // dry-run), restart the worker so it picks up the new config on the next
  // claim. Keeps "Save" in settings feel live without manual Stop/Start.

  ipcMain.handle(IPC.profilesList, () => loadProfiles());

  ipcMain.handle(
    IPC.profilesAdd,
    async (_e, email: string, displayName?: string): Promise<AmazonProfile[]> => {
      const clean = email.trim().toLowerCase();
      if (!clean) throw new Error('email required');
      const name = displayName?.trim() || undefined;
      const list = await upsertProfile(newProfile(clean, name));
      await broadcastProfiles(list);
      // Push the name to BG so the dashboard's Account column can
      // render it. Best-effort — a failed sync (offline, no AutoG
      // key, BG hiccup) must not break the local add UX.
      void syncDisplayNameToBG(clean, name ?? null);
      return list;
    },
  );

  ipcMain.handle(IPC.profilesRemove, async (_e, email: string) => {
    const list = await removeProfileFn(email);
    await broadcastProfiles(list);
    // Cross-PC sync: also drop the row on BG so the next
    // pullAmazonAccountsFromBG on this or another machine doesn't
    // resurrect it. Best-effort — local removal is authoritative
    // for "user wants this gone right now," even if the BG sync
    // fails (offline, no AutoG key). Worst case: row reappears on
    // next pull and the user re-removes.
    if (apiKey) {
      try {
        const settingsNow = await loadSettings();
        const bg = createBGClient(settingsNow.bgBaseUrl, apiKey);
        await bg.removeAmazonAccount(email.toLowerCase());
      } catch (err) {
        logger.warn('profilesRemove.bgSync.error', {
          email,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return list;
  });

  ipcMain.handle(IPC.profilesSetEnabled, async (_e, email: string, enabled: boolean) => {
    const list = await updateProfile(email, { enabled });
    await broadcastProfiles(list);
    return list;
  });

  ipcMain.handle(
    IPC.profilesSetAutoBuy,
    async (_e, email: string, autoBuy: boolean) => {
      const list = await updateProfile(email, { autoBuy });
      await broadcastProfiles(list);
      return list;
    },
  );

  ipcMain.handle(
    IPC.profilesSetHeadless,
    async (_e, email: string, headless: boolean) => {
      const list = await updateProfile(email, { headless });
      await broadcastProfiles(list);
      return list;
    },
  );

  ipcMain.handle(
    IPC.profilesSetBuyWithFillers,
    async (_e, email: string, buyWithFillers: boolean) => {
      const list = await updateProfile(email, { buyWithFillers });
      await broadcastProfiles(list);
      return list;
    },
  );

  ipcMain.handle(
    IPC.profilesRename,
    async (_e, email: string, displayName: string | null) => {
      const clean = displayName?.trim() || null;
      const list = await updateProfile(email, { displayName: clean });
      await broadcastProfiles(list);
      void syncDisplayNameToBG(email.toLowerCase(), clean);
      return list;
    },
  );

  ipcMain.handle(
    IPC.profilesReorder,
    async (_e, orderedEmails: string[]) => {
      const list = await reorderProfiles(orderedEmails);
      await broadcastProfiles(list);
      return list;
    },
  );

  /**
   * Deals catalog — public BetterBG endpoint scoped to Amazon. Doesn't
   * use the user's AutoG key: the endpoint is gated by a shared
   * `x-api-key: pepe-gang` that's safe to ship with the app (it's
   * spelled out in BG's own public docs, and the endpoint is read-only).
   * Running through main keeps the renderer free of hardcoded keys.
   */
  ipcMain.handle(IPC.dealsList, async () => {
    const settings = await loadSettings();
    const url = new URL('/api/public/deals/amazon', settings.bgBaseUrl).toString();
    const r = await fetch(url, { headers: { 'x-api-key': 'pepe-gang' } });
    if (!r.ok) {
      throw new Error(`Deals fetch failed: HTTP ${r.status} ${r.statusText}`);
    }
    const data = (await r.json()) as unknown;
    if (!Array.isArray(data)) {
      throw new Error('Deals fetch failed: expected an array');
    }
    return data;
  });

  /**
   * Queue a buy job on BetterBG for a specific Amazon deal. Uses the
   * user's AutoG key (via the same BGClient the worker uses) so the
   * job is scoped to their userId server-side — another person's
   * AmazonG worker cannot claim it even if they share the app.
   */
  ipcMain.handle(IPC.dealsTrigger, async (_e, dealId: string) => {
    if (!apiKey) throw new Error('not connected to BG');
    const settings = await loadSettings();
    const bg = createBGClient(settings.bgBaseUrl, apiKey);
    return bg.triggerDealJob(dealId);
  });

  // Remote per-Amazon-account settings. These live on BG (today: just
  // the requireMinCashback toggle) because the worker needs them at buy
  // time anyway — and they should travel with the user's BG identity
  // rather than the AmazonG install. Renderer paints the Accounts UI
  // from this map; flips PATCH back to BG and refresh the cache.
  ipcMain.handle(IPC.profilesRemoteSettings, async () => {
    if (!apiKey) return { settings: {}, bgAccounts: [] };
    const settings = await loadSettings();
    const bg = createBGClient(settings.bgBaseUrl, apiKey);
    const r = await bg
      .listAmazonAccounts()
      .catch(() => ({ accounts: [], bgAccounts: [] }));
    const map: Record<
      string,
      { requireMinCashback: boolean; bgAccountId: string | null }
    > = {};
    for (const a of r.accounts) {
      map[a.email.toLowerCase()] = {
        requireMinCashback: a.requireMinCashback,
        bgAccountId: a.bgAccountId,
      };
    }
    return { settings: map, bgAccounts: r.bgAccounts };
  });

  ipcMain.handle(
    IPC.profilesSetRequireMinCashback,
    async (_e, email: string, requireMinCashback: boolean) => {
      if (!apiKey) throw new Error('not connected to BG');
      const settings = await loadSettings();
      const bg = createBGClient(settings.bgBaseUrl, apiKey);
      return bg.setAmazonAccountRequireMinCashback(email, requireMinCashback);
    },
  );

  ipcMain.handle(
    IPC.profilesSetBgAccount,
    async (_e, email: string, bgAccountId: string | null) => {
      if (!apiKey) throw new Error('not connected to BG');
      const settings = await loadSettings();
      const bg = createBGClient(settings.bgBaseUrl, apiKey);
      const r = await bg.setAmazonAccountBgAccount(email, bgAccountId);
      return { email: r.email, bgAccountId: r.bgAccountId };
    },
  );

  // Legacy IPC kept so older builds of the renderer (Deals tab) don't
  // crash on a missing handler. Always returns disabled now.
  ipcMain.handle(IPC.autoEnqueueStatus, () => ({
    nextRunAt: null,
    lastRunAt: null,
    lastResult: null,
    autoEnqueueEnabled: false,
    autoEnqueueIntervalHours: 6,
    autoEnqueueShipToFilter: 'oregon',
    autoEnqueueMinMarginPct: 0,
    autoEnqueueMaxPerTick: 50,
  }));

  // ─── Chase profile handlers ───────────────────────────────────────
  // Entirely local. No BG sync, no remote storage. Login is a hands-on
  // flow: open Chrome, let the user type credentials + handle MFA, and
  // poll for the post-login dashboard URL as the success signal.
  ipcMain.handle(IPC.chaseList, () => loadChaseProfiles());

  ipcMain.handle(
    IPC.chaseAdd,
    async (
      _e,
      label: string,
      credentials?: { username: string; password: string } | null,
    ) => {
      const list = await createChaseProfile(label);
      // Save credentials against the brand-new profile if the caller
      // passed any. The new profile is always the last entry — we
      // captured it before returning.
      if (credentials && credentials.username && credentials.password) {
        const newProfile = list[list.length - 1];
        if (newProfile) {
          await setChaseCredentials(newProfile.id, credentials).catch((err) => {
            logger.warn('chase.credentials.saveOnAddError', {
              id: newProfile.id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      }
      // Propagate the new profile to the user's other machines.
      void pushSyncToBG();
      return list;
    },
  );

  ipcMain.handle(IPC.chaseRemove, async (_e, id: string) => {
    // Make sure no in-flight login is holding the browser context
    // open against a profile we're about to delete on disk.
    chaseLoginAborts.get(id)?.();
    // Drop everything we keep keyed on this profile id — history,
    // snapshot cache, encrypted credentials. A re-add (or a recycled
    // UUID, theoretically) starts clean.
    await clearRedeemHistory(id).catch(() => undefined);
    await clearAccountSnapshot(id).catch(() => undefined);
    await clearChaseCredentials(id).catch(() => undefined);
    const list = await removeChaseProfile(id);
    // Mirror the removal to the user's other machines.
    void pushSyncToBG();
    return list;
  });

  ipcMain.handle(
    IPC.chaseCredentialsSet,
    async (
      _e,
      id: string,
      credentials: { username: string; password: string },
    ) => {
      await setChaseCredentials(id, credentials);
      // Credentials are part of the synced profile shape — propagate.
      void pushSyncToBG();
    },
  );

  ipcMain.handle(IPC.chaseCredentialsClear, async (_e, id: string) => {
    await clearChaseCredentials(id);
    // Push the now-credential-less profile up. A device that already
    // has the credentials keeps them (the pull merge is field-
    // preserving — guards against a keychain glitch wiping good
    // creds); a fresh device picks up the cleared state.
    void pushSyncToBG();
  });

  ipcMain.handle(IPC.chaseCredentialsHas, async (_e, id: string) => {
    return hasChaseCredentials(id);
  });

  ipcMain.handle(
    IPC.chaseLogin,
    async (
      _e,
      id: string,
    ): Promise<{ ok: true } | { ok: false; reason: string; cancelled?: boolean }> => {
      const profiles = await loadChaseProfiles();
      const profile = profiles.find((p) => p.id === id);
      if (!profile) return { ok: false, reason: 'profile not found' };

      // Single-flight per profile — if a previous login is still
      // pending for this id, cancel it before starting a new one so
      // we don't end up with two Chrome windows pointed at the same
      // user-data dir (Chromium refuses the second one anyway).
      chaseLoginAborts.get(id)?.();

      let session: ChaseSession;
      try {
        // showLinkAmazonBanner=true so the user gets an in-page
        // hint on /dashboard/overview telling them to click into
        // their Amazon card. Without it, users land on the
        // overview, see no AmazonG indication, and wonder why the
        // window isn't closing. Hidden on every other URL so MFA /
        // sign-in / card-summary pages stay clean.
        session = await openChaseSession(id, { showLinkAmazonBanner: true });
      } catch (err) {
        return {
          ok: false,
          reason: `failed to open browser: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      let aborted = false;
      const stopAutoSave = attachSessionAutoSave(session, id);
      const abort = () => {
        aborted = true;
        stopAutoSave();
        void session.close();
      };
      chaseLoginAborts.set(id, abort);

      try {
        // Navigate straight to the secure dashboard URL rather than
        // chase.com/ (the marketing front page). Two reasons:
        //
        //   1. Returning user with a valid persistent session: Chase
        //      sees the cookies and serves the dashboard immediately
        //      — no sign-in form, no 2FA prompt, often no manual
        //      input at all if the user already clicked into a card
        //      on a previous run (the summary URL becomes the new
        //      default landing). The waitForURL below fires on its
        //      own and the window auto-closes.
        //
        //   2. Fresh user with no cookies yet: Chase redirects this
        //      URL to the logon page; user signs in normally; auth
        //      redirects back here. Same end state as starting on
        //      chase.com, just one fewer click.
        //
        // Persistent context at userData/chase-profiles/{id}/ holds
        // the cookies + localStorage; nothing extra to do for "save
        // session" — Playwright flushes state on context.close().
        await session.page.goto(
          'https://secure.chase.com/web/auth/dashboard',
          {
            waitUntil: 'domcontentloaded',
            timeout: 30_000,
          },
        );

        // Auto-login when we have saved credentials. Always try —
        // attemptChaseAutoLogin handles both layouts (iframe overlay
        // OR full-page /logon) and bails gracefully with
        // 'no_login_form' when the user is already signed in. After
        // Sign-in, the iframe detaches / URL leaves /logon, and the
        // existing waitForURL() below picks up the card-summary
        // redirect when the user clicks into their card.
        const savedCreds = await getChaseCredentials(id).catch(() => null);
        if (savedCreds) {
          const outcome = await attemptChaseAutoLogin(session.page, savedCreds).catch(
            (err) => ({ kind: 'error' as const, reason: String(err) }),
          );
          logger.info('chase.login.autoLogin', { id, outcome: outcome.kind });
        }

        // 30-minute deadline — generous because the user has to type
        // credentials, may need SMS / passkey / security questions,
        // and then click into the specific card whose summary we want
        // to capture. Success URL has Chase's internal card account
        // id baked into the hash route — capturing it here means
        // future flows (list, pay, redeem) can navigate to the same
        // card without making the user re-pick.
        const CARD_SUMMARY_RE =
          /^https:\/\/secure\.chase\.com\/web\/auth\/dashboard#\/dashboard\/summary\/(\d+)\/CARD\/BAC/;
        let capturedCardAccountId: string | null = null;
        await session.page.waitForURL(
          (url) => {
            const m = url.toString().match(CARD_SUMMARY_RE);
            if (m) {
              capturedCardAccountId = m[1] ?? null;
              return true;
            }
            return false;
          },
          { timeout: 30 * 60 * 1000 },
        );

        if (aborted) {
          return { ok: false, reason: 'login cancelled', cancelled: true };
        }

        // Detected card-summary URL — close the Chrome window and
        // stamp success + the captured card id on the profile row.
        // Cookies persist in the user-data dir for next time.
        stopAutoSave();
        await session.close();
        await updateChaseProfile(id, {
          loggedIn: true,
          lastLoginAt: new Date().toISOString(),
          cardAccountId: capturedCardAccountId,
        });
        logger.info('chase.login.ok', {
          id,
          label: profile.label,
          cardAccountId: capturedCardAccountId,
        });
        // Sync the captured cardAccountId up — loggedIn / lastLoginAt
        // stay local, but cardAccountId is part of the synced shape.
        void pushSyncToBG();
        return { ok: true };
      } catch (err) {
        stopAutoSave();
        await session.close().catch(() => undefined);
        if (aborted) {
          return { ok: false, reason: 'login cancelled', cancelled: true };
        }
        const msg = err instanceof Error ? err.message : String(err);
        // Chrome window closed by the user (context.close → page
        // ops throw) is the most common non-success path. Surface a
        // friendlier message than Playwright's raw "Target page,
        // context or browser has been closed" so the UI can render
        // it as a neutral state.
        const friendlier = /Target.*closed|browser has been closed/i.test(msg)
          ? 'login window closed before reaching the dashboard'
          : msg;
        logger.warn('chase.login.error', { id, label: profile.label, error: friendlier });
        return { ok: false, reason: friendlier };
      } finally {
        chaseLoginAborts.delete(id);
      }
    },
  );

  ipcMain.handle(IPC.chaseAbortLogin, async (_e, id: string) => {
    chaseLoginAborts.get(id)?.();
  });

  ipcMain.handle(
    IPC.chaseOpenRewards,
    async (_e, id: string): Promise<{ ok: true } | { ok: false; reason: string }> => {
      const profiles = await loadChaseProfiles();
      const profile = profiles.find((p) => p.id === id);
      if (!profile) return { ok: false, reason: 'profile not found' };
      if (!profile.cardAccountId) {
        return {
          ok: false,
          reason: 'no card linked yet — finish the login flow first so the card account id is captured',
        };
      }
      // Don't fight the login flow for the userDataDir.
      if (chaseLoginAborts.has(id)) {
        return { ok: false, reason: 'login is still in progress for this profile' };
      }

      // Reuse an already-open redeem window if there is one. Bring
      // its focused page back to front so a duplicate click feels
      // like "raise the existing window" rather than spawn a new
      // one (Chromium would refuse the new one anyway).
      const existingRewards = chaseRewardsActionSessions.get(id);
      if (existingRewards) {
        try {
          await existingRewards.page.bringToFront();
          return { ok: true };
        } catch {
          // The page is gone (user closed it); fall through and
          // open a fresh session.
          chaseRewardsActionSessions.delete(id);
        }
      }
      // Pay window holds the userDataDir lock — refuse cleanly so
      // the user closes Pay first instead of hitting an obscure
      // Chromium-launch error (pass-4 audit #7).
      if (chasePayActionSessions.has(id)) {
        return {
          ok: false,
          reason:
            'a Pay-my-Balance window is already open for this profile — close it first',
        };
      }

      let session: ChaseSession;
      try {
        session = await openChaseSession(id);
      } catch (err) {
        return {
          ok: false,
          reason: `failed to open browser: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      chaseRewardsActionSessions.set(id, session);
      const stopAutoSave = attachSessionAutoSave(session, id);
      const stopKeepalive = attachChaseKeepalive(session, id);
      session.context.on('close', () => {
        stopAutoSave();
        stopKeepalive();
        chaseRewardsActionSessions.delete(id);
      });

      const url = `https://chaseloyalty.chase.com/home?AI=${encodeURIComponent(
        profile.cardAccountId,
      )}`;
      try {
        // Two-hop navigation. The persistent context's saved cookies
        // are scoped to secure.chase.com (the subdomain where the
        // user actually authenticated). chaseloyalty.chase.com is a
        // separate subdomain — Chase mints its session via an SSO
        // redirect off secure.chase.com on first visit. If we go
        // straight to chaseloyalty, that subdomain has no cookies
        // and Chase shows the login form even though the user's
        // secure.chase.com session is fully valid. Hitting the
        // secure dashboard first triggers the SSO machinery so the
        // follow-up loyalty navigation rides the session through.
        await session.page.goto(
          'https://secure.chase.com/web/auth/dashboard',
          { waitUntil: 'domcontentloaded', timeout: 30_000 },
        );
        await session.page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
        logger.info('chase.openRewards.ok', {
          id,
          label: profile.label,
          cardAccountId: profile.cardAccountId,
        });
        return { ok: true };
      } catch (err) {
        // Don't tear down the session on a navigation hiccup — the
        // window is open and the user can retry from inside Chrome.
        // Just surface the error to the renderer for visibility.
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('chase.openRewards.gotoError', { id, error: msg });
        return { ok: false, reason: msg };
      }
    },
  );

  // Per-profile guards so duplicate clicks across the redeem +
  // snapshot flows (and parallel logins) don't fight the userDataDir
  // lock. Each handler clears its own set in a finally; they all
  // refuse if any of the others is currently active for the same id.
  // Self-healing in-flight guards. Each map entry's value is the
  // timestamp it was added — entries older than STALE_INFLIGHT_MS
  // are evicted on read so a hung Playwright session (user closed
  // the Chase window in a way that confused close(), Chrome crashed,
  // etc.) doesn't permanently lock the user out of automation. Every
  // automation hard-caps at ~2min anyway between SSO + page loads.
  // Bumped from 3:00 to 3:30 to give a jitter buffer (pass-4 audit
  // #10): a fetch that takes exactly 3:00 on a slow Chase response
  // could otherwise race the eviction with its own finally-close,
  // briefly leaving the userDataDir lock available to a concurrent
  // redeem.
  const STALE_INFLIGHT_MS = 3.5 * 60_000;
  const chaseRedeemInFlight = new Map<string, number>();
  const chaseSnapshotInFlight = new Map<string, number>();
  const chasePayInFlight = new Map<string, number>();
  const isInFlight = (m: Map<string, number>, id: string): boolean => {
    const ts = m.get(id);
    if (ts === undefined) return false;
    if (Date.now() - ts > STALE_INFLIGHT_MS) {
      logger.warn('chase.inflight.evicted', {
        id,
        ageMs: Date.now() - ts,
      });
      m.delete(id);
      return false;
    }
    return true;
  };

  /**
   * Request coalescing for read-only Chase operations (snapshot
   * refresh, pay preview). Renderer side fires duplicate IPC calls
   * in dev because React StrictMode double-invokes useEffects;
   * without coalescing the second call hits the in-flight guard
   * and surfaces a confusing "another automation running" error
   * even though the user only clicked once. With coalescing, all
   * callers for the same profile id await the same underlying
   * promise.
   *
   * Only used for read-only flows. Submit flows (chasePayBalance,
   * chaseRedeemAll) should NOT coalesce — accidentally executing
   * a paid action once is the right behavior on a double-click.
   */
  type Coalesce<T> = Map<string, Promise<T>>;
  const coalesceSnapshot: Coalesce<unknown> = new Map();
  const runCoalesced = async <T>(
    map: Coalesce<unknown>,
    id: string,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const existing = map.get(id) as Promise<T> | undefined;
    if (existing) return existing;
    const promise = (async () => {
      try {
        return await fn();
      } finally {
        map.delete(id);
      }
    })();
    map.set(id, promise as Promise<unknown>);
    return promise;
  };

  /**
   * Core redeem-all flow, factored out of the IPC handler so the
   * auto-redeem scheduler can invoke it directly. Same in-flight
   * guards apply (closure-scoped maps below). Returns the same
   * `ChaseRedeemResult` shape the IPC contract specifies.
   */
  const performChaseRedeem = async (
    id: string,
  ): Promise<import('../shared/types.js').ChaseRedeemResult> => {
    const profiles = await loadChaseProfiles();
    const profile = profiles.find((p) => p.id === id);
    if (!profile) return { ok: false, kind: 'error', reason: 'profile not found' };
    if (!profile.cardAccountId) {
      return {
        ok: false,
        kind: 'error',
        reason: 'no card linked yet — finish login first so the card account id is captured',
      };
    }
    if (chaseLoginAborts.has(id)) {
      return {
        ok: false,
        kind: 'error',
        reason: 'login is still in progress for this profile',
      };
    }
    if (chaseRewardsActionSessions.has(id) || chasePayActionSessions.has(id)) {
      return {
        ok: false,
        kind: 'error',
        reason: 'another Chase window is already open for this profile — close it first',
      };
    }
    if (isInFlight(chaseRedeemInFlight, id)) {
      return {
        ok: false,
        kind: 'error',
        reason: 'redemption already running for this profile',
      };
    }
    if (isInFlight(chaseSnapshotInFlight, id)) {
      return {
        ok: false,
        kind: 'error',
        reason: 'a snapshot fetch is running for this profile — try again in a moment',
      };
    }
    if (isInFlight(chasePayInFlight, id)) {
      return {
        ok: false,
        kind: 'error',
        reason: 'a payment is running for this profile — close the Pay window first',
      };
    }
    chaseRedeemInFlight.set(id, Date.now());
    try {
      const result = await redeemAllToStatementCredit(id, profile.cardAccountId);
      if (
        !result.ok &&
        result.kind === 'error' &&
        /session expired/i.test(result.reason)
      ) {
        await updateChaseProfile(id, { loggedIn: false }).catch(() => undefined);
      }
      if (result.ok) {
        // Persist successful redemptions only — failed runs are noise
        // for a "history" view (the user knows it failed because the
        // banner just told them so).
        await appendRedeemEntry(id, {
          ts: new Date().toISOString(),
          orderNumber: result.orderNumber,
          amount: result.amount,
          pointsRedeemed: result.pointsRedeemed,
        }).catch((err) => {
          logger.warn('chase.redeem.historySave.error', {
            id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('chase.redeem.unexpected', { id, error: msg });
      return { ok: false, kind: 'error', reason: msg };
    } finally {
      chaseRedeemInFlight.delete(id);
    }
  };

  // Expose to the auto-redeem scheduler. Captured here so the
  // scheduler tick can fire performChaseRedeem without going through
  // ipcRenderer (it's already on the main process).
  triggerChaseRedeem = performChaseRedeem;

  ipcMain.handle(IPC.chaseRedeemAll, async (_e, id: string) => {
    return performChaseRedeem(id);
  });

  ipcMain.handle(
    IPC.chaseSetAutoRedeem,
    async (_e, id: string, patch: { enabled: boolean; time?: string }) => {
      const profiles = await loadChaseProfiles();
      const profile = profiles.find((p) => p.id === id);
      if (!profile) return profiles;
      const current = profile.autoRedeem ?? {
        enabled: false,
        time: '15:00',
        lastRunAt: null,
        lastRunResult: null,
        lastRunError: null,
      };
      // v0.13.42: the schedule TIME moved to global settings
      // (Settings.chaseAutoRedeemTime). Per-profile `time` is no
      // longer authoritative — we keep the field on the row for
      // backward compat with persisted profiles but ignore any
      // `patch.time` here. The renderer's global time picker calls
      // settingsSet directly. Per-profile patch is now enabled-only.
      // Skip-today-on-enable: when the user flips false → true and
      // today's window has already passed, stamp lastRunAt to start-
      // of-today so the natural fire-today path is short-circuited.
      // Reads the global time from settings.
      let nextLastRunAt: string | null = current.lastRunAt;
      if (patch.enabled && !current.enabled) {
        const settings = await loadSettings().catch(() => null);
        const globalTime = settings?.chaseAutoRedeemTime ?? '15:00';
        const { lastRunAtForFreshEnable } = await import(
          './chaseRedeemScheduler.js'
        );
        const skipStamp = lastRunAtForFreshEnable(globalTime);
        if (skipStamp) {
          nextLastRunAt = skipStamp.toISOString();
        }
      }
      const updated = await updateChaseProfile(id, {
        autoRedeem: {
          enabled: patch.enabled,
          // Carry forward the persisted time so older row shape
          // stays well-formed; not read by the scheduler anymore.
          time: current.time,
          lastRunAt: nextLastRunAt,
          lastRunResult: current.lastRunResult,
          lastRunError: current.lastRunError,
        },
      });
      logger.info('chase.autoRedeem.updated', {
        id,
        enabled: patch.enabled,
        skippedToday: nextLastRunAt !== current.lastRunAt,
      });
      // autoRedeem config is part of the synced shape — propagate it.
      void pushSyncToBG();
      return updated;
    },
  );

  ipcMain.handle(IPC.chaseRedeemHistory, async (_e, id: string) => {
    return listRedeemHistory(id);
  });

  ipcMain.handle(IPC.chaseSnapshotGet, async (_e, id: string) => {
    return getAccountSnapshot(id);
  });

  // Classify a fetch failure reason into a typed kind the renderer
  // can render distinct UX for. The reason strings come from
  // chaseDriver.ts's various warn paths; this is a small classifier
  // over the user-facing messages we already emit. Kind drives the
  // Bank tab's per-card error affordance — "session-expired" gets
  // an inline "Sign in to Chase" button, "rate-limit" gets a "Try
  // again in a moment" hint, "unknown" gets the bare error text.
  const classifySnapshotErrorKind = (reason: string): 'session-expired' | 'rate-limit' | 'unknown' => {
    if (/session expired|2fa|sign in again|otp|identity verification/i.test(reason)) {
      return 'session-expired';
    }
    if (/rate.?limit|parallel.?fetch|too many|throttle/i.test(reason)) {
      return 'rate-limit';
    }
    return 'unknown';
  };

  // TTL for the freshness gate below. Within this window, snapshot
  // refreshes return cached data without spawning Chromium — covers
  // double-clicks, StrictMode double-fires, the renderer's
  // useEffect re-running on a profile-list mutation that landed
  // mid-fetch, etc. The explicit "Refresh" / "Refresh All" buttons
  // pass {force:true} to bypass.
  const SNAPSHOT_FRESHNESS_TTL_MS = 90_000;

  // Same family of guards as the redeem handler — Chase's persistent
  // userDataDir can only host one session at a time, and a parallel
  // login + snapshot would deadlock.
  ipcMain.handle(
    IPC.chaseSnapshotRefresh,
    async (_e, id: string, options?: { force?: boolean }) => {
      const force = options?.force === true;
      const profiles = await loadChaseProfiles();
      const profile = profiles.find((p) => p.id === id);
      if (!profile) return { ok: false, reason: 'profile not found', kind: 'unknown' as const };
      if (!profile.cardAccountId) {
        return {
          ok: false,
          reason: 'no card linked yet — finish login first so the card account id is captured',
          kind: 'unknown' as const,
        };
      }

      // Freshness short-circuit — return cached snapshot without
      // spawning Chromium when the last successful fetch was within
      // SNAPSHOT_FRESHNESS_TTL_MS. This is the killshot for the
      // "why is it opening a window AGAIN" double-click class.
      if (!force) {
        const cached = await getAccountSnapshot(id);
        if (cached) {
          const ageMs = Date.now() - new Date(cached.fetchedAt).getTime();
          if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < SNAPSHOT_FRESHNESS_TTL_MS) {
            logger.info('chase.snapshot.freshHit', { id, ageMs });
            return { ok: true, snapshot: cached, fromCache: true } as const;
          }
        }
      }

      if (chaseLoginAborts.has(id)) {
        return {
          ok: false,
          reason: 'login is still in progress for this profile',
          kind: 'unknown' as const,
        };
      }
      if (chaseRewardsActionSessions.has(id) || chasePayActionSessions.has(id)) {
        return {
          ok: false,
          reason: 'another Chase window is already open for this profile — close it first',
          kind: 'unknown' as const,
        };
      }
      if (isInFlight(chaseRedeemInFlight, id)) {
        return {
          ok: false,
          reason: 'a redemption is already running for this profile',
          kind: 'unknown' as const,
        };
      }
      if (isInFlight(chasePayInFlight, id)) {
        // A pay window is holding the userDataDir lock — running a
        // second Chromium against the same dir would fail with
        // ProcessSingleton. Defer this snapshot fetch.
        return {
          ok: false,
          reason: 'a payment is already running for this profile',
          kind: 'unknown' as const,
        };
      }
      // Coalesce concurrent snapshot calls (StrictMode double-fires
      // the renderer's useEffect) so duplicates wait on the same
      // underlying work instead of hitting the in-flight guard.
      return runCoalesced(coalesceSnapshot, id, async () => {
        chaseSnapshotInFlight.set(id, Date.now());
        try {
          const result = await fetchChaseAccountSnapshot(id, profile.cardAccountId!);
          if (result.ok) {
            await setAccountSnapshot(id, result.snapshot).catch((err) => {
              logger.warn('chase.snapshot.persistError', {
                id,
                error: err instanceof Error ? err.message : String(err),
              });
            });
            return result;
          }
          // Failure path: classify reason for the renderer + flip
          // loggedIn flag on session-expired so the UI re-shows
          // the Login button.
          const kind = classifySnapshotErrorKind(result.reason);
          if (kind === 'session-expired') {
            await updateChaseProfile(id, { loggedIn: false }).catch(() => undefined);
          }
          return { ok: false, reason: result.reason, kind } as const;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn('chase.snapshot.unexpected', { id, error: msg });
          return { ok: false, reason: msg, kind: 'unknown' as const };
        } finally {
          chaseSnapshotInFlight.delete(id);
        }
      });
    },
  );

  // Pay my Balance — open the Chase pay window, hand off to user.
  // No auto-fill, no submit. The window stays open until the user
  // closes it, the same as chaseOpenRewards. Reusing the action-
  // session map keeps every other automation refusing to fight the
  // userDataDir lock while this window is up.
  ipcMain.handle(IPC.chasePayBalance, async (_e, id: string) => {
    const profiles = await loadChaseProfiles();
    const profile = profiles.find((p) => p.id === id);
    if (!profile) return { ok: false, reason: 'profile not found' };
    if (!profile.cardAccountId) {
      return {
        ok: false,
        reason: 'no card linked yet — finish login first so the card account id is captured',
      };
    }
    if (chaseLoginAborts.has(id)) {
      return { ok: false, reason: 'login is still in progress for this profile' };
    }
    const existingPay = chasePayActionSessions.get(id);
    if (existingPay) {
      try {
        await existingPay.page.bringToFront();
        return { ok: true };
      } catch {
        // page is gone (user closed it); fall through to a fresh open
        chasePayActionSessions.delete(id);
      }
    }
    // Rewards window holds the userDataDir lock — refuse cleanly
    // (pass-4 audit #7).
    if (chaseRewardsActionSessions.has(id)) {
      return {
        ok: false,
        reason:
          'an Open Rewards window is already open for this profile — close it first',
      };
    }
    if (
      isInFlight(chaseRedeemInFlight, id) ||
      isInFlight(chaseSnapshotInFlight, id) ||
      isInFlight(chasePayInFlight, id)
    ) {
      return {
        ok: false,
        reason: 'another Chase automation is running for this profile',
      };
    }

    // Mark in-flight BEFORE openChasePayPage to close the TOCTOU
    // window pass-4 audit #6 flagged: two concurrent Pay clicks
    // could both pass the bringToFront check (no session) and both
    // call openChasePayPage, racing for the userDataDir lock. The
    // marker is cleared in finally if we don't end up registering
    // a session (= we threw or returned an error).
    chasePayInFlight.set(id, Date.now());
    let registered = false;
    try {
      const result = await openChasePayPage(id, profile.cardAccountId);
      if (!result.ok) {
        if (/session expired/i.test(result.reason)) {
          await updateChaseProfile(id, { loggedIn: false }).catch(() => undefined);
        }
        return result;
      }
      // Hand the session off — register so other handlers refuse to
      // open a parallel session against the same userDataDir, and
      // clean up when the user closes the window.
      chasePayActionSessions.set(id, result.session);
      registered = true;
      const stopAutoSave = attachSessionAutoSave(result.session, id);
      const stopKeepalive = attachChaseKeepalive(result.session, id);
      result.session.context.on('close', () => {
        stopAutoSave();
        stopKeepalive();
        chasePayActionSessions.delete(id);
        chasePayInFlight.delete(id);
      });

      // Background watcher: poll every frame of the page for a
      // pay-flow end state, then auto-close the window. Two end states
      // close it:
      //   - "You've scheduled a …"               → payment scheduled
      //   - "There is no amount due on this …"   → nothing owed; Chase
      //                                            blocks the payment
      // CRITICAL: Chase renders this flow with mds-* design-system web
      // components whose text lives inside SHADOW DOM. Neither
      // document.body.textContent nor page.waitForFunction pierce
      // shadow roots — verified live 2026-05-16 via Playwright (the
      // "no amount due" text sat inside <mds-alert>, body.textContent
      // false, deep shadow walk true, zero iframes). The detector
      // below walks shadow roots explicitly. Doesn't block this IPC
      // return — races the user's manual close + a 15-min hard timeout.
      void (async () => {
        const watchStarted = Date.now();
        const WATCH_TIMEOUT_MS = 15 * 60_000;
        // Runs in the browser, per frame. Deep-collects text across
        // every shadow root (mds-* components hide their text there),
        // normalizes curly/typographic apostrophes (Chase renders
        // U+2019 in "You've"), and matches either close-state. Amount +
        // card last-4 are intentionally not part of the patterns.
        const frameMatchesCloseSignal = () => {
          const collect = (root: Node): string => {
            let txt = '';
            const kids = (root as ParentNode & Node).childNodes;
            if (!kids) return txt;
            for (const node of Array.from(kids)) {
              if (node.nodeType === 3) {
                txt += node.textContent ?? '';
                continue;
              }
              const sr = (node as Element).shadowRoot;
              if (sr) txt += collect(sr);
              txt += collect(node);
            }
            return txt;
          };
          const text = collect(document).replace(/[‘’]/g, "'");
          return (
            /you'?ve\s+scheduled\s+a\b/i.test(text) ||
            /there\s+is\s+no\s+amount\s+due\s+on\s+this\s+account/i.test(text)
          );
        };
        try {
          let matched = false;
          let loggedFrames = false;
          while (Date.now() - watchStarted < WATCH_TIMEOUT_MS) {
            const frames = result.session.page.frames();
            if (!loggedFrames) {
              logger.info('chase.pay.autoClose.watching', {
                id,
                frameCount: frames.length,
              });
              loggedFrames = true;
            }
            for (const frame of frames) {
              try {
                if (await frame.evaluate(frameMatchesCloseSignal)) {
                  matched = true;
                  break;
                }
              } catch {
                // Frame detached / navigated mid-evaluate — skip it,
                // the next poll picks up its replacement.
              }
            }
            if (matched) break;
            await new Promise((r) => setTimeout(r, 1_000));
          }
          if (!matched) {
            logger.info('chase.pay.autoClose.timeout', { id });
            return;
          }
          // Brief read window before we whisk the page away.
          await new Promise((r) => setTimeout(r, 3_000));
          logger.info('chase.pay.autoClose', { id });
          // Notify the renderer so it flips the card button back from
          // "Close browser" → "Pay my Balance" and refreshes the
          // snapshot. Harmless on the "no amount due" path (balance
          // unchanged). Sent BEFORE close so the event isn't dropped
          // if close+cleanup races the renderer's listener.
          mainWindow?.webContents.send(IPC.evtChasePaySuccess, id);
          await result.session.close();
        } catch {
          // Legitimate ways to land here:
          //   - user closed the window manually (page already gone)
          //   - a navigation race threw while reading frames
          // The on('close') handler above already (or will) clear the
          // action-session map. Nothing to do here.
        }
      })();

      return { ok: true };
    } finally {
      // TOCTOU close: if we threw or returned early without registering
      // a session, drop the in-flight marker so a retry can proceed.
      // The success path leaves it set; on('close') clears it when the
      // user closes the window.
      if (!registered) chasePayInFlight.delete(id);
    }
  });

  // Force-close the Pay-my-Balance browser. The renderer's "Close
  // browser" button calls this when the user wants to bail out
  // without completing the payment. session.close() flushes
  // cookies/localStorage to disk and tears the context down; the
  // on('close') hook above clears chasePayActionSessions[id], which
  // also unsticks the success-text watcher (its waitForFunction
  // throws once the page is gone).
  ipcMain.handle(IPC.chasePayCancel, async (_e, id: string) => {
    const session = chasePayActionSessions.get(id);
    if (!session) return;
    chasePayActionSessions.delete(id);
    try {
      await session.close();
    } catch {
      // Window may already be gone (user closed it manually a
      // moment before clicking the renderer button) — nothing to do.
    }
  });

  ipcMain.handle(IPC.jobsList, () => listMergedAttempts());
  ipcMain.handle(IPC.jobsLogs, (_e, attemptId: string) => storeReadLogs(attemptId));
  ipcMain.handle(IPC.jobsSnapshot, async (_e, attemptId: string) => {
    const { readFile } = await import('node:fs/promises');
    const dir = snapshotDir(attemptId);
    let screenshot: string | null = null;
    let html: string | null = null;
    let hasTrace = false;
    try { screenshot = (await readFile(join(dir, 'screenshot.png'))).toString('base64'); } catch { /* no file */ }
    try { html = await readFile(join(dir, 'page.html'), 'utf8'); } catch { /* no file */ }
    try { const { stat } = await import('node:fs/promises'); await stat(join(dir, 'trace.zip')); hasTrace = true; } catch { /* no file */ }
    return { screenshot, html, hasTrace };
  });
  ipcMain.handle(IPC.jobsOpenTrace, (_e, attemptId: string) => {
    shell.showItemInFolder(join(snapshotDir(attemptId), 'trace.zip'));
  });
  ipcMain.handle(IPC.snapshotsDiskUsage, () => snapshotsDiskUsage());
  ipcMain.handle(IPC.snapshotsClearAll, () => clearAllSnapshots());
  ipcMain.handle(IPC.jobsClearAll, async () => {
    await storeClearAll();
    scheduleBroadcastJobs();
  });
  ipcMain.handle(IPC.jobsClearFailed, async () => {
    const removed = await storeClearFailed();
    if (removed > 0) scheduleBroadcastJobs();
    return removed;
  });
  ipcMain.handle(IPC.jobsClearCanceled, async () => {
    const removed = await storeClearCanceled();
    if (removed > 0) scheduleBroadcastJobs();
    return removed;
  });

  ipcMain.handle(IPC.jobsDelete, async (_e, attemptId: string) => {
    // Same pattern as jobsDeleteBulk — capture the local row before
    // deleting so we can translate to the server's AutoBuyPurchase.id
    // when calling BG's delete endpoint.
    const localRow = (await storeListAttempts()).find((a) => a.attemptId === attemptId);
    await storeDeleteAttempt(attemptId);
    const s = await loadSettings();
    if (!s.hiddenAttemptIds.includes(attemptId)) {
      await saveSettings({
        ...s,
        hiddenAttemptIds: [...s.hiddenAttemptIds, attemptId],
      });
    }
    // Best-effort BG delete — local hide already guarantees the row
    // stays gone for this user; this just keeps BG's own Amazon
    // Purchases view in sync.
    if (apiKey) {
      try {
        const bg = createBGClient(s.bgBaseUrl, apiKey);
        let serverId = attemptId; // default: row was server-native
        if (localRow) {
          const list = await bg.listPurchases(500);
          const match = list.find(
            (p) => p.jobId === localRow.jobId && p.amazonEmail === localRow.amazonEmail,
          );
          if (match) serverId = match.attemptId;
          else serverId = ''; // no match — nothing to delete server-side
        }
        if (serverId) {
          await bg.deletePurchases([serverId]);
        }
      } catch (err) {
        logger.warn('bg.deletePurchases(single) failed; local hide still in effect', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    scheduleBroadcastJobs();
  });

  ipcMain.handle(IPC.jobsDeleteBulk, async (_e, attemptIds: string[]) => {
    // Capture the local rows BEFORE deleting so we can translate each
    // local attemptId → the server's AutoBuyPurchase.id for the BG
    // delete call. listMergedAttempts prefers local's attemptId when
    // both sides have a copy, so the ids the renderer hands us are
    // usually local ids, not server cuids.
    const localBefore = await storeListAttempts();
    const localById = new Map(localBefore.map((a) => [a.attemptId, a]));

    // Delete any local attempt records (and their logs / snapshots).
    const removed = await storeDeleteAttempts(attemptIds);

    // Remember the ids as hidden so server-sourced rows (from BG's
    // listPurchases) don't re-appear on the next merge. Local hide is
    // the fast path — survives offline + makes the UI correct instantly.
    let settings = await loadSettings();
    if (attemptIds.length > 0) {
      const next = Array.from(new Set([...(settings.hiddenAttemptIds ?? []), ...attemptIds]));
      settings = { ...settings, hiddenAttemptIds: next };
      await saveSettings(settings);
    }

    // Hard-delete on BG. Translate local attemptIds → server attemptIds
    // via the (jobId, amazonEmail) key that listMergedAttempts uses —
    // without this, BG's DELETE endpoint (which keys on its own cuid)
    // silently matches zero rows for every merged attempt. Best-effort:
    // if BG is unreachable, local hide still keeps AmazonG consistent.
    if (apiKey && attemptIds.length > 0) {
      try {
        const bg = createBGClient(settings.bgBaseUrl, apiKey);
        const serverRows = await bg.listPurchases(500);
        const serverByKey = new Map<string, ServerPurchase>();
        for (const s of serverRows) {
          if (!s.amazonEmail) continue;
          serverByKey.set(`${s.jobId}__${s.amazonEmail}`, s);
        }
        const idsForBg: string[] = [];
        for (const id of attemptIds) {
          const l = localById.get(id);
          if (l) {
            const match = serverByKey.get(`${l.jobId}__${l.amazonEmail}`);
            if (match) idsForBg.push(match.attemptId);
            // else: no BG match — nothing to delete server-side.
          } else {
            // No local row — the id is server-native (server-only row
            // the user selected directly). Pass through as-is.
            idsForBg.push(id);
          }
        }
        if (idsForBg.length > 0) {
          await bg.deletePurchases(idsForBg);
        }
      } catch (err) {
        logger.warn('bg.deletePurchases(bulk) failed; local hide still in effect', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    scheduleBroadcastJobs();
    return Math.max(removed, attemptIds.length);
  });

  ipcMain.handle(IPC.jobsReconcileStuck, async () => {
    // Two kinds of stuck Pending rows this cleans up:
    //   1. Orphan: local row exists with no matching BG purchase. Worker
    //      crashed before /status POST landed, or app closed mid-buy.
    //   2. Stale-no-orderId: BG has a matching purchase AND local agrees,
    //      but the buy never placed an Amazon order (orderId still null)
    //      AND the row is older than 30 minutes — that's well past any
    //      legitimate buy window, so it's not coming back. In this case
    //      we also delete the BG-side purchase (using its real cuid, not
    //      the local attemptId) so listMergedAttempts doesn't re-overlay
    //      the Pending status on the next broadcast.
    if (!apiKey) return { kind: 'offline' as const };

    const settings = await loadSettings();
    let serverRows: ServerPurchase[];
    try {
      const bg = createBGClient(settings.bgBaseUrl, apiKey);
      serverRows = await bg.listPurchases(500);
    } catch (err) {
      logger.warn('jobsReconcileStuck: bg.listPurchases failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      return { kind: 'offline' as const };
    }

    // Index server rows by (jobId, amazonEmail) — the same key pairing
    // listMergedAttempts uses, because local attemptId ≠ server
    // AutoBuyPurchase.id. We keep the full ServerPurchase so we can
    // forward its real server attemptId to bg.deletePurchases when we
    // need to clean up BG-side too.
    const serverByKey = new Map<string, ServerPurchase>();
    for (const s of serverRows) {
      if (!s.amazonEmail) continue;
      serverByKey.set(`${s.jobId}__${s.amazonEmail}`, s);
    }

    const PENDING = new Set<JobAttemptStatus>([
      'queued',
      'in_progress',
      'awaiting_verification',
    ]);
    const STALE_MS = 30 * 60 * 1000;
    const now = Date.now();

    const local = await storeListAttempts();
    const bgIdsToDelete: string[] = [];
    let marked = 0;

    for (const a of local) {
      if (!PENDING.has(a.status)) continue;
      const k = `${a.jobId}__${a.amazonEmail}`;
      const serverMatch = serverByKey.get(k);
      const ageMs = now - new Date(a.createdAt).getTime();
      const isStale = ageMs > STALE_MS;
      const hasOrderId = !!a.orderId;

      let reason: string | null = null;
      if (!serverMatch) {
        reason =
          'Orphan pending — no matching BG purchase. Worker likely crashed or the app was closed before the outcome was reported.';
      } else if (isStale && !hasOrderId) {
        reason =
          'Stale pending — no Amazon order placed after 30 minutes. Treating as failed so the table reflects reality.';
        // Only ask BG to delete when both sides are stuck: no orderId
        // means the purchase never finished, and without cleanup the
        // merge path would overlay BG's status back on next broadcast.
        bgIdsToDelete.push(serverMatch.attemptId);
      }
      if (reason) {
        await storeUpdateAttempt(a.attemptId, { status: 'failed', error: reason });
        marked += 1;
      }
    }

    if (bgIdsToDelete.length > 0) {
      try {
        const bg = createBGClient(settings.bgBaseUrl, apiKey);
        await bg.deletePurchases(bgIdsToDelete);
      } catch (err) {
        logger.warn('jobsReconcileStuck: bg.deletePurchases failed', {
          err: err instanceof Error ? err.message : String(err),
        });
        // Local flip-to-failed still landed; BG may rematerialize on the
        // next merge but at least the user's table is correct for now.
      }
    }

    if (marked > 0) scheduleBroadcastJobs();
    return { kind: 'ok' as const, marked };
  });

  ipcMain.handle(
    IPC.jobsVerifyOrder,
    async (_e, attemptId: string) => {
      // Look up the attempt → resolve email + orderId → run verifyOrder in
      // a fresh session. If the worker is running and holding the
      // profile's userDataDir lock, return 'busy' so the renderer toasts a
      // clear "stop the worker" message instead of throwing a raw lock
      // error.
      // Try local store first, fall back to the server-merged list for
      // rows synced from BG that never ran through this worker
      // (cross-device buys, fresh installs). Without the fallback, the
      // user gets a confusing "attempt not found" on a row that's right
      // in front of them.
      let a = (await storeListAttempts()).find((x) => x.attemptId === attemptId);
      let serverOnly = false;
      if (!a) {
        a = (await listMergedAttempts()).find((x) => x.attemptId === attemptId);
        serverOnly = !!a;
      }
      if (!a) return { kind: 'error' as const, message: 'attempt not found' };
      if (!a.orderId) return { kind: 'error' as const, message: 'no order id on this row' };
      const email = a.amazonEmail;
      const orderId = a.orderId;

      // Mirror server-only rows into the local store so the post-verify
      // storeUpdateAttempt lands. Without this, the row's status would
      // never flip to 'verified' / 'cancelled_by_amazon' locally even
      // though the verify ran successfully.
      if (serverOnly) {
        await storeCreateAttempt({
          ...a,
          trackingIds: a.trackingIds ?? null,
        }).catch(() => undefined);
      }

      // Respect per-profile headless preference (fall back to global
      // setting). Mirrors jobsFetchTracking — useful when the user has
      // toggled an account to Visible to debug a flow.
      const profiles = await loadProfiles();
      const profile = profiles.find((p) => p.email.toLowerCase() === email.toLowerCase());
      const settings = await loadSettings();
      const headless = profile?.headless ?? settings.headless;

      let session: DriverSession | null = null;
      try {
        session = await openSession(email, {
          userDataRoot: profileDir(),
          headless,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/ProcessSingleton|profile is already in use|SingletonLock/i.test(msg)) {
          return {
            kind: 'busy' as const,
            message: `${email} is being used by the running worker. Stop the worker and try again.`,
          };
        }
        return { kind: 'error' as const, message: msg };
      }

      try {
        const pages = session.context.pages();
        const page = pages[0] ?? (await session.newPage());
        const outcome = await verifyOrder(page, orderId);

        if (outcome.kind === 'active') {
          await storeUpdateAttempt(attemptId, { status: 'verified', error: null });
          scheduleBroadcastJobs();
          return { kind: 'active' as const, orderId };
        }
        if (outcome.kind === 'cancelled') {
          await storeUpdateAttempt(attemptId, {
            status: 'cancelled_by_amazon',
            error: 'order was cancelled by Amazon',
          });
          scheduleBroadcastJobs();
          return { kind: 'cancelled' as const, orderId };
        }
        if (outcome.kind === 'error') {
          return { kind: 'error' as const, message: outcome.message };
        }
        return { kind: 'timeout' as const, orderId };
      } finally {
        try {
          await session.close();
        } catch {
          // already closed
        }
      }
    },
  );

  ipcMain.handle(
    IPC.jobsFetchTracking,
    async (_e, attemptId: string) => {
      // Manual fetch-tracking — runs in a fresh headless session. Same
      // 'busy' handling as jobsVerifyOrder for when the worker holds the
      // profile's userDataDir lock. Updates the local attempt row on any
      // terminal outcome so the Jobs table's tracking cell fills in
      // without waiting on a BG round-trip.
      // Prefer local store (fast path), fall back to the server-merged list
      // for rows that were synced from BG but never ran through this worker.
      // Without the fallback, server-only rows fail with "attempt not found"
      // even though they appear in the UI.
      let a = (await storeListAttempts()).find((x) => x.attemptId === attemptId);
      let serverOnly = false;
      if (!a) {
        a = (await listMergedAttempts()).find((x) => x.attemptId === attemptId);
        serverOnly = !!a;
      }
      if (!a) return { kind: 'error' as const, message: 'attempt not found' };
      if (!a.orderId) return { kind: 'error' as const, message: 'no order id on this row' };
      const email = a.amazonEmail;
      const orderId = a.orderId;

      // Mirror server-only rows into the local store so storeUpdateAttempt
      // lands — otherwise the trackingIds we fetch would vanish on next
      // broadcast until BG round-trips the field (BG doesn't yet).
      if (serverOnly) {
        await storeCreateAttempt({
          ...a,
          trackingIds: a.trackingIds ?? null,
        }).catch(() => undefined);
      }

      // Respect per-profile headless preference (fall back to global setting)
      // so the user sees the browser when they've toggled visible mode on
      // for this account — e.g. for debugging.
      const profiles = await loadProfiles();
      const profile = profiles.find((p) => p.email.toLowerCase() === email.toLowerCase());
      const settings = await loadSettings();
      const headless = profile?.headless ?? settings.headless;

      let session: DriverSession | null = null;
      try {
        session = await openSession(email, {
          userDataRoot: profileDir(),
          headless,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/ProcessSingleton|profile is already in use|SingletonLock/i.test(msg)) {
          return {
            kind: 'busy' as const,
            message: `${email} is being used by the running worker. Stop the worker and try again.`,
          };
        }
        return { kind: 'error' as const, message: msg };
      }

      try {
        const pages = session.context.pages();
        const page = pages[0] ?? (await session.newPage());
        let outcome;
        try {
          outcome = await fetchTracking(page, orderId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn('jobs.fetchTracking.threw', { attemptId, orderId, error: msg });
          return { kind: 'error' as const, message: msg };
        }

        if (outcome.kind === 'tracked' || outcome.kind === 'partial') {
          await storeUpdateAttempt(attemptId, {
            trackingIds: outcome.trackingIds,
            error: null,
          });
          // Sync to BG so the Auto Buy dashboard shows the same codes.
          // Best-effort: if BG is offline or rejects (legacy job without a
          // purchase row), swallow — local persistence already happened and
          // the user sees the codes in AmazonG.
          if (apiKey && a.jobId && a.amazonEmail) {
            try {
              const settings = await loadSettings();
              const bg = createBGClient(settings.bgBaseUrl, apiKey);
              // Pass along the local quantity so BG can heal legacy rows
              // whose purchasedCount is stuck at 0 (pre-0.5.5 thankyou fix).
              const qty = typeof a.quantity === 'number' && a.quantity > 0 ? a.quantity : undefined;
              await bg.writeTracking(a.jobId, a.amazonEmail, outcome.trackingIds, qty);
            } catch (err) {
              logger.warn('jobs.fetchTracking.bgSync.error', {
                attemptId,
                jobId: a.jobId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          scheduleBroadcastJobs();
          return {
            kind: outcome.kind,
            orderId,
            trackingIds: outcome.trackingIds,
          };
        }

        if (outcome.kind === 'cancelled') {
          await storeUpdateAttempt(attemptId, {
            status: 'cancelled_by_amazon',
            error: outcome.reason,
          });
          scheduleBroadcastJobs();
          return { kind: 'cancelled' as const, orderId, reason: outcome.reason };
        }

        if (outcome.kind === 'retry') {
          return { kind: 'retry' as const, orderId, reason: outcome.reason };
        }

        // outcome.kind === 'not_shipped'
        return { kind: 'not_shipped' as const, orderId };
      } finally {
        try {
          await session.close();
        } catch {
          // already closed
        }
      }
    },
  );

  // Manual Re-buy — user clicked Re-buy on a cancelled_by_amazon row.
  // Pushes a new phase=buy job onto BG's queue scoped to this Amazon
  // account (via placedEmail) and forced through buyWithFillers. The
  // worker polls BG and picks it up on the next 5s claim cycle.
  // Idempotent server-side: a second click while a rebuy is already
  // queued/in-progress returns the existing job.
  ipcMain.handle(
    IPC.jobsRebuy,
    async (_e, attemptId: string) => {
      if (!apiKey) {
        return { kind: 'error' as const, message: 'not connected to BG' };
      }
      let a = (await storeListAttempts()).find((x) => x.attemptId === attemptId);
      if (!a) {
        a = (await listMergedAttempts()).find((x) => x.attemptId === attemptId);
      }
      if (!a) return { kind: 'error' as const, message: 'attempt not found' };
      if (a.status !== 'cancelled_by_amazon') {
        return {
          kind: 'error' as const,
          message: `row is ${a.status}, not cancelled`,
        };
      }

      try {
        const settings = await loadSettings();
        const bg = createBGClient(settings.bgBaseUrl, apiKey);
        const r = await bg.rebuy(a.jobId, a.amazonEmail);
        logger.info('jobs.rebuy.queued', {
          attemptId,
          jobId: a.jobId,
          email: a.amazonEmail,
          newJobId: r.jobId,
          deduped: r.deduped,
        });
        scheduleBroadcastJobs();
        return {
          kind: 'queued' as const,
          jobId: r.jobId,
          deduped: r.deduped,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn('jobs.rebuy.error', { attemptId, error: message });
        return { kind: 'error' as const, message };
      }
    },
  );

  async function openOrderPageInProfile(email: string, url: string): Promise<void> {
    // If the worker is currently running AND has a live session for this
    // profile, ask it to open the URL in a new tab inside its own Chromium.
    // Otherwise a second Chromium with the same userDataDir would fail on
    // the ProcessSingleton lock, and the renderer would have to fall back
    // to the system browser.
    if (worker) {
      const opened = await worker.openProfileTab(email, url).catch(() => false);
      if (opened) {
        logger.info('amazon.orders.worker.tab', { email, url });
        return;
      }
    }

    // Open an Amazon page in this profile's persistent session so the user
    // lands already-signed-in. The window stays open until the user closes
    // it. We track one open session per email so:
    //   1. Repeated clicks don't spawn multiple windows for the same account
    //      — the existing window's tab is reused and brought to front.
    //   2. After the user closes the window, we clear the reference so the
    //      next click opens a fresh one (fixes a bug where the second click
    //      did nothing because the previous session held the userDataDir lock).
    const existing = openOrderSessions.get(email);
    if (existing) {
      let stillAlive = false;
      try {
        const pages = existing.session.context.pages();
        const page = pages[pages.length - 1];
        if (page) {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          await page.bringToFront();
          stillAlive = true;
        }
      } catch (err) {
        logger.warn('amazon.orders.focus.probe.error', { email, error: String(err) });
      }
      if (stillAlive) {
        logger.info('amazon.orders.focus', { email, url });
        return;
      }
      // Stale entry — clean up and continue to open a new window.
      logger.info('amazon.orders.stale.cleanup', { email });
      openOrderSessions.delete(email);
      try {
        await existing.session.close();
      } catch {
        // already closed
      }
    }

    logger.info('amazon.orders.open', { email, url });
    const session = await openSession(email, {
      userDataRoot: profileDir(),
      headless: false,
    });
    openOrderSessions.set(email, { session });
    session.context.on('close', () => {
      logger.info('amazon.orders.closed', { email });
      openOrderSessions.delete(email);
    });
    try {
      // Reuse the about:blank tab Chromium opens with so the user sees a
      // single tab on the target page, not blank+target.
      const existingPages = session.context.pages();
      const page = existingPages[0] ?? (await session.newPage());
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (err) {
      logger.warn('amazon.orders.nav.error', { email, error: String(err) });
    }
    // Don't close session — let the user keep the window open.
  }

  ipcMain.handle(IPC.profilesOpenOrders, async (_e, email: string) => {
    await openOrderPageInProfile(
      email,
      'https://www.amazon.com/gp/your-account/order-history?ref_=ya_d_c_yo',
    );
  });

  ipcMain.handle(
    IPC.profilesOpenOrder,
    async (_e, email: string, orderId: string) => {
      await openOrderPageInProfile(
        email,
        `https://www.amazon.com/gp/your-account/order-details?orderID=${encodeURIComponent(orderId)}`,
      );
    },
  );

  ipcMain.handle(
    IPC.profilesLogin,
    async (_e, email: string): Promise<{ loggedIn: boolean; reason?: string }> => {
      logger.info('amazon.login.start', { email });
      const session = await openSession(email, {
        userDataRoot: profileDir(),
        headless: false,
      });
      try {
        const result = await loginAmazon(session);
        logger.info('amazon.login.done', {
          email,
          loggedIn: result.loggedIn,
          reason: result.reason,
        });
        // Only auto-fill displayName when the user hasn't set one, so we
        // don't overwrite a user-chosen label with Amazon's greeting name.
        const current = (await loadProfiles()).find(
          (p) => p.email.toLowerCase() === email.toLowerCase(),
        );
        const shouldAutoName = !current?.displayName && !!result.detectedName;
        await updateProfile(email, {
          loggedIn: result.loggedIn,
          lastLoginAt: result.loggedIn ? new Date().toISOString() : undefined,
          ...(shouldAutoName ? { displayName: result.detectedName } : {}),
        });
        await broadcastProfiles();
        return { loggedIn: result.loggedIn, reason: result.reason };
      } finally {
        try {
          await session.close();
        } catch (err) {
          logger.warn('amazon.login.session.close', { email, error: String(err) });
        }
      }
    },
  );

  ipcMain.handle(IPC.profilesRefresh, async (_e, email: string): Promise<AmazonProfile | null> => {
    const session = await openSession(email, {
      userDataRoot: profileDir(),
      headless: true,
    });
    try {
      const result = await isLoggedInAmazon(session);
      const current = (await loadProfiles()).find(
        (p) => p.email.toLowerCase() === email.toLowerCase(),
      );
      const shouldAutoName = !current?.displayName && !!result.detectedName;
      const list = await updateProfile(email, {
        loggedIn: result.loggedIn,
        ...(shouldAutoName ? { displayName: result.detectedName } : {}),
      });
      await broadcastProfiles();
      return list.find((p) => p.email === email) ?? null;
    } finally {
      try {
        await session.close();
      } catch {
        // ignore
      }
    }
  });

  ipcMain.handle(
    IPC.profilesSetBgAddress,
    async (_e, email: string, address: BGAddress | null): Promise<AmazonProfile[]> => {
      const list = await updateProfile(email, { bgAddress: address });
      await broadcastProfiles();
      return list;
    },
  );

  ipcMain.handle(
    IPC.profilesSetCard,
    async (_e, email: string, cardId: string | null): Promise<AmazonProfile[]> => {
      const list = await updateProfile(email, { cardId });
      await broadcastProfiles();
      // The account→card assignment is cross-device synced.
      void pushSyncToBG();
      return list;
    },
  );

  ipcMain.handle(IPC.cardsList, async (): Promise<CreditCardSafe[]> => {
    return listCards();
  });

  ipcMain.handle(
    IPC.cardsAdd,
    async (_e, input: CreditCardInput): Promise<CreditCardSafe[]> => {
      // addCard validates + encrypts; it throws on bad input, which
      // ipcMain.handle surfaces to the renderer as a rejected invoke.
      const next = await addCard(input);
      void pushSyncToBG();
      return next;
    },
  );

  ipcMain.handle(
    IPC.cardsUpdate,
    async (_e, id: string, patch: CreditCardEdit): Promise<CreditCardSafe[]> => {
      const next = await updateCard(id, patch);
      void pushSyncToBG();
      return next;
    },
  );

  ipcMain.handle(
    IPC.cardsRemove,
    async (_e, id: string): Promise<CreditCardSafe[]> => {
      const next = await removeCard(id);
      void pushSyncToBG();
      return next;
    },
  );

  ipcMain.handle(
    IPC.profilesAddBgAddress,
    async (_e, email: string): Promise<{ ok: boolean; reason?: string; detail?: string }> => {
      const profiles = await loadProfiles();
      const profile = profiles.find((p) => p.email.toLowerCase() === email.toLowerCase());
      if (!profile) return { ok: false, reason: 'profile_not_found' };
      if (!profile.bgAddress) return { ok: false, reason: 'no_bg_address_configured' };
      logger.info('amazon.addAddress.start', { email });
      const session = await openSession(email, {
        userDataRoot: profileDir(),
        headless: false,
      });
      const page = await session.newPage();
      try {
        const result = await addAmazonAddress(page, profile.bgAddress);
        logger.info('amazon.addAddress.done', { email, ok: result.ok, ...result });
        return result.ok
          ? { ok: true }
          : { ok: false, reason: result.reason, ...(result.detail ? { detail: result.detail } : {}) };
      } finally {
        try {
          await page.close();
        } catch {
          // ignore
        }
        try {
          await session.close();
        } catch (err) {
          logger.warn('amazon.addAddress.session.close', { email, error: String(err) });
        }
      }
    },
  );

  ipcMain.handle(
    IPC.profilesFetchAddress,
    async (
      _e,
      email: string,
    ): Promise<
      | { ok: true; address: BGAddress }
      | { ok: false; reason: string; detail?: string }
    > => {
      const profiles = await loadProfiles();
      const profile = profiles.find(
        (p) => p.email.toLowerCase() === email.toLowerCase(),
      );
      if (!profile) return { ok: false, reason: 'profile_not_found' };
      const settings = await loadSettings();
      const prefixes = settings.allowedAddressPrefixes ?? [];
      if (prefixes.length === 0) {
        return { ok: false, reason: 'no_allowed_prefixes' };
      }
      logger.info('amazon.fetchAddress.start', { email, prefixes });
      const session = await openSession(email, {
        userDataRoot: profileDir(),
        headless: false,
      });
      const page = await session.newPage();
      try {
        const result = await fetchAmazonAddress(page, prefixes);
        logger.info('amazon.fetchAddress.done', { email, ok: result.ok });
        return result;
      } finally {
        try {
          await page.close();
        } catch {
          // ignore
        }
        try {
          await session.close();
        } catch (err) {
          logger.warn('amazon.fetchAddress.session.close', {
            email,
            error: String(err),
          });
        }
      }
    },
  );
}

function friendlyConnectError(err: unknown): Error {
  if (err instanceof BGApiError) {
    if (err.status === 401 || err.status === 403) {
      return new Error(
        "That key isn't valid. Double-check what you pasted, or generate a new key in the BetterBG setup guide.",
      );
    }
    if (err.status === 404) {
      return new Error(
        "BetterBG didn't recognize this key. It may have been revoked — generate a new one in the setup guide.",
      );
    }
    if (err.status >= 500) {
      return new Error('BetterBG is unreachable right now. Please try again in a moment.');
    }
    return new Error(`Couldn't connect to BetterBG (${err.status}). Please try again.`);
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network/i.test(message)) {
    return new Error("Can't reach BetterBG. Check your internet connection and try again.");
  }
  return new Error(`Something went wrong: ${message}`);
}
