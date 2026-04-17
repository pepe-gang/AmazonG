import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createBGClient } from '@bg/client';

describe('createBGClient.claimJob', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('coerces maxPrice from a string (Prisma Decimal) to a number', async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        job: {
          id: 'job123',
          phase: 'buy',
          productUrl: 'https://amazon.com/dp/TEST',
          maxPrice: '499.00', // Prisma Decimal serializes as string
          quantity: 1,
          dealTitle: 'Test Deal',
          dealKey: 'deal1',
          commitmentId: 'commit1',
          attempts: 0,
          buyJobId: null,
          placedOrderId: null,
          placedEmail: null,
          viaFiller: false,
        },
      }),
    });

    const client = createBGClient('https://bg.test', 'apikey');
    const job = await client.claimJob();
    expect(job).not.toBeNull();
    expect(typeof job?.maxPrice).toBe('number');
    expect(job?.maxPrice).toBe(499);
  });

  it('passes a numeric maxPrice through untouched', async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        job: {
          id: 'job123',
          phase: 'buy',
          productUrl: 'https://amazon.com/dp/TEST',
          maxPrice: 299.99,
          quantity: 1,
          dealTitle: null,
          dealKey: null,
          commitmentId: null,
          attempts: 0,
          buyJobId: null,
          placedOrderId: null,
          placedEmail: null,
          viaFiller: false,
        },
      }),
    });

    const job = await createBGClient('https://bg.test', 'apikey').claimJob();
    expect(job?.maxPrice).toBe(299.99);
  });

  it('returns null maxPrice when BG sends null', async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        job: {
          id: 'job123',
          phase: 'buy',
          productUrl: 'https://amazon.com/dp/TEST',
          maxPrice: null,
          quantity: 1,
          dealTitle: null,
          dealKey: null,
          commitmentId: null,
          attempts: 0,
          buyJobId: null,
          placedOrderId: null,
          placedEmail: null,
          viaFiller: false,
        },
      }),
    });

    const job = await createBGClient('https://bg.test', 'apikey').claimJob();
    expect(job?.maxPrice).toBeNull();
  });

  it('returns null when response has no job', async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 204,
    });
    const job = await createBGClient('https://bg.test', 'apikey').claimJob();
    expect(job).toBeNull();
  });
});
