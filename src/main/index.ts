import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IPC, type Settings } from '../shared/ipc.js';
import { createBGClient, type ServerPurchase } from '../bg/client.js';
import { startWorker, type WorkerHandle } from '../workflows/pollAndScrape.js';
import { addLogSink, logger } from '../shared/logger.js';
import {
  appendLog as storeAppendLog,
  clearAll as storeClearAll,
  clearCanceled as storeClearCanceled,
  clearFailed as storeClearFailed,
  createAttempt as storeCreateAttempt,
  deleteAttempt as storeDeleteAttempt,
  listAttempts as storeListAttempts,
  pruneOlderThan,
  readLogs as storeReadLogs,
  updateAttempt as storeUpdateAttempt,
} from './jobStore.js';
import { verifyOrder } from '../actions/verifyOrder.js';
import { makeAttemptId } from '../shared/sanitize.js';
import type { JobAttempt, JobAttemptStatus } from '../shared/types.js';
import { BGApiError } from '../shared/errors.js';
import { loadIdentity, saveIdentity, clearIdentity } from './identity.js';
import { loadSettings, saveSettings } from './settings.js';
import {
  loadProfiles,
  newProfile,
  removeProfile as removeProfileFn,
  reorderProfiles,
  updateProfile,
  upsertProfile,
} from './profiles.js';
import { openSession } from '../browser/driver.js';
import { snapshotDir, snapshotsDiskUsage, clearAllSnapshots } from '../browser/snapshot.js';
import { compareSemver } from '../shared/version.js';
import { isLoggedInAmazon, loginAmazon } from '../actions/loginAmazon.js';
import type { AmazonProfile, IdentityInfo, RendererStatus } from '../shared/types.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

app.setName('AmazonG');

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

// User-driven Playwright sessions kept open for "Your Orders" windows. Keyed
// by Amazon profile email. We track these so repeated clicks focus the
// existing window instead of trying to launch another persistent context
// against the same (still-locked) userDataDir.
import type { DriverSession } from '../browser/driver.js';
const openOrderSessions = new Map<string, { session: DriverSession }>();

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

// Coalesce job-list broadcasts so a fan-out across N profiles doesn't
// fire 2N+ full-list IPC sends. Trailing 100ms timer is enough for the
// renderer to look smooth while collapsing burst updates.
let jobsBroadcastTimer: NodeJS.Timeout | null = null;
function scheduleBroadcastJobs(): void {
  if (jobsBroadcastTimer) return;
  jobsBroadcastTimer = setTimeout(() => {
    jobsBroadcastTimer = null;
    void listMergedAttempts()
      .then((list) => mainWindow?.webContents.send(IPC.evtJobs, list))
      .catch(() => undefined);
  }, 100);
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
    dryRun: false,
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
      merged.set(k, { ...existing, attemptId: l.attemptId, dryRun: l.dryRun });
    } else {
      merged.set(k, l);
    }
  }

  return Array.from(merged.values()).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}

function profileDir(): string {
  return join(app.getPath('userData'), 'amazon-profiles');
}

const ONBOARDING_SIZE = { width: 500, height: 580 } as const;
const APP_SIZE = { width: 1800, height: 1150 } as const;

function createWindow(): void {
  const connected = identity !== null;
  const size = connected ? APP_SIZE : ONBOARDING_SIZE;
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
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
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
    minCashbackPct: settings.minCashbackPct,
    allowedAddressPrefixes: settings.allowedAddressPrefixes,
    listEligibleProfiles: async () => {
      const list = await loadProfiles();
      return list.filter((p) => p.enabled && p.loggedIn);
    },
    jobAttempts: {
      async create(partial) {
        const a = await storeCreateAttempt(partial);
        scheduleBroadcastJobs();
        return a;
      },
      async update(attemptId, patch) {
        const a = await storeUpdateAttempt(attemptId, patch);
        scheduleBroadcastJobs();
        return a;
      },
    },
  });
  lastError = null;
  broadcastStatus();
}

app.whenReady().then(async () => {
  addLogSink((ev) => {
    mainWindow?.webContents.send(IPC.evtLog, ev);
  });
  // Per-attempt log routing: any log carrying both `jobId` and `profile`
  // gets appended to that attempt's JSONL log file. The renderer fetches
  // these per-row via IPC.
  addLogSink((ev) => {
    const data = ev.data as Record<string, unknown> | undefined;
    const jobId = typeof data?.jobId === 'string' ? data.jobId : null;
    const profile = typeof data?.profile === 'string' ? data.profile : null;
    if (!jobId || !profile) return;
    const attemptId = makeAttemptId(jobId, profile);
    void storeAppendLog(attemptId, ev).catch(() => undefined);
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
  if (worker) {
    try {
      await worker.stop();
    } catch (err) {
      logger.warn('worker.stop.error', { error: String(err) });
    }
    worker = null;
  }
  const orderSessions = Array.from(openOrderSessions.values());
  openOrderSessions.clear();
  await Promise.all(
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
let quittingCleanly = false;
app.on('before-quit', async (e) => {
  if (quittingCleanly) return;
  e.preventDefault();
  try {
    await closeAllChromiumSessions();
  } catch (err) {
    logger.warn('app.quit.cleanup.error', { error: String(err) });
  } finally {
    quittingCleanly = true;
    app.quit();
  }
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
    return me;
  });

  ipcMain.handle(IPC.identityDisconnect, async () => {
    if (worker) {
      await worker.stop();
      worker = null;
    }
    identity = null;
    apiKey = null;
    await clearIdentity();
    resizeToOnboarding();
    broadcastStatus();
  });

  ipcMain.handle(IPC.workerStart, () => startWorkerNow());

  ipcMain.handle(IPC.workerStop, async () => {
    if (!worker) return;
    await worker.stop();
    worker = null;
    broadcastStatus();
  });

  ipcMain.handle(IPC.statusGet, () => status());

  ipcMain.handle(IPC.settingsGet, () => loadSettings());

  ipcMain.handle(IPC.settingsSet, async (_e, partial: Partial<Settings>) => {
    const current = await loadSettings();
    const merged = { ...current, ...partial };
    await saveSettings(merged);
    return merged;
  });

  ipcMain.handle(IPC.openExternal, async (_e, url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('invalid url');
    await shell.openExternal(url);
  });

  ipcMain.handle(IPC.appVersion, () => app.getVersion());

  ipcMain.handle(IPC.versionCheck, async () => {
    const current = app.getVersion();
    if (!apiKey) return { updateAvailable: false, latest: null, current };
    try {
      const settings = await loadSettings();
      const bg = createBGClient(settings.bgBaseUrl, apiKey);
      const info = await bg.checkVersion();
      if (!info.latestVersion) return { updateAvailable: false, latest: null, current };
      const updateAvailable = compareSemver(info.latestVersion, current) > 0;
      return { updateAvailable, latest: info.latestVersion, current };
    } catch {
      return { updateAvailable: false, latest: null, current };
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
      return list;
    },
  );

  ipcMain.handle(IPC.profilesRemove, async (_e, email: string) => {
    const list = await removeProfileFn(email);
    await broadcastProfiles(list);
    return list;
  });

  ipcMain.handle(IPC.profilesSetEnabled, async (_e, email: string, enabled: boolean) => {
    const list = await updateProfile(email, { enabled });
    await broadcastProfiles(list);
    return list;
  });

  ipcMain.handle(
    IPC.profilesSetHeadless,
    async (_e, email: string, headless: boolean) => {
      const list = await updateProfile(email, { headless });
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
    await storeDeleteAttempt(attemptId);
    scheduleBroadcastJobs();
  });

  ipcMain.handle(
    IPC.jobsVerifyOrder,
    async (_e, attemptId: string) => {
      // Look up the attempt → resolve email + orderId → run verifyOrder in
      // a fresh headless session. If the worker is running and holding the
      // profile's userDataDir lock, return 'busy' so the renderer toasts a
      // clear "stop the worker" message instead of throwing a raw lock
      // error.
      const list = await storeListAttempts();
      const a = list.find((x) => x.attemptId === attemptId);
      if (!a) return { kind: 'error' as const, message: 'attempt not found' };
      if (!a.orderId) return { kind: 'error' as const, message: 'no order id on this row' };
      const email = a.amazonEmail;
      const orderId = a.orderId;

      let session: DriverSession | null = null;
      try {
        session = await openSession(email, {
          userDataRoot: profileDir(),
          headless: true,
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
