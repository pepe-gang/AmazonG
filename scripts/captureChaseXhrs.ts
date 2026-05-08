/**
 * One-shot research capture: navigate to every Chase page AmazonG
 * scrapes today, log every JSON XHR the SPA fires during the visit,
 * dump to research-logs/chase-xhr-{profileId}-{ts}.jsonl.
 *
 * Purpose: Stage B passive-XHR-interception (see
 * docs/research/chase-perf-deep-dive-pass2-2026-05-07.md). We hypothesize
 * Chase serves the recon-bar, payment-activity, and rewards-points data
 * via JSON XHRs the SPA fires during hydration. If true, we can resolve
 * snapshot-fetch values from those XHR responses INSTEAD of waiting for
 * the SPA to paint the DOM and then scraping selectors — saves 2-6s per
 * fetch with zero anti-bot risk (we don't issue any new requests).
 *
 * This script confirms the hypothesis empirically and surfaces the
 * exact endpoint paths + response shapes we'd need to write the
 * production interceptor against.
 *
 * Usage:
 *   1. Quit AmazonG (this script needs the userDataDir lock).
 *   2. npx tsx scripts/captureChaseXhrs.ts <profileId> <cardAccountId>
 *      Get the values from AmazonG's Bank tab — profileId is the row's
 *      UUID-ish folder name under ~/Library/Application Support/AmazonG/
 *      chase-profiles/, cardAccountId is what AmazonG's logs print as
 *      `cardAccountId` in any chase.snapshot.* line.
 *   3. Output lands in ./research-logs/chase-xhr-<profileId>-<ts>.jsonl.
 *      Each line: {ts, page, event, url, status, contentType, bodyLen,
 *      body?}. JSON bodies are inlined; non-JSON bodies just get
 *      bodyLen so the file stays grep-friendly.
 *
 * Anti-bot note: this script reuses the existing warm persistent
 * context from AmazonG. No fresh-session probing — the cookies,
 * localStorage device-trust token, and all anti-bot init scripts are
 * the same as a normal AmazonG fetch. Behavior visible to Chase is
 * indistinguishable from a normal user-triggered Bank-tab refresh.
 */
import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP_NAME = 'AmazonG';

function userDataRoot(): string {
  return join(homedir(), 'Library', 'Application Support', APP_NAME);
}

function chaseProfileDir(profileId: string): string {
  // Mirrors src/main/chaseProfiles.ts:chaseProfileDir but doesn't
  // depend on Electron's app.getPath. macOS userData layout.
  const safe = profileId.replace(/[^a-zA-Z0-9-]/g, '');
  if (!safe) throw new Error(`bad profile id: ${JSON.stringify(profileId)}`);
  return join(userDataRoot(), 'chase-profiles', safe);
}

function chaseSessionStatePath(profileId: string): string {
  // Mirrors src/main/chaseProfiles.ts:chaseSessionStatePath. The JSON
  // store next to the profile dir holds session cookies + origin
  // localStorage that Chromium's SQLite drops on close — without
  // restoring this, the script's persistent context comes up
  // "logged out" even when AmazonG would have shown it as warm.
  const safe = profileId.replace(/[^a-zA-Z0-9-]/g, '');
  return join(userDataRoot(), 'chase-profiles', `${safe}.session.json`);
}

type ChaseProfileMeta = {
  id: string;
  label?: string | null;
  cardAccountId?: string | null;
  loggedIn?: boolean;
};

async function listProfiles(): Promise<ChaseProfileMeta[]> {
  const path = join(userDataRoot(), 'chase-profiles.json');
  try {
    const raw = await readFile(path, 'utf8');
    const arr = JSON.parse(raw) as ChaseProfileMeta[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

type CapturedEvent = {
  ts: number;
  page: 'summary' | 'activity' | 'loyalty';
  event: 'request' | 'response';
  url: string;
  method?: string;
  status?: number;
  contentType?: string;
  bodyLen?: number;
  body?: unknown;
  reqHeaders?: Record<string, string>;
};

async function main(): Promise<void> {
  let [profileId, cardAccountId] = process.argv.slice(2);

  // Auto-resolve from chase-profiles.json when args are missing or
  // there's only one profile. Quality-of-life so the user doesn't
  // have to dig in their userData dir.
  if (!profileId || !cardAccountId) {
    const profiles = await listProfiles();
    const usable = profiles.filter((p) => p.cardAccountId);
    if (usable.length === 0) {
      console.error(
        'No chase profiles with a captured cardAccountId found.\n' +
          'Open AmazonG → Bank tab → Login on a card first, then re-run.',
      );
      process.exit(1);
    }
    if (!profileId && usable.length === 1) {
      const only = usable[0]!;
      profileId = only.id;
      cardAccountId = only.cardAccountId!;
      console.log(
        `auto-selected only profile: ${only.label ?? '(unlabeled)'} ` +
          `(id=${profileId.slice(0, 8)}…, card=${cardAccountId})`,
      );
    } else if (!profileId) {
      console.error('Multiple chase profiles — pick one:\n');
      for (const p of usable) {
        console.error(
          `  ${p.id}  card=${p.cardAccountId}  ${p.label ?? '(unlabeled)'}`,
        );
      }
      console.error(
        '\nUsage: npx tsx scripts/captureChaseXhrs.ts <profileId> [cardAccountId]',
      );
      process.exit(1);
    } else if (!cardAccountId) {
      const match = profiles.find((p) => p.id === profileId);
      if (!match?.cardAccountId) {
        console.error(`profile ${profileId} has no cardAccountId yet`);
        process.exit(1);
      }
      cardAccountId = match.cardAccountId;
      console.log(`using card=${cardAccountId} for profile ${profileId.slice(0, 8)}…`);
    }
  }

  const userDataDir = chaseProfileDir(profileId);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(process.cwd(), 'research-logs');
  await mkdir(outDir, { recursive: true });
  const outFile = join(outDir, `chase-xhr-${profileId}-${ts}.jsonl`);
  await writeFile(outFile, ''); // truncate
  console.log(`writing to ${outFile}`);

  const { chromium } = await import('playwright');
  // Mirror src/main/chaseDriver.ts:openChaseSession launch settings
  // so the captured behavior matches production exactly.
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-default-browser-check',
      '--no-first-run',
    ],
  });
  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    } catch {
      /* best-effort */
    }
  });

  // Restore the JSON-backed session state (cookies + origin localStorage).
  // Mirrors openChaseSession in chaseDriver.ts. Without this, Chromium
  // launches with whatever its SQLite persisted — which excludes session
  // cookies — and Chase treats us as a fresh device every run.
  try {
    const raw = await readFile(chaseSessionStatePath(profileId), 'utf8');
    const state = JSON.parse(raw) as {
      cookies?: Array<Parameters<(typeof context)['addCookies']>[0][number]>;
      origins?: Array<{
        origin: string;
        localStorage?: Array<{ name: string; value: string }>;
      }>;
    };
    if (Array.isArray(state.cookies) && state.cookies.length > 0) {
      await context.addCookies(state.cookies);
      console.log(`restored ${state.cookies.length} cookies from session state`);
    }
    const initParts: string[] = [];
    let restoredKeys = 0;
    for (const origin of state.origins ?? []) {
      if (!origin.localStorage || origin.localStorage.length === 0) continue;
      const setStmts = origin.localStorage
        .map(
          (item) =>
            `if (localStorage.getItem(${JSON.stringify(item.name)}) === null) ` +
            `localStorage.setItem(${JSON.stringify(item.name)}, ${JSON.stringify(
              item.value,
            )});`,
        )
        .join('');
      restoredKeys += origin.localStorage.length;
      initParts.push(
        `if (location.origin === ${JSON.stringify(origin.origin)}) { ` +
          `try { ${setStmts} } catch (e) { /* private mode */ } }`,
      );
    }
    if (initParts.length > 0) {
      await context.addInitScript({ content: initParts.join('\n') });
      console.log(`restored ${restoredKeys} localStorage keys`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(
        `warning: could not restore session state: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const page = context.pages()[0] ?? (await context.newPage());

  let currentPageLabel: 'summary' | 'activity' | 'loyalty' = 'summary';

  const append = async (ev: CapturedEvent): Promise<void> => {
    await appendFile(outFile, JSON.stringify(ev) + '\n');
  };

  // Capture EVERY request's headers — we want to see Authorization,
  // X-CSRF-Token, X-JPMC-*, etc. for the in-page-fetch replay strategy
  // (Stage C). Header capture is cheap and the file is research-only.
  page.on('request', (req) => {
    const url = req.url();
    // Only log XHR/fetch — page navigations and sub-resources just
    // create noise. Chase's SPA loads ~100 sub-resources per page.
    const rt = req.resourceType();
    if (rt !== 'xhr' && rt !== 'fetch') return;
    void append({
      ts: Date.now(),
      page: currentPageLabel,
      event: 'request',
      url,
      method: req.method(),
      reqHeaders: req.headers(),
    });
  });

  page.on('response', async (resp) => {
    const url = resp.url();
    const req = resp.request();
    const rt = req.resourceType();
    if (rt !== 'xhr' && rt !== 'fetch') return;
    const contentType = resp.headers()['content-type'] ?? '';
    let body: unknown;
    let bodyLen = 0;
    try {
      const buf = await resp.body();
      bodyLen = buf.length;
      // Inline JSON bodies (the data we care about). Other bodies just
      // get a length stamp so grep-by-URL still finds them.
      if (contentType.includes('application/json') && bodyLen < 2_000_000) {
        try {
          body = JSON.parse(buf.toString('utf8'));
        } catch {
          body = buf.toString('utf8').slice(0, 4000);
        }
      }
    } catch {
      // Some responses (redirects, blocked requests) can't be read.
    }
    await append({
      ts: Date.now(),
      page: currentPageLabel,
      event: 'response',
      url,
      status: resp.status(),
      contentType,
      bodyLen,
      body,
    });
  });

  // Same nav sequence as src/main/chaseDriver.ts:runFetch (post Tier A
  // reorder): summary → activity → loyalty. waitUntil:'load' instead
  // of 'domcontentloaded' so we capture the full hydration tail —
  // including any XHRs the SPA fires after DOM is ready. Idle wait
  // afterward gives time for late-firing telemetry / lazy-loaded
  // module XHRs to land too.
  console.log('1) summary page');
  currentPageLabel = 'summary';
  await page.goto(
    `https://secure.chase.com/web/auth/dashboard#/dashboard/summary/${encodeURIComponent(
      cardAccountId,
    )}/CARD/BAC`,
    { waitUntil: 'load', timeout: 60_000 },
  );

  // Detect expired-session: if Chase shoved us onto the logon page
  // (or overlaid the logonbox iframe), the captured XHRs would all be
  // login-flow noise — useless for our purpose. Pause and let the
  // user complete login in the visible Chrome window. We don't
  // auto-fill creds because Electron's safeStorage isn't reachable
  // from a tsx script. Once the URL leaves /logon AND the recon-bar
  // is visible, we resume.
  const onLogon = (): boolean =>
    /\/logon|identity-verification|identityProtection|\/auth\/totp/i.test(page.url());
  // Poll for ~3s — Chase's logon overlay can take a beat to attach
  // after waitUntil:'load' returns. Also widen the detection: many
  // expired-session paths render a login form INLINE in the SPA
  // shell (no /logon URL change, no iframe — just a logon-page
  // resource fetch). The Akamai login-shell URLs are a reliable
  // tell that the page never reached the dashboard.
  let overlayPresent = false;
  let inlineLoginShell = false;
  for (let i = 0; i < 10; i++) {
    overlayPresent = (await page.locator('iframe#logonbox').count().catch(() => 0)) > 0;
    inlineLoginShell =
      (await page
        .locator('text=/Sign in|User ID|Forgot password/i')
        .count()
        .catch(() => 0)) > 0;
    if (overlayPresent || inlineLoginShell || onLogon()) break;
    await page.waitForTimeout(300);
  }
  if (onLogon() || overlayPresent || inlineLoginShell) {
    console.log(
      '\n⚠  Chase session expired or 2FA needed.\n' +
        '   Complete login in the open Chrome window — script will resume\n' +
        '   automatically once you reach the card summary page.\n' +
        '   (5-minute timeout)\n',
    );
    try {
      await page.waitForURL(
        (url) =>
          !/\/logon|identity-verification|identityProtection|\/auth\/totp/i.test(
            url.toString(),
          ),
        { timeout: 5 * 60_000 },
      );
      // Also wait for the iframe overlay (if any) to detach.
      await page
        .locator('iframe#logonbox')
        .waitFor({ state: 'detached', timeout: 30_000 })
        .catch(() => undefined);
      console.log('✓ login complete, capturing summary page XHRs...\n');
    } catch {
      console.error('login timed out after 5 minutes — bailing');
      await context.close();
      process.exit(1);
    }
    // Re-navigate to the summary URL now that we're authed — the
    // post-login redirect probably landed elsewhere (overview /
    // dashboard root), and we want the summary-specific XHRs.
    await page.goto(
      `https://secure.chase.com/web/auth/dashboard#/dashboard/summary/${encodeURIComponent(
        cardAccountId,
      )}/CARD/BAC`,
      { waitUntil: 'load', timeout: 60_000 },
    );
  }
  // Generous post-nav idle so trailing XHRs (lazy modules, late
  // telemetry) have time to land before we move on.
  await page.waitForTimeout(8_000);

  console.log('2) payment activity page');
  currentPageLabel = 'activity';
  await page.goto(
    `https://secure.chase.com/web/auth/dashboard#/dashboard/payBillsArea/paymentsActivity/selectPayee;payeeId=-${encodeURIComponent(
      cardAccountId,
    )};payeeType=CREDIT_CARD`,
    { waitUntil: 'load', timeout: 60_000 },
  );
  await page.waitForTimeout(8_000);

  console.log('3) loyalty home page');
  currentPageLabel = 'loyalty';
  await page.goto(
    `https://chaseloyalty.chase.com/home?AI=${encodeURIComponent(cardAccountId)}`,
    { waitUntil: 'load', timeout: 60_000 },
  );
  await page.waitForTimeout(8_000);

  await context.close();
  console.log(`\ncapture complete → ${outFile}`);
  console.log(`\nNext step: read the JSONL and identify which URLs returned`);
  console.log(`the JSON containing your card's balance, available credit,`);
  console.log(`pending charges, in-process payments, and rewards points.`);
  console.log(`\nQuick survey:`);
  console.log(`  jq -r 'select(.event=="response" and .status==200 and (.contentType|tostring|contains("json"))) | "\\(.page)\\t\\(.url)"' < "${outFile}" | sort -u`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
