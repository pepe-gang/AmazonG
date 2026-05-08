# Chase pending-charges JSON source — empirical verification — 2026-05-08

**Method:** Playwright MCP, live authenticated session against Cuong's Amazon card (account 865860218), comparing DOM, dashboard JSON, and `etu-transactions` JSON for the "Pending charges:" value.

## Headline finding

| Source | Value |
|---|---|
| DOM `.activity-tile__recon-bar` "Pending charges:" line | **$13,802.55** |
| Dashboard JSON `cardAccountDetail.pendingChargesAmount` | **0** ❌ unreliable, confirmed |
| `etu-transactions` `totalPendingChargeAmount` (top-level) | **$13,802.55** ✅ matches DOM |
| Sum of `etu-transactions` `activities[].transactionAmount` where `transactionStatusCode === "Pending"` | **$13,802.55** ✅ same |

**Resolves pass-7 round-2's open question.** The dashboard JSON's `pendingChargesAmount` field has been confirmed unreliable (the chaseDriver.ts:1395-1405 comment from prior work was correct). The clean replacement is the `etu-transactions` endpoint's top-level `totalPendingChargeAmount`.

## Endpoint details

```
GET /svc/rr/accounts/secure/gateway/credit-card/transactions/inquiry-maintenance/etu-transactions/v4/accounts/transactions
  ?digital-account-identifier={cardAccountId}
  &record-count=50
  &sort-order-code=D
  &sort-key-code=T
```

Headers required:
- `accept: application/json, text/plain, */*`
- `x-jpmc-csrf-token: NONE`
- `x-jpmc-channel: id=C30`

Response shape (top-level keys, abbreviated):
- `totalPendingChargeAmount` — number, the pending sum we want
- `pendingAuthorizationCount` — count of pending entries
- `totalPostedTransactionCount`
- `activities[]` — full transaction list (pending + posted)
- `asOfDate` — YYYY-MM-DD freshness stamp

## Caveats

- **`record-count` matters.** With `rc=1` we got `totalPendingChargeAmount: -62.43` (the field is computed across the records returned, not globally). With `rc=50` we got the correct total. **Always use `record-count=50`** to match Chase's own SPA behavior. The user's Amazon card has 14 pending; rc=50 covers it with margin. For users with >50 pending, we'd undercount — pass-4 round 1 and pass-7 round 2 both flagged that the SPA's record-count=50 default is the de-facto ceiling.
- **`record-count=0` and missing `record-count` both return 400.** Required parameter.
- **Anti-bot posture: identical to Stage B.** The SPA fires this exact endpoint on per-card summary nav; we just call it directly. Same TLS, same cookies, same headers.

## All-fetches parallel timing

From the OVERVIEW page (no per-card nav), 3 parallel fetches via `Promise.all`:
- `dashboard/module/list?context=WEB_CBO_OVERVIEW_DASHBOARD` (overview, multi-card)
- `card/rewards/v2/summary/list` (per-card rewards)
- `etu-transactions/v4/accounts/transactions` (per-card pending charges)

**Total wall-clock: 609ms** (single Cuong profile, 13 cards covered by overview).

## Implications

- **DOM scrape of "Pending charges:" can be eliminated** on the Stage C happy path. Today's path adds ~5s `text=/Pending charges:/i` wait + ~1-2s `page.content()` parse = **~5-7s saved per refresh on the happy path**.
- Stage B fallback path (when Stage C fails) keeps the DOM scrape so we don't lose coverage.
- Future: the per-card summary nav itself could be eliminated (overview page provides all card data). Saves the ~3-5s nav. Deferred to a separate change so this PR's blast radius is bounded.
