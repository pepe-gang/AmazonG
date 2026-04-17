import { openSession } from '../browser/driver.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

async function main() {
  const url = process.argv[2];
  const email = process.argv[3] ?? 'ntn.huyen.2810@gmail.com';
  if (!url) {
    console.error('Usage: npm run show -- <url> [profile-email]');
    process.exit(1);
  }

  const userDataRoot = join(homedir(), 'Library/Application Support/AmazonG/amazon-profiles');
  const session = await openSession(email, { userDataRoot, headless: true });

  const page = await session.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // Give Amazon's client-side rendering a chance to paint
    await page
      .waitForSelector('#corePriceDisplay_desktop_feature_div, #buy-now-button', { timeout: 10_000 })
      .catch(() => undefined);
    await page.waitForTimeout(2_000);

    const out = join(process.cwd(), 'screenshots');
    await mkdir(out, { recursive: true });
    const asin = url.match(/\/dp\/([A-Z0-9]{10})/)?.[1] ?? 'product';
    const shot = join(out, `${asin}.png`);
    // Snapshot just the right-column buy-box so we see exactly what Amazon
    // shows the shopper in the "Buy new" area.
    const buybox = page.locator('#rightCol, #desktop_buybox, #buybox').first();
    if (await buybox.count()) {
      await buybox.screenshot({ path: shot });
    } else {
      await page.screenshot({ path: shot });
    }
    console.log(`📸 Screenshot: ${shot}`);

    // Save the HTML for later inspection
    const html = await page.content();
    await writeFile(join(process.cwd(), 'fixtures', `${asin}.html`), html, 'utf8');

    // Probe every Prime badge. Use a plain function body as a string to
    // avoid tsx's __name helper injection inside page.evaluate.
    const probe = await page.evaluate(`(() => {
      const CONTAINER_SLOTS = new Set([
        'accordionRows', 'desktop_accordion', 'desktop_buybox',
        'offer_display_content', 'apex_desktop', 'apex_dp_center_column',
      ]);
      const badges = Array.from(document.querySelectorAll('.a-icon-prime-with-text'));
      return badges.map((el, i) => {
        const rect = el.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0;
        const style = getComputedStyle(el);
        const hidCss = style.display === 'none' || style.visibility === 'hidden';
        let slot = null;
        let n = el;
        while (n) {
          const s = n.getAttribute ? n.getAttribute('data-csa-c-slot-id') : null;
          if (s) { slot = s; break; }
          n = n.parentElement;
        }
        let accordionHidden = false;
        let accordionReason = '';
        n = el;
        while (n) {
          const cls = n.classList;
          if (cls && (cls.contains('aok-hidden') || cls.contains('a-hidden'))) {
            accordionHidden = true;
            accordionReason = 'aok-hidden on ' + n.tagName + '.' + (n.id || '?');
            break;
          }
          const s = n.getAttribute ? n.getAttribute('data-csa-c-slot-id') : null;
          const active = n.getAttribute ? n.getAttribute('data-csa-c-is-in-initial-active-row') : null;
          if (s && !CONTAINER_SLOTS.has(s) && active === 'false') {
            accordionHidden = true;
            accordionReason = 'slot=' + s + ' active=false';
            break;
          }
          n = n.parentElement;
        }
        return {
          idx: i,
          text: (el.textContent || '').trim(),
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
          visibleBox: visible,
          hiddenByCss: hidCss,
          nearestSlot: slot,
          accordionHidden,
          accordionReason,
        };
      });
    })()`);

    console.log('\n=== Prime badges on page ===');
    console.log(JSON.stringify(probe, null, 2));
  } finally {
    try { await page.close(); } catch { /* ignore */ }
    await session.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
