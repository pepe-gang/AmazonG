import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendRedeemEntryAt,
  clearRedeemHistoryAt,
  listRedeemHistoryAt,
} from '../../src/main/chaseRedeemHistory.js';

let tmpRoot: string;
let filePath: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'amazong-chase-history-'));
  filePath = join(tmpRoot, 'chase-redeem-history.json');
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('chaseRedeemHistory', () => {
  it('returns an empty list when the file does not exist', async () => {
    expect(await listRedeemHistoryAt(filePath, 'p1')).toEqual([]);
  });

  it('persists a single entry and reads it back', async () => {
    await appendRedeemEntryAt(filePath, 'p1', {
      ts: '2026-04-26T20:32:00.000Z',
      orderNumber: 'SC13-AAAA-BBBB',
      amount: '$704.73',
      pointsRedeemed: '$704.73',
    });
    const list = await listRedeemHistoryAt(filePath, 'p1');
    expect(list).toEqual([
      {
        ts: '2026-04-26T20:32:00.000Z',
        orderNumber: 'SC13-AAAA-BBBB',
        amount: '$704.73',
        pointsRedeemed: '$704.73',
      },
    ]);
  });

  it('returns rows newest-first regardless of insertion order', async () => {
    // Insert oldest first, then newest. The list output should
    // still be newest first — the UI prints them in that order
    // and shouldn't have to re-sort.
    await appendRedeemEntryAt(filePath, 'p1', {
      ts: '2026-04-20T00:00:00.000Z',
      orderNumber: 'OLD',
      amount: '$10.00',
      pointsRedeemed: '$10.00',
    });
    await appendRedeemEntryAt(filePath, 'p1', {
      ts: '2026-04-26T00:00:00.000Z',
      orderNumber: 'NEW',
      amount: '$20.00',
      pointsRedeemed: '$20.00',
    });
    const list = await listRedeemHistoryAt(filePath, 'p1');
    expect(list.map((e) => e.orderNumber)).toEqual(['NEW', 'OLD']);
  });

  it('dedupes by orderNumber so retries do not double-record', async () => {
    const entry = {
      ts: '2026-04-26T20:32:00.000Z',
      orderNumber: 'SC13-AAAA-BBBB',
      amount: '$704.73',
      pointsRedeemed: '$704.73',
    };
    await appendRedeemEntryAt(filePath, 'p1', entry);
    // Same orderNumber — should not append again.
    await appendRedeemEntryAt(filePath, 'p1', { ...entry, ts: '2026-04-26T22:00:00.000Z' });
    const list = await listRedeemHistoryAt(filePath, 'p1');
    expect(list).toHaveLength(1);
  });

  it('always appends when orderNumber is empty', async () => {
    // Empty orderNumber means "redemption succeeded but we couldn't
    // scrape the confirmation number". Better to over-record than
    // to drop a real redemption silently.
    const entry = {
      ts: '2026-04-26T20:32:00.000Z',
      orderNumber: '',
      amount: '$50.00',
      pointsRedeemed: '$50.00',
    };
    await appendRedeemEntryAt(filePath, 'p1', entry);
    await appendRedeemEntryAt(filePath, 'p1', entry);
    const list = await listRedeemHistoryAt(filePath, 'p1');
    expect(list).toHaveLength(2);
  });

  it('keeps profiles isolated', async () => {
    await appendRedeemEntryAt(filePath, 'p1', {
      ts: '2026-04-26T20:32:00.000Z',
      orderNumber: 'P1-ENTRY',
      amount: '$100.00',
      pointsRedeemed: '$100.00',
    });
    await appendRedeemEntryAt(filePath, 'p2', {
      ts: '2026-04-26T20:33:00.000Z',
      orderNumber: 'P2-ENTRY',
      amount: '$200.00',
      pointsRedeemed: '$200.00',
    });
    expect((await listRedeemHistoryAt(filePath, 'p1'))[0]?.orderNumber).toBe(
      'P1-ENTRY',
    );
    expect((await listRedeemHistoryAt(filePath, 'p2'))[0]?.orderNumber).toBe(
      'P2-ENTRY',
    );
  });

  it('clearRedeemHistory drops only the targeted profile', async () => {
    await appendRedeemEntryAt(filePath, 'p1', {
      ts: '2026-04-26T20:32:00.000Z',
      orderNumber: 'P1',
      amount: '$1.00',
      pointsRedeemed: '$1.00',
    });
    await appendRedeemEntryAt(filePath, 'p2', {
      ts: '2026-04-26T20:32:00.000Z',
      orderNumber: 'P2',
      amount: '$2.00',
      pointsRedeemed: '$2.00',
    });
    await clearRedeemHistoryAt(filePath, 'p1');
    expect(await listRedeemHistoryAt(filePath, 'p1')).toEqual([]);
    expect((await listRedeemHistoryAt(filePath, 'p2'))).toHaveLength(1);
  });

  it('clearRedeemHistory is a no-op when the profile is unknown', async () => {
    await expect(clearRedeemHistoryAt(filePath, 'never-existed')).resolves.toBeUndefined();
  });
});
