import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IPC, type Settings } from '../shared/ipc.js';
import { createBGClient } from '../bg/client.js';
import { startWorker, type WorkerHandle } from '../workflows/pollAndScrape.js';
import { addLogSink, logger } from '../shared/logger.js';
import { BGApiError } from '../shared/errors.js';
import { loadIdentity, saveIdentity, clearIdentity } from './identity.js';
import { loadSettings, saveSettings } from './settings.js';
import {
  loadProfiles,
  newProfile,
  removeProfile as removeProfileFn,
  updateProfile,
  upsertProfile,
} from './profiles.js';
import { openSession } from '../browser/driver.js';
import { isLoggedInAmazon, loginAmazon } from '../actions/loginAmazon.js';
import type { AmazonProfile, IdentityInfo, RendererStatus } from '../shared/types.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

app.setName('AmazonG');

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

async function broadcastProfiles(): Promise<void> {
  const list = await loadProfiles();
  mainWindow?.webContents.send(IPC.evtProfiles, list);
}

function profileDir(): string {
  return join(app.getPath('userData'), 'amazon-profiles');
}

const ONBOARDING_SIZE = { width: 500, height: 580 } as const;
const APP_SIZE = { width: 1200, height: 800 } as const;

function createWindow(): void {
  const connected = identity !== null;
  const size = connected ? APP_SIZE : ONBOARDING_SIZE;
  mainWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: connected ? 900 : size.width,
    minHeight: connected ? 600 : size.height,
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
  mainWindow.setMinimumSize(900, 600);
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

app.whenReady().then(async () => {
  addLogSink((ev) => {
    mainWindow?.webContents.send(IPC.evtLog, ev);
  });

  const stored = await loadIdentity();
  if (stored) {
    identity = stored.identity;
    apiKey = stored.apiKey;
  }

  registerIpcHandlers();
  createWindow();
  broadcastStatus();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  if (worker) {
    try {
      await worker.stop();
    } catch (err) {
      logger.warn('worker.stop.error', { error: String(err) });
    }
    worker = null;
  }
  if (process.platform !== 'darwin') app.quit();
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

  ipcMain.handle(IPC.workerStart, async () => {
    if (worker) return;
    if (!apiKey) throw new Error('not connected');
    const settings = await loadSettings();
    const bg = createBGClient(settings.bgBaseUrl, apiKey);
    worker = startWorker({
      bg,
      userDataRoot: profileDir(),
      headless: settings.headless,
      buyDryRun: settings.buyDryRun,
      minCashbackPct: settings.minCashbackPct,
      allowedAddressPrefixes: settings.allowedAddressPrefixes,
      listEligibleProfiles: async () => {
        const list = await loadProfiles();
        return list.filter((p) => p.enabled && p.loggedIn);
      },
    });
    lastError = null;
    broadcastStatus();
  });

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
      await broadcastProfiles();
      return list;
    },
  );

  ipcMain.handle(IPC.profilesRemove, async (_e, email: string) => {
    const list = await removeProfileFn(email);
    await broadcastProfiles();
    return list;
  });

  ipcMain.handle(IPC.profilesSetEnabled, async (_e, email: string, enabled: boolean) => {
    const list = await updateProfile(email, { enabled });
    await broadcastProfiles();
    return list;
  });

  ipcMain.handle(
    IPC.profilesRename,
    async (_e, email: string, displayName: string | null) => {
      const clean = displayName?.trim() || null;
      const list = await updateProfile(email, { displayName: clean });
      await broadcastProfiles();
      return list;
    },
  );

  ipcMain.handle(IPC.profilesOpenOrders, async (_e, email: string) => {
    // Open Amazon's order history in this profile's persistent session so
    // the user lands already-signed-in. The window stays open until the
    // user closes it. We track one open session per email so:
    //   1. Repeated clicks don't spawn multiple windows for the same account
    //      — the existing window gets focused instead.
    //   2. After the user closes the window, we clear the reference so the
    //      next click opens a fresh one (fixes a bug where the second click
    //      did nothing because the previous session held the userDataDir lock).
    // 1. If we think there's an existing window for this account, probe it.
    //    The close event may not have fired yet (or never fires reliably for
    //    persistent contexts), so we always verify the context still has
    //    open pages before reusing it. If the probe fails, we treat the
    //    session as dead and fall through to open a fresh one.
    const existing = openOrderSessions.get(email);
    if (existing) {
      let stillAlive = false;
      try {
        const pages = existing.session.context.pages();
        const page = pages[pages.length - 1];
        if (page) {
          await page.bringToFront();
          stillAlive = true;
        }
      } catch (err) {
        logger.warn('amazon.orders.focus.probe.error', { email, error: String(err) });
      }
      if (stillAlive) {
        logger.info('amazon.orders.focus', { email });
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

    logger.info('amazon.orders.open', { email });
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
      // single tab on the order page, not blank+order.
      const existingPages = session.context.pages();
      const page = existingPages[0] ?? (await session.newPage());
      await page.goto(
        'https://www.amazon.com/gp/your-account/order-history?ref_=ya_d_c_yo',
        { waitUntil: 'domcontentloaded', timeout: 30_000 },
      );
    } catch (err) {
      logger.warn('amazon.orders.nav.error', { email, error: String(err) });
    }
    // Don't close session — let the user keep the window open.
  });

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
