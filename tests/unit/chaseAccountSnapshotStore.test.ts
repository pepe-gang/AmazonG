import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAccountSnapshotAt,
  getAccountSnapshotAt,
  setAccountSnapshotAt,
} from '../../src/main/chaseAccountSnapshotStore.js';

let tmpRoot: string;
let filePath: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'amazong-chase-snapshot-'));
  filePath = join(tmpRoot, 'chase-account-snapshots.json');
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

const sample = {
  pointsBalance: '70,473 pts',
  creditBalance: '-$1,105.68',
  inProcessPayments: [
    { date: 'Apr 25, 2026', status: 'In process', amount: '$13,000.00' },
  ],
  fetchedAt: '2026-04-26T20:32:00.000Z',
};

describe('chaseAccountSnapshotStore', () => {
  it('returns null when no snapshot has ever been set', async () => {
    expect(await getAccountSnapshotAt(filePath, 'p1')).toBeNull();
  });

  it('round-trips a snapshot through set + get', async () => {
    await setAccountSnapshotAt(filePath, 'p1', sample);
    expect(await getAccountSnapshotAt(filePath, 'p1')).toEqual(sample);
  });

  it('overwrites the prior snapshot on each set', async () => {
    await setAccountSnapshotAt(filePath, 'p1', sample);
    const newer = { ...sample, pointsBalance: '0 pts', fetchedAt: '2026-04-27T00:00:00.000Z' };
    await setAccountSnapshotAt(filePath, 'p1', newer);
    expect(await getAccountSnapshotAt(filePath, 'p1')).toEqual(newer);
  });

  it('keeps profiles isolated', async () => {
    await setAccountSnapshotAt(filePath, 'p1', sample);
    await setAccountSnapshotAt(filePath, 'p2', { ...sample, pointsBalance: '500 pts' });
    expect((await getAccountSnapshotAt(filePath, 'p1'))?.pointsBalance).toBe('70,473 pts');
    expect((await getAccountSnapshotAt(filePath, 'p2'))?.pointsBalance).toBe('500 pts');
  });

  it('clearAccountSnapshot drops only the targeted profile', async () => {
    await setAccountSnapshotAt(filePath, 'p1', sample);
    await setAccountSnapshotAt(filePath, 'p2', sample);
    await clearAccountSnapshotAt(filePath, 'p1');
    expect(await getAccountSnapshotAt(filePath, 'p1')).toBeNull();
    expect(await getAccountSnapshotAt(filePath, 'p2')).not.toBeNull();
  });

  it('clearAccountSnapshot is a no-op when the profile is unknown', async () => {
    await expect(clearAccountSnapshotAt(filePath, 'never-existed')).resolves.toBeUndefined();
  });
});
