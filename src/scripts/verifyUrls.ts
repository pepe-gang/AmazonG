import { openSession } from '../browser/driver.js';
import { fetchProductHtml, parseProductHtml } from '../actions/scrapeProduct.js';
import {
  checkProductConstraints,
  DEFAULT_CONSTRAINTS,
  type Constraints,
} from '../parsers/productConstraints.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

const URLS = [
  'https://www.amazon.com/dp/B0GQVDGCD2?th=1',
  'https://www.amazon.com/dp/B0DZ77TPPD?th=1',
  'https://www.amazon.com/dp/B0DZ75TN5F?th=1',
  'https://www.amazon.com/dp/B0GQVBJT4J?th=1',
  'https://www.amazon.com/dp/B0FWD1K669?th=1',
  'https://www.amazon.com/dp/B0FWD1MS82?th=1',
  'https://www.amazon.com/dp/B0CD1JTBSC?th=1',
  'https://www.amazon.com/dp/B0DZ751XN6?th=1',
  'https://www.amazon.com/dp/B0BFC7WQ6R?th=1',
  'https://www.amazon.com/dp/B0DGJC52FP?th=1',
  'https://www.amazon.com/dp/B0D54JZTHY?th=1',
];

const CONSTRAINTS: Constraints = {
  ...DEFAULT_CONSTRAINTS,
  maxPrice: null, // no price gate for this run
  requirePrime: true,
};

function asin(url: string): string {
  const m = url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/);
  return m?.[1] ?? url;
}

async function main() {
  const email = process.argv[2] ?? 'ntn.huyen.2810@gmail.com';
  const userDataRoot = join(homedir(), 'Library/Application Support/AmazonG/amazon-profiles');
  const session = await openSession(email, { userDataRoot, headless: true });

  const rows: Array<{
    asin: string;
    verdict: 'PASS' | 'FAIL' | 'UNKNOWN';
    reason: string;
    title: string | null;
    price: number | null;
    inStock: boolean;
    condition: string | null;
    isPrime: boolean | null;
    hasBuyNow: boolean | null;
  }> = [];

  try {
    for (const url of URLS) {
      const id = asin(url);
      try {
        const html = await fetchProductHtml(session, url);
        const info = parseProductHtml(html, url);
        // detect captcha
        if (!info.title && info.price === null) {
          rows.push({
            asin: id,
            verdict: 'UNKNOWN',
            reason: 'page empty (likely captcha)',
            title: null,
            price: null,
            inStock: false,
            condition: null,
            isPrime: null,
            hasBuyNow: null,
          });
        } else {
          const v = checkProductConstraints(info, CONSTRAINTS);
          rows.push({
            asin: id,
            verdict: v.ok ? 'PASS' : 'FAIL',
            reason: v.ok ? 'all checks passed' : `${v.reason}: ${v.detail}`,
            title: info.title,
            price: info.price,
            inStock: info.inStock,
            condition: info.condition,
            isPrime: info.isPrime,
            hasBuyNow: info.hasBuyNow,
          });
        }
      } catch (err) {
        rows.push({
          asin: id,
          verdict: 'UNKNOWN',
          reason: `error: ${err instanceof Error ? err.message : String(err)}`,
          title: null,
          price: null,
          inStock: false,
          condition: null,
          isPrime: null,
          hasBuyNow: null,
        });
      }
      await new Promise((r) => setTimeout(r, 7_000));
    }
  } finally {
    await session.close();
  }

  console.log('\n=== Verification Report ===');
  console.log(`Constraints: requireInStock=${CONSTRAINTS.requireInStock}, requireNew=${CONSTRAINTS.requireNew}, requireShipping=${CONSTRAINTS.requireShipping}, requirePrime=${CONSTRAINTS.requirePrime}, maxPrice=${CONSTRAINTS.maxPrice}\n`);
  for (const r of rows) {
    console.log(`[${r.verdict}] ${r.asin}`);
    console.log(`  title: ${r.title ?? '—'}`);
    console.log(`  price: ${r.price ?? '—'}  inStock: ${r.inStock}  condition: ${r.condition ?? '—'}  isPrime: ${r.isPrime}  hasBuyNow: ${r.hasBuyNow}`);
    console.log(`  reason: ${r.reason}\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
