# Chase XHR capture findings — 2026-05-07

**Source:** real authenticated session against the user's Cuong card (account 865860218). Capture file: `research-logs/chase-xhr-54f1867e-30ba-4cd9-8b6b-7acdc094428b-2026-05-07T22-34-50-219Z.jsonl` (4.9MB, 58 unique XHRs in a 5s window).

## The endpoints that matter

### `secure.chase.com/svc/rl/accounts/secure/v1/dashboard/module/list?context=WEB_CREDIT_CARD_DASHBOARD`

**The single biggest finding.** This call returns a JSON object with a top-level `cache` array — Chase's SPA pre-loads downstream module fetches into one response. Inside the cache is the full account detail object with EVERY recon-bar field we currently scrape:

```json
{
  "code": "SUCCESS",
  "modules": ["CARD_REWARDS_SUMMARY", "CREDIT_CARD_ACCOUNT_DETAILS_TILE",
              "ACCOUNT_MIDAS_BANNER_AD", "DASHBOARD_CHASE_OFFERS",
              "ACCOUNT_DETAILS_TRANSACTIONS"],
  "cache": [{
    "url": "/svc/rr/accounts/secure/v2/account/detail/card/list",
    "request": {"context": "WEB_CREDIT_CARD_DASHBOARD",
                "selectorId": "865860218", "selectorIdType": "ACCOUNT"},
    "response": {
      "code": "SUCCESS",
      "accountId": 865860218,
      "nickname": "Amazon",
      "mask": "5088",
      "detail": {
        "currentBalance": 1002.77,         // → our "creditBalance"
        "availableCredit": 0,              // → our "availableCredit"
        "pendingChargesAmount": 0,         // → our "pendingCharges"
        "creditLimit": 35000,
        "paymentDetail": {
          "paymentAmount": 10628.21,       // amount due now
          "paymentMessageStatusCode": "PAYMENTTODAY"
        },
        "lastPaymentAmount": 13279.12,
        "lastPaymentDate": "20260504",
        "nextPaymentDueDate": "20260526",
        // ... ~30 more fields
      }
    }
  }]
}
```

**This means one nav + one XHR listener gives us creditBalance + availableCredit + pendingCharges with TYPED values** (no regex, no string parsing of `"$1,002.77"`).

### `secure.chase.com/svc/rr/accounts/secure/card/rewards/v2/summary/list`

Returns the rewards points balance — **served from secure.chase.com, NOT chaseloyalty.chase.com.**

```json
{
  "code": "SUCCESS",
  "cardRewardsSummary": [{
    "accountId": 865860218,
    "balance": 0,
    "currentRewardsBalance": 0,        // → our "pointsBalance"
    "cardType": "AMAZON_PRIME",
    "rewardsType": "POINTS",
    "asOfDate": "2026-05-07 02:18:33 EDT"
  }]
}
```

**This is the killer finding for perf:** we can eliminate the entire chaseloyalty.chase.com nav from the snapshot fetch. That nav alone costs ~4-9s (cross-domain SSO bounce). Gone.

### `secure.chase.com/svc/rr/accounts/secure/gateway/credit-card/transactions/inquiry-maintenance/etu-transactions/v4/accounts/transactions?digital-account-identifier=865860218&record-count=50&sort-order-code=D&sort-key-code=T`

Returns the recent transactions list (Amazon.com purchases, etc.) — distinct from in-process payments. We don't currently use this for the snapshot fetch but it's available.

```json
{
  "totalPostedTransactionCount": 36,
  "pendingAuthorizationCount": 9,
  "activities": [{
    "transactionStatusCode": "Pending",
    "transactionAmount": 1197,
    "transactionDate": "2026-05-07",
    "merchantDetails": {
      "rawMerchantDetails": {"merchantDbaName": "Amazon.com"}
    }
  }, ...]
}
```

### Other endpoints captured (not directly relevant for snapshot fetch)

- `/svc/wl/auth/public/v1/site/availability/list` — login form availability check (Akamai sensor)
- `/svc/wl/auth/l4/v1/user/router/list` — user/profile metadata
- `/svc/rl/accounts/l4/v1/app/data/list` — app config
- `/svc/wr/accounts/l4/v1/deck/messages/list` — UI banners/messages
- `/svc/wr/accounts/l4/dso/v2/offers/list` + `/svc/wr/accounts/secure/gateway/.../digital-offers/v2/offers` — promotional offers
- `/svc/wr/profile/secure/gateway/.../v3/customer-offers` — targeted offers
- `/svc/rr/accounts/secure/gateway/credit-card/servicing/.../v1/statement-flyouts` — statement metadata

### Endpoints NOT captured

**In-process payments endpoint** — the activity page nav from the snapshot fetch must have either: (a) used SPA hash-routing within the same shell with no new XHR, (b) the user has no in-process payments right now so the table fetch returned 0 rows without a visible XHR, or (c) Chase served from cache. **Need a follow-up capture** specifically while in-process payments are populated to identify the payments endpoint.

For now, Stage B can ship without it — just keep the existing activity page nav + DOM scrape for in-process payments. We still eliminate the loyalty nav and replace summary scraping with XHR interception.

## Confirmed architecture facts

1. **All data we currently scrape lives on `secure.chase.com`** — the chaseloyalty subdomain is unnecessary for snapshot fetch. (Loyalty is still needed for the redeem flow because Chase routes the cash-back form through it.)
2. **The summary URL hydrates ALL critical XHRs in one shot** — dashboard/module/list, rewards/v2/summary/list, etu-transactions, statement-flyouts all fire within ~4 seconds of nav.
3. **JSON responses use camelCase typed numbers** — `currentBalance: 1002.77` instead of `"$1,002.77"`. Cleaner than scraping strings.
4. **Chase's SPA cache pattern**: dashboard/module/list pre-loads the per-card detail response in its `cache` array, so the SPA doesn't make a separate XHR for it. We get the data "for free" from the dashboard call.
5. **Likely Akamai protection** confirmed — `/auth/fcc/adaptive` and `/svc/wl/auth/public/v1/site/availability/list` are the Akamai bot-manager sensor probes, fired even on warm sessions.

## Stage B implementation design

### What changes
Replace the current snapshot-fetch DOM-scrape pattern with passive XHR interception during the SUMMARY page nav, then drop the loyalty nav entirely.

```ts
async function runFetch(profileId, cardAccountId) {
  const session = await openChaseSession(profileId);
  const stopAutoSave = attachSessionAutoSave(session, profileId);
  try {
    const { page } = session;

    // Set up listeners BEFORE nav so we don't miss the early XHRs.
    let detailJson: any = null;
    let rewardsJson: any = null;
    page.on('response', async (resp) => {
      const url = resp.url();
      if (url.includes('/svc/rl/accounts/secure/v1/dashboard/module/list')) {
        try { detailJson = await resp.json(); } catch {}
      } else if (url.includes('/svc/rr/accounts/secure/card/rewards/v2/summary/list')) {
        try { rewardsJson = await resp.json(); } catch {}
      }
    });

    // ONE nav, replaces summary + loyalty
    await page.goto(summaryUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const recovery = await maybeAutoLoginAndContinue(page, profileId);
    if (!recovery.recovered) return { ok: false, reason: recovery.reason };

    // Race: either both XHRs land OR fall back to selector wait + DOM scrape
    const start = Date.now();
    while (!(detailJson && rewardsJson) && Date.now() - start < 15_000) {
      await page.waitForTimeout(100);
    }

    // Extract from JSON (typed values, no regex)
    const detail = detailJson?.cache?.[0]?.response?.detail;
    const creditBalance = formatAsDollars(detail?.currentBalance);
    const availableCredit = formatAsDollars(detail?.availableCredit);
    const pendingCharges = detail?.pendingChargesAmount > 0
      ? formatAsDollars(detail.pendingChargesAmount) : '';
    const pointsBalance = formatPoints(rewardsJson?.cardRewardsSummary?.[0]?.currentRewardsBalance);

    // Fall back to today's DOM scrape if the XHR pattern broke (Chase ships a new SPA)
    if (!creditBalance) {
      // ... existing locator-direct path as fallback
    }

    // Activity nav (in-process payments) — keep as-is until we capture its endpoint
    let inProcessPayments = [];
    try {
      await page.goto(activityUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      // ... existing DOM scrape
    } catch {}

    return { ok: true, snapshot: {...} };
  } finally { ... }
}
```

### Expected wins per snapshot fetch
- **Eliminate loyalty nav**: ~4-9s saved (cross-domain SSO bounce gone)
- **Eliminate selector waits + DOM scrape on summary**: ~250-450ms (Tier A already saved most of this; Stage B drops the rest)
- **Total: ~5-10s per snapshot fetch.** From ~10-23s today → ~5-13s after Stage B.

### Risk
- **Low.** XHR listener is passive — zero anti-bot impact. Fallback to today's DOM scrape if the JSON shape ever changes. Same exact session, same nav, just listening for free.

### What we still need to ship
1. The Stage B implementation in `src/main/chaseDriver.ts:runFetch`
2. A follow-up XHR capture specifically targeting the activity page when in-process payments are populated (to identify that endpoint and eliminate the activity nav too — Stage B+).
3. Optional: identify the redeem-flow endpoints by capturing during a real `redeemAllToStatementCredit` call.

## What this does NOT change

- Anti-bot posture: untouched. We're listening to XHRs the SPA was going to fire anyway.
- Login / re-auth flow: same `maybeAutoLoginAndContinue` recovery path.
- Cookie / localStorage persistence: same `attachSessionAutoSave` + storageState dump.
- Pay window flow + redeem flow: not touched (different code paths).
