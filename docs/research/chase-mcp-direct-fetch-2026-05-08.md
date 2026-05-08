# Chase MCP investigation — direct-fetch hybrid findings — 2026-05-08

**Method:** live authenticated session via Playwright MCP against user's Chase login. Probed every snapshot-fetch endpoint with `page.evaluate(fetch(...))` to confirm what the SPA's own XHR pattern can be replicated as a direct call — collapsing the current per-card nav-and-listen loop into a single nav + parallel fetches.

**Captured response bodies:** `.research/dashboard-module-list-overview.json`, `.research/cash-back-redemption-info.json`, `.research/pending-approval-overviews.json`.

## TL;DR — the headline finding

**Once a Chase profile is authenticated and a single page has loaded the SPA shell, every snapshot-fetch endpoint we care about is callable via `fetch()` from inside the page.** A `Promise.all` of overview + per-card detail + per-card rewards lands in **~282ms** end-to-end. This replaces today's per-card serial Chromium-spawn loop (~5–13s × N cards × concurrency=2 batches).

The biggest single discovery: `/svc/rl/accounts/secure/v1/dashboard/module/list?context=WEB_CBO_OVERVIEW_DASHBOARD` returns **all 13 of the user's cards in one response** — balance, available credit, pending charges, credit limit, payment detail, statement balance, last payment, nickname, mask. ONE call replaces N per-card calls.

## Confirmed endpoints (form-encoded POST, no JSON body, `x-jpmc-csrf-token: NONE` + `x-jpmc-channel: id=C30`)

### 1. Multi-card overview — NEW

```
POST /svc/rl/accounts/secure/v1/dashboard/module/list?context=WEB_CBO_OVERVIEW_DASHBOARD
content-type: application/x-www-form-urlencoded; charset=UTF-8
body: context=WEB_CBO_OVERVIEW_DASHBOARD&selectorIdType=CUSTOMER_GROUP
```

Response cache contains `/svc/rr/accounts/secure/overview/card/v2/list` with `cardAccountOverviews[].cardAccounts[]`. Each card carries:
- `accountId, nickname, mask, cardType`
- `cardAccountDetail.{currentBalance, availableCredit, pendingChargesAmount, creditLimit, lastPaymentAmount, lastPaymentDate, lastStmtBalance, lastStmtDate, nextPaymentDueDate, nextPaymentAmount, pastDueAmount, payInFull, paymentDetail, autoPayEnrolled, ...50 more}`

**Measured wall-clock from inside an authed page: 218ms.**

For the user's Cuong profile this returned 13 cards in one shot.

In-process payments are encoded inline:
```json
"paymentDetail": {
  "paymentAmount": 13278.77,
  "paymentMessageStatusCode": "PAYMENTSCHEDULED",
  "scheduledPaymentDate": "20260507"
}
```
**No need for the activity-page nav nor an `etu-transactions` capture** — scheduled payments are typed JSON in the overview response.

### 2. Per-card detail (already known, confirmed direct-fetch works)

```
POST /svc/rl/accounts/secure/v1/dashboard/module/list?context=WEB_CREDIT_CARD_DASHBOARD
body: context=WEB_CREDIT_CARD_DASHBOARD&selectorId=865860218&selectorIdType=ACCOUNT
```

Response cache contains `/svc/rr/accounts/secure/v2/account/detail/card/list` with the per-card `detail` object (same field shape as overview, plus a few extra: `lockStatus`, `lockStatusUpdatedDate`, `slateBalanceTransferEligible`).

**Wall-clock: 108ms.**

Useful only if the overview response doesn't already include the card you want, or if the per-card-only fields are needed.

### 3. Rewards points (already known, confirmed direct-fetch works — body shape was the bug)

```
POST /svc/rr/accounts/secure/card/rewards/v2/summary/list
body: accountId=865860218        ← NOT selectorId, NOT empty
```

**Wall-clock: 112ms per call. Parallelizable across cards.**

The 403 we saw initially was because we sent `selectorId=...` — the actual body shape is `accountId=...`. This was missed in the prior captures because no one extracted the request body, only the URL.

### 4. Cash-back form-load (loyalty side)

```
GET /rest/cash-back/redemption-info        ← chaseloyalty.chase.com origin
```

No body. Account context comes from the page URL `?AI={accountId}` query param read by the loyalty SPA. Response shape:
```json
{
  "points": { "minPoints": 1, "pointsBalance": 0, "pointsSelected": 0 },
  "statementCredit": { "accountIdentifier", "accountName", "accountNumber", "productType", "pointsToRedeem", "companyOwned" },
  "newAccount": { ... external direct-deposit target ... },
  "cashBackProductDataList": [ ...redeem targets... ]
}
```

**Loyalty `/home` nav is skippable.** Navigating directly to `https://chaseloyalty.chase.com/cash-back?AI={accountId}` loaded the form data correctly without first hitting `/home`. Saves ~3-5s on the redeem path.

## What's still not captured

- **Redemption POST endpoint** (Continue → Submit) — couldn't trigger because the user's Amazon card has 0 points right now. Still requires the AmazonG `AUTOG_CHASE_XHR_CAPTURE=1` capture path during a real redemption, as pass-4 originally recommended. The form-load shape we did capture is enough to replace the today's `redemptionInfo` data scrape and prep work, but the actual redeem POST URL/body/response shape remains unknown.
- **Pay-bill flow XHRs** — didn't navigate to pay flow this run. Lower priority since pay flow is rarely run.

## What this enables — a Stage C ("direct-fetch hybrid") for `runFetch`

### Today (Stage B, `chaseDriver.ts:1246-1599`)
- Spawn Chromium per profile
- Per-card: nav to summary URL, listen passively for dashboard XHR, listen passively for rewards XHR, scrape DOM for in-process payments
- Wall-clock: ~5-13s per card

### Stage C (new, enabled by these findings)
- Spawn Chromium per profile
- Nav once to `/web/auth/dashboard#/dashboard/overview` (or any authed shell URL)
- `Promise.all`:
  - `fetch(/svc/rl/.../dashboard/module/list?context=WEB_CBO_OVERVIEW_DASHBOARD)` — all cards
  - `fetch(/svc/rr/.../rewards/v2/summary/list)` per card — points
- Parse JSON, map to `ChaseAccountSnapshot` per card
- **Wall-clock: ~3-5s shell hydration + ~300ms parallel fetches**

For a 13-card profile: Stage B ~65-170s → Stage C ~5s. **30-50× speedup for users with many cards.**

For the user's typical case (1-4 cards): Stage B ~5-50s → Stage C ~5s. **1-10× speedup.**

### Implementation sketch

```ts
async function runFetchStageC(profileId: string, cardAccountIds: number[]) {
  const session = await openChaseSession(profileId);
  const stopAutoSave = attachSessionAutoSave(session, profileId);
  try {
    const { page } = session;
    await page.goto('https://secure.chase.com/web/auth/dashboard#/dashboard/overview', {
      waitUntil: 'domcontentloaded', timeout: 30_000,
    });
    const recovery = await maybeAutoLoginAndContinue(page, profileId);
    if (!recovery.recovered) return { ok: false, reason: recovery.reason };

    // ALL data via direct fetch from page.evaluate — no per-card nav
    const data = await page.evaluate(async (ids: number[]) => {
      const formHeaders = {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'accept': 'application/json, text/plain, */*',
        'x-jpmc-csrf-token': 'NONE',
        'x-jpmc-channel': 'id=C30',
      };
      const overview = fetch('/svc/rl/accounts/secure/v1/dashboard/module/list?context=WEB_CBO_OVERVIEW_DASHBOARD', {
        method: 'POST', credentials: 'include', headers: formHeaders,
        body: 'context=WEB_CBO_OVERVIEW_DASHBOARD&selectorIdType=CUSTOMER_GROUP',
      }).then(r => r.json());
      const rewards = ids.map(id => fetch('/svc/rr/accounts/secure/card/rewards/v2/summary/list', {
        method: 'POST', credentials: 'include', headers: formHeaders,
        body: `accountId=${id}`,
      }).then(r => r.json()));
      const [overviewJson, ...rewardsJsons] = await Promise.all([overview, ...rewards]);
      return { overviewJson, rewardsJsons };
    }, cardAccountIds);

    // Map to ChaseAccountSnapshot per card (typed JSON, no regex)
    const cards = data.overviewJson?.cache
      ?.find((c: any) => c.url?.includes('overview/card/v2'))
      ?.response?.cardAccountOverviews?.flatMap((o: any) => o.cardAccounts) ?? [];
    return { ok: true, snapshots: cards.map((c: any, i: number) => ({
      cardAccountId: c.accountId,
      nickname: c.nickname,
      mask: c.mask,
      creditBalance: formatAsDollars(c.cardAccountDetail.currentBalance),
      availableCredit: formatAsDollars(c.cardAccountDetail.availableCredit),
      pendingCharges: c.cardAccountDetail.pendingChargesAmount > 0
        ? formatAsDollars(c.cardAccountDetail.pendingChargesAmount) : '',
      creditLimit: formatAsDollars(c.cardAccountDetail.creditLimit),
      pointsBalance: formatPoints(data.rewardsJsons[i]?.cardRewardsSummary?.[0]?.currentRewardsBalance),
      paymentDetail: c.cardAccountDetail.paymentDetail,
      // ... +30 more fields per pass-4 widening
    })) };
  } finally {
    stopAutoSave();
    await session.close();
  }
}
```

## Anti-bot posture — UNCHANGED

The fetches go through the page's own JS context, share the page's TLS session, share the page's `_abck`/`bm_*` cookie state, and look identical to the SPA's own XHRs (same headers Chase ships, same URL, same form-encoded body). The SPA fires these exact endpoints itself on hydration — we just call them directly instead of waiting for it to.

This is **NOT** the `context.request.get()` Node-side path that pass-2 ruled out (TLS / JA3 mismatch). This is in-page `fetch()` — same Chrome process, same TLS handshake, same fingerprint envelope.

## What stays the same

- Login / re-auth / OTP / session-state save
- Pay window flow (separate code path)
- Redeem flow (still click-through; gated on a real redemption capture for Stage C-redeem)
- Akamai cookie filter from pass-3
- Keepalive XHR pattern (already uses the same `page.evaluate(fetch())` shape)
- Blocklist

## Risks and unknowns

- **Akamai sensor freshness:** the SPA fires a sensor POST on hydration; that's what mints `_abck`. Direct-fetch after `domcontentloaded` should be safe because the dashboard DOM has rendered (sensor JS has run). If this is too fast, we may need to wait for the SPA's own first `dashboard/module/list` to land before firing ours. Worth measuring.
- **Future Chase SPA refactor:** if Chase changes the body param from `selectorIdType=CUSTOMER_GROUP` or moves the cache pattern, we break. Mitigation: same as Stage B — fall back to the existing per-card listener path if the JSON shape is wrong.
- **Per-customer responses:** the overview response is shaped per Chase user; AmazonG's per-profile model maps cleanly (one customer = one Chase login = one fetch). No multi-customer aggregation issue.
- **Rewards endpoint per-card cost:** still N fetches × ~110ms. Parallelizable in `Promise.all`. For 13 cards parallelized: ~150-300ms total (all-in). Bigger profiles may need throttling but 13 worked fine in this run.

## Suggested ship path

| Tier | Item | LOC | Risk |
|---|---|---|---|
| **C1** | Stage C `runFetchOverview` for the multi-card path (new code path; gate behind a feature flag for the first release) | ~120 | Low — fallback to Stage B preserved |
| **C2** | Drop activity-page nav from Stage B once Stage C ships | -40 LOC | Zero |
| **C3** | Skip loyalty `/home` nav in redeem flow; navigate straight to `/cash-back?AI=...` | ~5 | Low |
| **C4** | Real redemption capture (`AUTOG_CHASE_XHR_CAPTURE=1`) to unblock Stage C-redeem | 5 min user time | Zero |

Stage C is the natural next ship after the current `chase-perf-tier-a` branch lands.
