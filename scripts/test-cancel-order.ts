/**
 * Test the cancelFillerOrder action against one or more order IDs.
 *
 * Usage:
 *   npx tsx scripts/test-cancel-order.ts \
 *     --email alice@example.com \
 *     --order-ids 111-0774738-4429060,111-3866402-7029003
 *
 * Opens a visible Chromium using the account's saved session, runs
 * cancelFillerOrder on each id, prints the result (ok, reason, items
 * checked). Intended for one-off sanity checks — not wired into the
 * worker.
 */
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { openSession } from '../src/browser/driver.js';
import { cancelFillerOrder } from '../src/actions/cancelFillerOrder.js';

const PROMPT = '[cancel-test]';

type Args = {
  email: string;
  orderIds: string[];
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let email = '';
  let orderIdsRaw = '';
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--email') email = argv[++i] ?? '';
    else if (k === '--order-ids') orderIdsRaw = argv[++i] ?? '';
  }
  const orderIds = orderIdsRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!email || orderIds.length === 0) {
    console.error(
      'Usage: tsx scripts/test-cancel-order.ts --email <email> --order-ids <id1,id2,...>',
    );
    process.exit(2);
  }
  return { email, orderIds };
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

  console.log(`${PROMPT} ═══ Cancel Order Test ═══`);
  console.log(`${PROMPT}   account:   ${args.email}`);
  console.log(`${PROMPT}   orders:    ${args.orderIds.join(', ')}`);
  console.log('');

  const session = await openSession(args.email, {
    userDataRoot,
    headless: false,
  });
  const existing = session.context.pages();
  const page = existing[0] ?? (await session.newPage());

  const results: {
    orderId: string;
    ok: boolean;
    reason?: string;
    itemsChecked?: number;
    detail?: string;
  }[] = [];
  try {
    for (const orderId of args.orderIds) {
      console.log(`${PROMPT} ─── cancelling ${orderId} ───`);
      const r = await cancelFillerOrder(page, orderId, {
        correlationId: `cancel-test-${Date.now()}`,
      });
      if (r.ok) {
        console.log(
          `${PROMPT}   ✅ cancelled (${r.itemsChecked} items checked)`,
        );
        results.push({ orderId, ok: true, itemsChecked: r.itemsChecked });
      } else {
        console.log(`${PROMPT}   ❌ ${r.reason}`);
        if (r.detail) console.log(`${PROMPT}     detail: ${r.detail}`);
        results.push({
          orderId,
          ok: false,
          reason: r.reason,
          ...(r.detail ? { detail: r.detail } : {}),
        });
      }
      // Small pause between orders so we don't hammer Amazon.
      await page.waitForTimeout(1_500);
    }

    console.log('');
    console.log(`${PROMPT} ═══ Summary ═══`);
    console.log(JSON.stringify(results, null, 2));
    const okCount = results.filter((r) => r.ok).length;
    const failCount = results.length - okCount;
    console.log(`${PROMPT} ${okCount} cancelled, ${failCount} failed`);
    console.log(
      `${PROMPT} Leaving browser open 10 min for inspection. Ctrl-C to exit.`,
    );
    await page.waitForTimeout(600_000);
    process.exit(failCount > 0 ? 1 : 0);
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error(`${PROMPT} fatal:`, err);
  process.exit(1);
});
