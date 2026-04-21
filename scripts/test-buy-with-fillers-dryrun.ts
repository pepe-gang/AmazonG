/**
 * Full dry-run smoke test for the Buy-with-Fillers orchestrator.
 *
 * Runs the complete 15-step flow against a real Amazon account with
 * `dryRun: true` so every step executes — cart clear, product verify,
 * Buy Now click, filler search + 12 adds, Proceed to Checkout, address
 * swap, BG1/BG2 name toggle if cashback < min, target-price +
 * target-cashback + target-quantity reads — and stops immediately
 * before the irreversible Place Order click.
 *
 * Use this to smoke-test the whole pipeline without spending money.
 *
 * Usage:
 *   npx tsx scripts/test-buy-with-fillers-dryrun.ts \
 *     --email alice@example.com \
 *     --url https://www.amazon.com/dp/B0XXXXXXXX \
 *     [--max-price 120] \
 *     [--min-cashback 6] \
 *     [--prefixes 13132,13130,1146]
 *
 * The account must already be signed in via the Electron app (reuses
 * the shared userData dir). The Electron app MUST be closed — Chromium
 * locks the userData dir to one process. Browser launches visible so
 * you can watch every step.
 */
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { openSession } from '../src/browser/driver.js';
import { buyWithFillers } from '../src/actions/buyWithFillers.js';

const PROMPT = '[dryrun]';
const DEFAULT_PREFIXES = ['13132', '13130', '1146'];
const DEFAULT_MIN_CASHBACK = 6;

type Args = {
  email: string;
  url: string;
  maxPrice: number | null;
  minCashback: number;
  prefixes: string[];
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let email = '';
  let url = '';
  let maxPrice: number | null = null;
  let minCashback = DEFAULT_MIN_CASHBACK;
  let prefixes = DEFAULT_PREFIXES;

  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--email') email = argv[++i] ?? '';
    else if (k === '--url') url = argv[++i] ?? '';
    else if (k === '--max-price') {
      const v = parseFloat(argv[++i] ?? '');
      maxPrice = Number.isFinite(v) ? v : null;
    } else if (k === '--min-cashback') {
      const v = parseInt(argv[++i] ?? '', 10);
      if (Number.isFinite(v)) minCashback = v;
    } else if (k === '--prefixes') {
      prefixes = (argv[++i] ?? '')
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
    }
  }

  if (!email || !url) {
    console.error(
      'Usage: tsx scripts/test-buy-with-fillers-dryrun.ts ' +
        '--email <email> --url <productUrl> ' +
        '[--max-price N] [--min-cashback N] [--prefixes p1,p2,p3]',
    );
    process.exit(2);
  }
  return { email, url, maxPrice, minCashback, prefixes };
}

async function main(): Promise<void> {
  const args = parseArgs();

  // Prefer the app's bundled Chromium if present.
  const bundled = resolve(process.cwd(), 'build-browsers');
  if (existsSync(bundled) && !process.env.PLAYWRIGHT_BROWSERS_PATH) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = bundled;
  }

  const userDataRoot =
    process.env.AMAZONG_USERDATA ??
    join(
      homedir(),
      'Library',
      'Application Support',
      'AmazonG',
      'amazon-profiles',
    );

  console.log(`${PROMPT} ═══ Buy with Fillers — Dry Run ═══`);
  console.log(`${PROMPT}   account:       ${args.email}`);
  console.log(`${PROMPT}   product:       ${args.url}`);
  console.log(`${PROMPT}   max price:     ${args.maxPrice ?? '(no cap)'}`);
  console.log(`${PROMPT}   min cashback:  ${args.minCashback}%`);
  console.log(`${PROMPT}   zip prefixes:  [${args.prefixes.join(', ')}]`);
  console.log(`${PROMPT}   userDataRoot:  ${userDataRoot}`);
  console.log(
    `${PROMPT}   plan:          clear cart → verify → buy now → 12 fillers → spc → ` +
      `price/addr/cashback/qty reads → STOP (no Place Order)`,
  );
  console.log('');

  const session = await openSession(args.email, {
    userDataRoot,
    headless: false,
  });
  // Reuse the context's initial blank page (same pattern as runForProfile).
  const existing = session.context.pages();
  const page = existing[0] ?? (await session.newPage());

  try {
    const started = Date.now();
    const result = await buyWithFillers(page, {
      productUrl: args.url,
      maxPrice: args.maxPrice,
      allowedAddressPrefixes: args.prefixes,
      minCashbackPct: args.minCashback,
      dryRun: true,
      correlationId: `dryrun-${Date.now()}`,
    });
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    console.log('');
    console.log(`${PROMPT} ═══ Result (${elapsed}s) ═══`);
    console.log(JSON.stringify(result, null, 2));
    console.log('');

    if (result.ok) {
      if (result.stage === 'dry_run_success') {
        console.log(`${PROMPT} ✅ PASS — reached dry_run_success`);
        console.log(
          `${PROMPT}   fillers:        ${result.fillersAdded}/${result.fillersRequested}`,
        );
        console.log(`${PROMPT}   target qty:     ${result.placedQuantity ?? '(null)'}`);
        console.log(
          `${PROMPT}   target cashback: ${result.targetCashbackPct ?? '(null)'}%`,
        );
      } else {
        // Should never reach 'placed' in dry-run mode — log loudly if so.
        console.log(
          `${PROMPT} ⚠  Unexpected stage '${result.stage}' — dry-run gate missed a path`,
        );
      }
      console.log(
        `${PROMPT} Leaving browser open 10 min for manual inspection of /spc.`,
      );
      console.log(`${PROMPT} Press Ctrl-C in this terminal to exit sooner.`);
      await page.waitForTimeout(600_000);
      process.exit(0);
    } else {
      console.log(`${PROMPT} ❌ FAIL at stage '${result.stage}': ${result.reason}`);
      if ('detail' in result && result.detail) {
        console.log(`${PROMPT}    detail: ${result.detail}`);
      }
      console.log(`${PROMPT} URL at failure: ${page.url()}`);

      // Dump every visible button/input/role=button on the failure page so
      // we can see what Chewbacca is actually rendering when a selector or
      // text-label match misses. Most useful when the stage is 'spc_ready'
      // ("Place Order button never appeared").
      const buttons = await page
        .evaluate(() => {
          const els = Array.from(
            document.querySelectorAll<HTMLElement>(
              'button, input[type="submit"], input[type="button"], a[role="button"], .a-button-input',
            ),
          );
          return els
            .filter((el) => el.offsetParent !== null || el.getClientRects().length > 0)
            .map((el) => ({
              tag: el.tagName.toLowerCase(),
              id: el.id || null,
              name: (el as HTMLInputElement).name || null,
              type: (el as HTMLInputElement).type || null,
              cls: el.className || null,
              value: (el as HTMLInputElement).value || null,
              ariaLabel: el.getAttribute('aria-label'),
              ariaLabelledby: el.getAttribute('aria-labelledby'),
              text: (el.textContent || '').trim().slice(0, 80) || null,
              disabled: (el as HTMLButtonElement).disabled,
            }))
            .slice(0, 50);
        })
        .catch(() => [] as unknown[]);
      console.log(`${PROMPT} ─── visible buttons/inputs on page (up to 50) ───`);
      for (const b of buttons) {
        console.log(`${PROMPT}   ${JSON.stringify(b)}`);
      }
      console.log(`${PROMPT} ────────────────────────────────────────────────`);

      console.log(
        `${PROMPT} Leaving browser open 10 min so you can inspect the failure page.`,
      );
      console.log(`${PROMPT} Press Ctrl-C in this terminal to exit sooner.`);
      await page.waitForTimeout(600_000);
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
