import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSession } from '../browser/driver.js';
import { fetchProductHtml } from '../actions/scrapeProduct.js';

async function main() {
  const url = process.argv[2];
  const name = process.argv[3] ?? `fixture-${Date.now()}`;
  if (!url) {
    console.error('Usage: npm run save-fixture -- <amazon-url> [fixture-name]');
    process.exit(1);
  }

  const userDataRoot = join(tmpdir(), 'autog-fixture-profile');
  const session = await openSession('fixture', { userDataRoot, headless: true });
  try {
    const html = await fetchProductHtml(session, url);
    const dir = join(process.cwd(), 'fixtures');
    await mkdir(dir, { recursive: true });
    const out = join(dir, `${name}.html`);
    await writeFile(out, html, 'utf8');
    console.log(`saved ${out} (${html.length} bytes)`);
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
