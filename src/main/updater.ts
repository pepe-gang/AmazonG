/**
 * Self-update flow for unsigned macOS builds.
 *
 * Apple's Squirrel-backed auto-update refuses to swap in a new app bundle
 * whose Developer ID code-signing doesn't match the running one — and we
 * don't pay the $99/yr cert. So we sidestep Squirrel entirely and do the
 * file operations ourselves:
 *
 *   1. Renderer (or here) polls the public GitHub Releases API for the
 *      newest tag and the AmazonG-arm64.dmg asset URL.
 *   2. When the user clicks "Update", we download the DMG into /tmp.
 *   3. We write a small bash helper to /tmp that waits a moment for the
 *      app to fully quit, then mounts the DMG, replaces /Applications/
 *      AmazonG.app, runs `xattr -cr` to clear Gatekeeper's quarantine,
 *      detaches the DMG, and relaunches the app via `open`.
 *   4. We spawn the helper in the background (detached) and call
 *      app.quit() so the file ops happen on the freshly-vacated bundle.
 *
 * Scope: macOS only (since the DMG path is mac-specific and we don't
 * ship a Windows build yet). On non-darwin we skip the apply step.
 */
import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { logger } from '../shared/logger.js';

const RELEASES_API = 'https://api.github.com/repos/pepe-gang/AmazonG/releases/latest';
const DMG_ASSET_NAME = 'AmazonG-arm64.dmg';

export type UpdateCheckResult =
  | { kind: 'up_to_date'; current: string }
  | { kind: 'available'; current: string; latest: string; downloadUrl: string }
  | { kind: 'error'; message: string };

/**
 * Hit GitHub's "latest release" endpoint and compare against the running
 * app version. Returns one of three states the renderer can display.
 */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const current = app.getVersion();
  try {
    const res = await fetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) {
      return { kind: 'error', message: `GitHub API ${res.status}` };
    }
    const data = (await res.json()) as {
      tag_name?: string;
      assets?: { name: string; browser_download_url: string }[];
    };
    const latest = (data.tag_name ?? '').replace(/^v/, '');
    if (!latest) {
      return { kind: 'error', message: 'no tag_name in release' };
    }
    const asset = data.assets?.find((a) => a.name === DMG_ASSET_NAME);
    if (!asset) {
      return { kind: 'error', message: `no ${DMG_ASSET_NAME} asset on latest release` };
    }
    if (compareSemver(latest, current) <= 0) {
      return { kind: 'up_to_date', current };
    }
    return {
      kind: 'available',
      current,
      latest,
      downloadUrl: asset.browser_download_url,
    };
  } catch (err) {
    return {
      kind: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Download the DMG, write the helper, spawn it, then quit so the helper
 * can replace the now-vacated app bundle.
 *
 * Resolves once the helper has been spawned (NOT once the install
 * finishes — by then we're dead). Throws on download or filesystem
 * errors so the renderer can toast them.
 */
export async function applyUpdate(downloadUrl: string): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('self-update is currently macOS only');
  }
  if (!app.isPackaged) {
    throw new Error('cannot self-update an unpackaged dev build');
  }

  // 1. Download the DMG. Stream-to-file would be nicer for big files,
  //    but the asset is ~340MB and Node's fetch buffers fine.
  const dmgPath = path.join(os.tmpdir(), `AmazonG-update-${Date.now()}.dmg`);
  logger.info('updater.download.start', { downloadUrl, dmgPath });
  const res = await fetch(downloadUrl);
  if (!res.ok || !res.body) {
    throw new Error(`download failed: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dmgPath, buf);
  logger.info('updater.download.done', { bytes: buf.length });

  // 2. Resolve the running .app bundle path. process.execPath in a
  //    packaged build looks like: <bundle>/Contents/MacOS/AmazonG.
  const exec = process.execPath;
  const appPath = exec.replace(/\/Contents\/MacOS\/[^/]+$/, '');
  if (!appPath.endsWith('.app')) {
    throw new Error(`could not resolve current .app path from execPath=${exec}`);
  }

  // 3. Write the bash helper. It logs every step to /tmp/amazong-update.log
  //    so install failures are debuggable after the fact.
  const scriptPath = path.join(os.tmpdir(), `amazong-update-${Date.now()}.sh`);
  const script = `#!/bin/bash
set -e
exec >>/tmp/amazong-update.log 2>&1
echo
echo "[$(date)] ===== update starting ====="
echo "DMG=${dmgPath}"
echo "APP=${appPath}"

# Give the parent app time to close all Chromium contexts + release the
# bundle. before-quit handlers in the main process do the heavy lifting.
sleep 3

MOUNT=$(hdiutil attach "${dmgPath}" -nobrowse -noautoopen -noverify 2>&1 | grep -oE '/Volumes/[^ ]+' | head -1)
if [ -z "$MOUNT" ]; then
  echo "ERROR: hdiutil attach failed"
  exit 1
fi
echo "mounted at $MOUNT"

# Replace the bundle. -rf so partially-deleted state from a previous
# failed run doesn't block.
rm -rf "${appPath}"
cp -R "$MOUNT/AmazonG.app" "${appPath}"
xattr -cr "${appPath}"
hdiutil detach "$MOUNT" -force || true
rm -f "${dmgPath}"

echo "[$(date)] launching $appPath"
open "${appPath}"
echo "[$(date)] ===== done ====="
`;
  await fs.writeFile(scriptPath, script, { mode: 0o755 });

  // 4. Spawn the helper detached so it survives our quit.
  logger.info('updater.helper.spawn', { scriptPath });
  const child = spawn('/bin/bash', [scriptPath], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // 5. Quit ourselves. before-quit cleanup fires (close all Chromiums),
  //    then the helper takes over the bundle.
  setTimeout(() => app.quit(), 250);
}

/**
 * Fetch the GitHub release for a specific version (e.g. "0.2.0") and
 * return the user-facing fields. Used by the in-app changelog modal to
 * show "what's new" after a successful self-update.
 */
export async function getReleaseNotes(
  version: string,
): Promise<{ tag: string; name: string; body: string } | null> {
  const tag = version.startsWith('v') ? version : `v${version}`;
  try {
    const res = await fetch(
      `https://api.github.com/repos/pepe-gang/AmazonG/releases/tags/${encodeURIComponent(tag)}`,
      { headers: { Accept: 'application/vnd.github+json' } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { tag_name?: string; name?: string; body?: string };
    return {
      tag: data.tag_name ?? tag,
      name: data.name ?? tag,
      body: data.body ?? '',
    };
  } catch {
    return null;
  }
}

/** Returns >0 if a > b, 0 if equal, <0 if a < b. Lenient on weird tags. */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}
