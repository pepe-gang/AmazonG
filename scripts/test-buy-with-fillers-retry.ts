/**
 * Retry-logic smoke test for the Buy-with-Fillers flow.
 *
 * Mirrors `runFillerBuyWithRetries()` from pollAndScrape.ts: runs
 * `buyWithFillers` with dryRun=true up to 3 times, retrying ONLY when
 * the failure stage is `cashback_gate`. Any other failure ends the
 * test immediately. A pass on attempt 2 or 3 validates the retry
 * design (different random fillers shuffle Amazon's shipping groups
 * until the target lands in a 6%-qualifying one).
 *
 * Usage:
 *   npx tsx scripts/test-buy-with-fillers-retry.ts \
 *     --email alice@example.com \
 *     --url https://www.amazon.com/dp/B0XXXXXXXX \
 *     [--max-attempts 3]
 */
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { openSession } from '../src/browser/driver.js';
import {
  buyWithFillers,
  type BuyWithFillersResult,
} from '../src/actions/buyWithFillers.js';

const PROMPT = '[retry]';
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_PREFIXES = ['13132', '13130', '1146'];
const DEFAULT_MIN_CASHBACK = 6;

type Args = {
  email: string;
  url: string;
  maxAttempts: number;
  live: boolean;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let email = '';
  let url = '';
  let maxAttempts = DEFAULT_MAX_ATTEMPTS;
  let live = false;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--email') email = argv[++i] ?? '';
    else if (k === '--url') url = argv[++i] ?? '';
    else if (k === '--max-attempts') {
      const v = parseInt(argv[++i] ?? '', 10);
      if (Number.isFinite(v) && v > 0) maxAttempts = v;
    } else if (k === '--live') {
      live = true;
    }
  }
  if (!email || !url) {
    console.error(
      'Usage: tsx scripts/test-buy-with-fillers-retry.ts ' +
        '--email <email> --url <productUrl> [--max-attempts N] [--live]',
    );
    process.exit(2);
  }
  return { email, url, maxAttempts, live };
}

async function main(): Promise<void> {
  const args = parseArgs();
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

  console.log(`${PROMPT} ═══ Buy-with-Fillers Retry Test ═══`);
  console.log(`${PROMPT}   account:       ${args.email}`);
  console.log(`${PROMPT}   product:       ${args.url}`);
  console.log(`${PROMPT}   max attempts:  ${args.maxAttempts}`);
  console.log(
    `${PROMPT}   mode:          ${args.live ? '🔴 LIVE (will actually place order)' : 'dry-run (stops before Place Order)'}`,
  );
  console.log(
    `${PROMPT}   behavior:      retry on cashback_gate only; any other ` +
      `failure aborts immediately`,
  );
  if (args.live) {
    console.log('');
    console.log(`${PROMPT}   ⚠️  LIVE mode — a successful attempt will charge this account.`);
    console.log(`${PROMPT}      You will need to cancel the order manually via Amazon afterwards.`);
  }
  console.log('');

  const session = await openSession(args.email, {
    userDataRoot,
    headless: false,
  });
  const existing = session.context.pages();
  const page = existing[0] ?? (await session.newPage());

  const start = Date.now();
  let final: BuyWithFillersResult | null = null;
  try {
    for (let attempt = 1; attempt <= args.maxAttempts; attempt++) {
      console.log(
        `${PROMPT} ───── attempt ${attempt}/${args.maxAttempts} ─────`,
      );
      const f = await buyWithFillers(page, {
        productUrl: args.url,
        maxPrice: null,
        allowedAddressPrefixes: DEFAULT_PREFIXES,
        minCashbackPct: DEFAULT_MIN_CASHBACK,
        dryRun: !args.live,
        correlationId: `retry-test-${Date.now()}/attempt-${attempt}`,
      });
      final = f;
      if (f.ok) {
        console.log(
          `${PROMPT}   attempt ${attempt}: stage=${f.stage} (ok) — exiting retry loop`,
        );
        break;
      }
      console.log(
        `${PROMPT}   attempt ${attempt}: stage=${f.stage} reason="${f.reason}"`,
      );
      if (f.stage !== 'cashback_gate') {
        console.log(
          `${PROMPT}   non-cashback failure — fail fast, skipping remaining attempts`,
        );
        break;
      }
      if (attempt >= args.maxAttempts) {
        console.log(
          `${PROMPT}   exhausted ${args.maxAttempts} attempts on cashback_gate`,
        );
      }
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log('');
    console.log(`${PROMPT} ═══ Final (${elapsed}s) ═══`);
    if (!final) {
      console.log(`${PROMPT} ❌ no attempts completed`);
      process.exit(1);
    }
    console.log(JSON.stringify(final, null, 2));
    console.log('');
    if (final.ok) {
      console.log(`${PROMPT} ✅ PASS — stage=${final.stage}`);
      if (final.stage === 'placed') {
        console.log(`${PROMPT}   target order id: ${final.orderId ?? '(unknown)'}`);
        console.log(`${PROMPT}   all order ids from this buy:`);
        for (const m of final.orderIds) {
          const isTarget =
            final.targetAsin !== null &&
            m.matchedAsins.includes(final.targetAsin);
          console.log(
            `${PROMPT}     ${m.orderId}${isTarget ? ' ← target' : ''}  (${m.matchedAsins.length} matched asins)`,
          );
        }
        console.log(
          `${PROMPT}   ⚠️  Cancel these orders manually via Amazon if you don't want to keep them.`,
        );
      }
      console.log(
        `${PROMPT} Leaving browser open 10 min for inspection. Ctrl-C to exit.`,
      );
      await page.waitForTimeout(600_000);
      process.exit(0);
    } else {
      console.log(`${PROMPT} ❌ FAIL — stage=${final.stage}: ${final.reason}`);
      if ('detail' in final && final.detail) {
        console.log(`${PROMPT}    detail: ${final.detail}`);
      }
      console.log(
        `${PROMPT} Leaving browser open 10 min for inspection. Ctrl-C to exit.`,
      );
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
