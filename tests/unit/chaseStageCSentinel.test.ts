import { describe, expect, it } from 'vitest';
import { validateStageCOverviewShape } from '../../src/main/chaseStageCSentinel.js';

const VALID_RESPONSE = {
  code: 'SUCCESS',
  modules: ['CREDIT_CARD_ACCOUNT_DETAILS_TILE'],
  cache: [
    {
      url: '/svc/rr/accounts/secure/overview/card/v2/list',
      response: {
        code: 'SUCCESS',
        cardAccountOverviews: [
          {
            customerId: 'C1',
            cardAccounts: [
              { accountId: 865860218, nickname: 'Amazon', mask: '5088' },
              { accountId: 1019903437, nickname: 'Freedom Flex', mask: '5658' },
            ],
          },
          {
            customerId: 'C2',
            cardAccounts: [
              { accountId: 1142358293, nickname: 'Ink Preferred', mask: '5951' },
            ],
          },
        ],
      },
    },
  ],
};

describe('validateStageCOverviewShape', () => {
  it('accepts the canonical overview response and counts cards across customer groups', () => {
    const result = validateStageCOverviewShape(VALID_RESPONSE);
    expect(result).toEqual({ ok: true, cardCount: 3 });
  });

  it('rejects non-object responses', () => {
    expect(validateStageCOverviewShape(null).ok).toBe(false);
    expect(validateStageCOverviewShape('html').ok).toBe(false);
    expect(validateStageCOverviewShape(42).ok).toBe(false);
  });

  it('rejects a response with non-SUCCESS root code', () => {
    const r = validateStageCOverviewShape({
      ...VALID_RESPONSE,
      code: 'ACCOUNTS:AuthorizationException',
    });
    expect(r).toEqual({ ok: false, reason: 'root-code-ACCOUNTS:AuthorizationException' });
  });

  it('rejects when the cache array is missing', () => {
    const r = validateStageCOverviewShape({ code: 'SUCCESS' });
    expect(r).toEqual({ ok: false, reason: 'missing-cache-array' });
  });

  it('rejects when the overview cache entry is missing (e.g. SPA refactor renamed the URL)', () => {
    const r = validateStageCOverviewShape({
      code: 'SUCCESS',
      cache: [
        {
          url: '/svc/rr/accounts/secure/v2/account/detail/card/list',
          response: { code: 'SUCCESS' },
        },
      ],
    });
    expect(r).toEqual({ ok: false, reason: 'missing-overview-cache-entry' });
  });

  it('rejects when the overview cache entry returned a non-SUCCESS code', () => {
    const r = validateStageCOverviewShape({
      code: 'SUCCESS',
      cache: [
        {
          url: '/svc/rr/accounts/secure/overview/card/v2/list',
          response: { code: 'SERVICE_DEGRADED' },
        },
      ],
    });
    expect(r).toEqual({
      ok: false,
      reason: 'overview-response-code-SERVICE_DEGRADED',
    });
  });

  it('rejects when cardAccountOverviews is missing or wrong type', () => {
    const r = validateStageCOverviewShape({
      code: 'SUCCESS',
      cache: [
        {
          url: '/svc/rr/accounts/secure/overview/card/v2/list',
          response: { code: 'SUCCESS', cardAccountOverviews: 'oops' },
        },
      ],
    });
    expect(r).toEqual({ ok: false, reason: 'cardAccountOverviews-not-array' });
  });

  it('rejects an empty cardAccountOverviews even if the wrapper shape is valid', () => {
    const r = validateStageCOverviewShape({
      code: 'SUCCESS',
      cache: [
        {
          url: '/svc/rr/accounts/secure/overview/card/v2/list',
          response: { code: 'SUCCESS', cardAccountOverviews: [] },
        },
      ],
    });
    expect(r).toEqual({ ok: false, reason: 'cardAccountOverviews-empty' });
  });

  it('accepts when all expected card ids appear in the response', () => {
    const expected = new Set(['865860218', '1019903437', '1142358293']);
    const r = validateStageCOverviewShape(VALID_RESPONSE, expected);
    expect(r).toEqual({ ok: true, cardCount: 3 });
  });

  it('accepts when at least half of the expected card ids appear (partial drift but quorum)', () => {
    const expected = new Set([
      '865860218',
      '1019903437',
      '999999999',
      '888888888',
    ]);
    const r = validateStageCOverviewShape(VALID_RESPONSE, expected);
    // 2 of 4 expected appear — overlap*2 (4) >= expected.size (4) — accepted.
    expect(r).toEqual({ ok: true, cardCount: 3 });
  });

  it('rejects when fewer than half of the expected card ids appear (probable shape drift)', () => {
    const expected = new Set([
      '865860218',
      '999999999',
      '888888888',
      '777777777',
    ]);
    const r = validateStageCOverviewShape(VALID_RESPONSE, expected);
    expect(r).toEqual({
      ok: false,
      reason: 'expected-card-overlap-1-of-4',
    });
  });

  it('skips the expected-id check when the set is empty', () => {
    const r = validateStageCOverviewShape(VALID_RESPONSE, new Set());
    expect(r).toEqual({ ok: true, cardCount: 3 });
  });

  it('coerces numeric accountIds to string for set membership comparison', () => {
    // The response stores accountId as a number, but expectedCardIds
    // is keyed by string (matches AmazonG's ChaseProfile.cardAccountId
    // shape). Set the bar low to confirm coercion.
    const expected = new Set(['865860218']);
    const r = validateStageCOverviewShape(VALID_RESPONSE, expected);
    expect(r).toEqual({ ok: true, cardCount: 3 });
  });
});
