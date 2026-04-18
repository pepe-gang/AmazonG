/**
 * Install Playwright's Chromium binaries into a local `build-browsers/`
 * directory so electron-builder can bundle them as extraResources. At
 * runtime the packaged app points PLAYWRIGHT_BROWSERS_PATH at
 * `resourcesPath/playwright-browsers` so Playwright finds Chromium
 * inside the .app instead of the user's ~/Library/Caches/ms-playwright
 * (which won't exist on a fresh user machine).
 *
 * Run automatically by `npm run prepackage`. Safe to re-run — Playwright
 * skips downloads if the right version is already present.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync, rmSync } from 'node:fs';

const OUT = resolve(process.cwd(), 'build-browsers');
const FORCE_CLEAN = process.argv.includes('--clean');

if (FORCE_CLEAN && existsSync(OUT)) {
  console.log(`[install-browsers] removing ${OUT} for clean install`);
  rmSync(OUT, { recursive: true, force: true });
}

console.log(`[install-browsers] installing chromium into ${OUT}`);
const result = spawnSync(
  'npx',
  ['playwright', 'install', 'chromium'],
  {
    stdio: 'inherit',
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: OUT },
  },
);

if (result.status !== 0) {
  console.error(`[install-browsers] failed with exit code ${result.status}`);
  process.exit(result.status ?? 1);
}
console.log(`[install-browsers] done. Will be bundled at Resources/playwright-browsers.`);
