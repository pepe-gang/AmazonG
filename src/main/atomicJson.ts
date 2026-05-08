import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Atomically write a JSON file via the canonical write-temp-rename
 * pattern. Survives:
 *   - power loss / force-quit mid-write (the destination still holds
 *     the previous good content because rename is atomic on both POSIX
 *     and Windows ≥ modern Node — Windows uses MoveFileEx with
 *     REPLACE_EXISTING)
 *   - concurrent writers on the same path: the last rename wins; no
 *     reader ever sees a half-written file
 *
 * Does NOT serialize concurrent writers. If two callers both rev a
 * stale read, the second rename wins and the first's changes are
 * lost. Callers that need read-modify-write atomicity must add an
 * external lock.
 *
 * The temp filename embeds pid + a random suffix so concurrent writers
 * on the same path don't collide on the tmp file itself.
 */
export async function writeJsonAtomic(
  filePath: string,
  data: unknown,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  const json = JSON.stringify(data, null, 2);
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(tmpPath, 'w');
    await fh.writeFile(json, 'utf8');
    await fh.sync();
  } finally {
    await fh?.close().catch(() => undefined);
  }
  try {
    await rename(tmpPath, filePath);
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}
