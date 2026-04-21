/**
 * Test the verify-phase filler cleanup against known orderIds.
 *
 * Mirrors the logic in pollAndScrape.ts / runVerifyFillerCleanup —
 * retries cancelFillerOrder on each filler orderId and cancelNonTarget
 * Items on the target orderId. Prints per-order outcomes.
 *
 * Usage:
 *   npx tsx scripts/test-verify-cleanup.ts \
 *     --email alice@example.com \
 *     --target-order-id 111-3866402-7029003 \
 *     --target-asin B0DZ773FRV \
 *     --target-title "Apple iPad 11-inch" \
 *     [--filler-order-ids 111-0774738-4429060,111-abc-def]
 */
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { openSession } from '../src/browser/driver.js';
import { cancelFillerOrder } from '../src/actions/cancelFillerOrder.js';
import { cancelNonTargetItems } from '../src/actions/cancelNonTargetItems.js';

const PROMPT = '[verify-cleanup]';
const MAX_TRIES = 3;

type Args = {
  email: string;
  targetOrderId: string;
  targetAsin: string | null;
  targetTitle: string | null;
  fillerOrderIds: string[];
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let email = '';
  let targetOrderId = '';
  let targetAsin: string | null = null;
  let targetTitle: string | null = null;
  let fillerRaw = '';
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--email') email = argv[++i] ?? '';
    else if (k === '--target-order-id') targetOrderId = argv[++i] ?? '';
    else if (k === '--target-asin') targetAsin = argv[++i] ?? null;
    else if (k === '--target-title') targetTitle = argv[++i] ?? null;
    else if (k === '--filler-order-ids') fillerRaw = argv[++i] ?? '';
  }
  const fillerOrderIds = fillerRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!email || !targetOrderId) {
    console.error(
      'Usage: tsx scripts/test-verify-cleanup.ts ' +
        '--email <email> --target-order-id <id> ' +
        '[--target-asin <asin>] [--target-title <title>] ' +
        '[--filler-order-ids <id1,id2,...>]',
    );
    process.exit(2);
  }
  return { email, targetOrderId, targetAsin, targetTitle, fillerOrderIds };
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

  console.log(`${PROMPT} ═══ Verify-Phase Cleanup Test ═══`);
  console.log(`${PROMPT}   account:          ${args.email}`);
  console.log(`${PROMPT}   target order:     ${args.targetOrderId}`);
  console.log(`${PROMPT}   target ASIN:      ${args.targetAsin ?? '(not provided)'}`);
  console.log(`${PROMPT}   target title:     ${args.targetTitle ? args.targetTitle.slice(0, 60) : '(not provided)'}`);
  console.log(`${PROMPT}   filler orders:    ${args.fillerOrderIds.length > 0 ? args.fillerOrderIds.join(', ') : '(none)'}`);
  console.log('');

  const session = await openSession(args.email, {
    userDataRoot,
    headless: false,
  });
  const existing = session.context.pages();
  const page = existing[0] ?? (await session.newPage());

  try {
    const cid = `verify-cleanup-${Date.now()}`;

    // 1. Retry cancel on each filler-only orderId.
    console.log(`${PROMPT} ─── filler orders (${args.fillerOrderIds.length}) ───`);
    const fillerResults: { orderId: string; ok: boolean; reason?: string }[] = [];
    for (const orderId of args.fillerOrderIds) {
      console.log(`${PROMPT}   ${orderId}:`);
      let ok = false;
      let lastReason: string | undefined;
      for (let t = 1; t <= MAX_TRIES; t++) {
        const r = await cancelFillerOrder(page, orderId, { correlationId: cid });
        if (r.ok) {
          ok = true;
          console.log(`${PROMPT}     attempt ${t}: ✅ cancelled (${r.itemsChecked} items)`);
          break;
        }
        lastReason = r.reason;
        console.log(`${PROMPT}     attempt ${t}: ❌ ${r.reason}`);
        if (/unable to cancel/i.test(r.reason)) {
          console.log(`${PROMPT}     Amazon refusal → terminal, skipping remaining attempts`);
          break;
        }
        if (t < MAX_TRIES) await page.waitForTimeout(2_500);
      }
      fillerResults.push(ok ? { orderId, ok } : { orderId, ok: false, reason: lastReason });
    }

    // 2. Cancel non-target items in the target order.
    console.log('');
    console.log(`${PROMPT} ─── target order ${args.targetOrderId} (keep main item, cancel rest) ───`);
    let targetOk = false;
    let targetReason: string | undefined;
    let cancelledCount = 0;
    let keptCount = 0;
    for (let t = 1; t <= MAX_TRIES; t++) {
      const r = await cancelNonTargetItems(
        page,
        args.targetOrderId,
        { asin: args.targetAsin, title: args.targetTitle },
        { correlationId: cid },
      );
      if (r.ok) {
        targetOk = true;
        cancelledCount = r.cancelled;
        keptCount = r.kept;
        console.log(
          `${PROMPT}   attempt ${t}: ✅ cancelled ${r.cancelled} item(s), kept ${r.kept}`,
        );
        break;
      }
      targetReason = r.reason;
      console.log(`${PROMPT}   attempt ${t}: ❌ ${r.reason}`);
      if (r.detail) console.log(`${PROMPT}     detail: ${r.detail}`);
      if (/unable to cancel/i.test(r.reason)) {
        console.log(`${PROMPT}     Amazon refusal → terminal`);
        break;
      }
      if (/could not identify target item/i.test(r.reason)) {
        console.log(`${PROMPT}     target-identification failure → aborting to avoid cancelling target`);
        break;
      }
      if (/only target item is cancellable/i.test(r.reason)) {
        console.log(`${PROMPT}     only target remains → effective success`);
        targetOk = true;
        break;
      }
      if (t < MAX_TRIES) await page.waitForTimeout(2_500);
    }

    console.log('');
    console.log(`${PROMPT} ═══ Summary ═══`);
    const ok = fillerResults.filter((r) => r.ok).length;
    const fail = fillerResults.length - ok;
    console.log(`${PROMPT}   filler-only cancellations: ${ok} ok, ${fail} failed`);
    for (const r of fillerResults.filter((r) => !r.ok)) {
      console.log(`${PROMPT}     - ${r.orderId}: ${r.reason}`);
    }
    console.log(
      `${PROMPT}   target-order clean: ${targetOk ? '✅' : `❌ ${targetReason}`} (cancelled=${cancelledCount}, kept=${keptCount})`,
    );
    console.log('');
    console.log(`${PROMPT} Leaving browser open 10 min for inspection. Ctrl-C to exit.`);
    await page.waitForTimeout(600_000);
    process.exit(0);
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error(`${PROMPT} fatal:`, err);
  process.exit(1);
});
