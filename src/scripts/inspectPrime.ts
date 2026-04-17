import { openSession } from '../browser/driver.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const URLS = [
  ['B0GR11MSHY', 'https://www.amazon.com/gp/product/B0GR11MSHY?th=1'],
];

async function main() {
  const profile = process.argv[2];
  const userDataRoot = profile
    ? join(homedir(), 'Library/Application Support/AmazonG/amazon-profiles')
    : join(tmpdir(), 'amazong-inspect');
  const key = profile ?? 'inspect';

  const session = await openSession(key, { userDataRoot, headless: true });
  const fixtureDir = join(process.cwd(), 'fixtures');
  await mkdir(fixtureDir, { recursive: true });

  try {
    for (const [name, url] of URLS) {
      if (!name || !url) continue;
      const page = await session.newPage();
      try {
        console.error(`-- ${name} -- loading`);
        let attempt = 0;
        while (attempt < 3) {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          await page.waitForLoadState('domcontentloaded').catch(() => undefined);
          const captcha = await page.evaluate(() =>
            /validateCaptcha|type the characters|we just need to make sure/i.test(
              document.body?.textContent ?? '',
            ),
          );
          if (!captcha) break;
          attempt += 1;
          const wait = 5_000 + attempt * 10_000;
          console.error(`   captcha detected, retry ${attempt} after ${wait}ms`);
          await page.waitForTimeout(wait);
        }
        const html = await page.content();
        await writeFile(join(fixtureDir, `${name}.html`), html, 'utf8');

        const probe = await page.evaluate(() => {
          const out: Record<string, unknown> = {};
          const body = document.body?.textContent ?? '';
          out.title = document.querySelector('#productTitle')?.textContent?.trim() ?? null;
          out.priceOffscreen = document.querySelector('.priceToPay .a-offscreen, #corePriceDisplay_desktop_feature_div .a-price .a-offscreen')?.textContent?.trim() ?? null;
          out.availability = document.querySelector('#availability')?.textContent?.trim() ?? null;
          out.primeIconCount = document.querySelectorAll('i.a-icon-prime, .a-icon-prime').length;
          out.primeBadgeContent = document.querySelector('#primeBadgeContent')?.outerHTML?.slice(0, 200) ?? null;
          const ariaPrime = Array.from(document.querySelectorAll('[aria-label*="Prime" i]')).slice(0, 5).map((n) => ({ tag: n.tagName, aria: n.getAttribute('aria-label') }));
          out.ariaPrime = ariaPrime;
          out.deliveryBlock = document.querySelector('#mir-layout-DELIVERY_BLOCK, #deliveryBlockMessage, #delivery-block')?.textContent?.trim()?.slice(0, 400) ?? null;
          out.primeText = Array.from(document.querySelectorAll('span,div')).filter((el) => /^\s*prime\s*$/i.test(el.textContent ?? '')).length;
          out.bodyPrimeMatches = (body.match(/\bprime\b/gi) ?? []).length;
          out.soldBy = document.querySelector('#sellerProfileTriggerId')?.textContent?.trim() ?? null;
          out.merchantInfo = document.querySelector('#merchant-info, #merchantInfoFeature_feature_div')?.textContent?.trim()?.slice(0, 200) ?? null;
          return out;
        });

        console.log(JSON.stringify({ name, url: page.url(), ...probe }, null, 2));
      } catch (err) {
        console.error(`${name} failed:`, err);
      } finally {
        await page.close();
      }
      // pace requests so Amazon doesn't escalate bot checks
      await new Promise((r) => setTimeout(r, 6_000));
    }
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
