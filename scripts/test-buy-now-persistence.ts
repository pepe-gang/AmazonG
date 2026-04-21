/**
 * Step B smoke test for the "Buy with Fillers" design.
 *
 * Validates the single riskiest assumption of the flow:
 *   "Clicking Buy Now POSTs the item into the shared cart as a side
 *    effect. If we navigate away from /spc before placing the order,
 *    the item is still in /gp/cart/view.html."
 *
 * If this fails, the whole buyWithFillers design has to change.
 *
 * Usage:
 *   npx tsx scripts/test-buy-now-persistence.ts \
 *     --email alice@example.com \
 *     --url https://www.amazon.com/dp/B0XXXXXXXX
 *
 * Requires the account to already be signed in via the Electron app.
 * Uses the same userData directory so cookies are shared. Browser is
 * launched VISIBLE (non-headless) so you can watch what happens.
 */
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { openSession } from '../src/browser/driver.js';

const PROMPT = '[test]';

function parseArgs(): { email: string; url: string } {
  const args = process.argv.slice(2);
  let email = '';
  let url = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--email') email = args[++i] ?? '';
    else if (args[i] === '--url') url = args[++i] ?? '';
  }
  if (!email || !url) {
    console.error(
      'Usage: tsx scripts/test-buy-now-persistence.ts ' +
        '--email <email> --url <productUrl>',
    );
    process.exit(2);
  }
  return { email, url };
}

function parseAsin(productUrl: string): string | null {
  const m = productUrl.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
  return m?.[1] ?? null;
}

async function main(): Promise<void> {
  const { email, url } = parseArgs();
  const targetAsin = parseAsin(url);
  console.log(`${PROMPT} Target ASIN: ${targetAsin ?? '(unparseable)'}`);

  // Point Playwright at the app's bundled Chromium if we can find it —
  // otherwise fall back to Playwright's default cache.
  const bundled = resolve(process.cwd(), 'build-browsers');
  if (existsSync(bundled) && !process.env.PLAYWRIGHT_BROWSERS_PATH) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = bundled;
    console.log(`${PROMPT} PLAYWRIGHT_BROWSERS_PATH=${bundled}`);
  }

  // macOS default Electron userData dir. Override with AMAZONG_USERDATA
  // env var if you're on Linux/Windows or have a custom install.
  const userDataRoot =
    process.env.AMAZONG_USERDATA ??
    join(
      homedir(),
      'Library',
      'Application Support',
      'AmazonG',
      'amazon-profiles',
    );
  console.log(`${PROMPT} userDataRoot: ${userDataRoot}`);

  const session = await openSession(email, { userDataRoot, headless: false });
  const page = await session.newPage();

  try {
    console.log(`${PROMPT} 1/6 loading product page…`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    console.log(`${PROMPT} 2/6 waiting for #buy-now-button…`);
    await page.waitForSelector('#buy-now-button', {
      state: 'visible',
      timeout: 15_000,
    });

    console.log(`${PROMPT} 3/6 clicking Buy Now…`);
    await page.locator('#buy-now-button').first().click({ timeout: 10_000 });

    console.log(`${PROMPT} 4/6 waiting for /spc URL…`);
    await page.waitForURL(/\/gp\/buy\/|\/checkout\/|\/spc\//i, {
      timeout: 20_000,
    });
    console.log(`${PROMPT}     reached: ${page.url()}`);

    console.log(`${PROMPT} 5/6 navigating AWAY from /spc to cart view…`);
    await page.goto('https://www.amazon.com/gp/cart/view.html?ref_=nav_cart', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    console.log(`${PROMPT} 6/6 checking if target ASIN survived in cart…`);
    let inCart = false;
    let detail = '';
    if (targetAsin) {
      const direct = await page
        .locator(`[data-name="Active Cart"] [data-asin="${targetAsin}"]`)
        .count();
      const linkMatch = await page
        .locator(
          `[data-name="Active Cart"] a[href*="/dp/${targetAsin}"], ` +
            `[data-name="Active Cart"] a[href*="/gp/product/${targetAsin}"]`,
        )
        .count();
      inCart = direct > 0 || linkMatch > 0;
      detail = `data-asin=${direct}, link=${linkMatch}`;
    } else {
      const anyRow = await page
        .locator('[data-name="Active Cart"] [data-asin]')
        .count();
      inCart = anyRow > 0;
      detail = `any-row=${anyRow}`;
    }
    console.log(`${PROMPT}     ${detail}`);

    if (inCart) {
      console.log('');
      console.log(`${PROMPT} ✅ PASS — target is in cart after Buy Now + nav away.`);
      console.log(`${PROMPT} The Buy-Now-as-Add-to-Cart trick works.`);
      console.log(`${PROMPT} Leaving browser open 20s so you can inspect manually…`);
      await page.waitForTimeout(20_000);
      process.exit(0);
    } else {
      console.log('');
      console.log(`${PROMPT} ❌ FAIL — target NOT in cart after Buy Now + nav away.`);
      console.log(`${PROMPT} The design assumption is wrong. Leaving browser open 60s`);
      console.log(`${PROMPT} so you can check cart state, cookies, etc.`);
      await page.waitForTimeout(60_000);
      process.exit(1);
    }
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error(`${PROMPT} fatal:`, err);
  process.exit(1);
});
