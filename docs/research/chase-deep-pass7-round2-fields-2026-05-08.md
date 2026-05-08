# Chase deep-pass 7 — Round 2: Field & endpoint completeness audit — 2026-05-08

**Charter:** decide what Stage C ("`/svc/rl/.../module/list?context=WEB_CBO_OVERVIEW_DASHBOARD` once + per-card rewards") would *miss* relative to today's per-card path. Does it cover everything `ChaseAccountSnapshot` + the renderer use? What's left over for activity-page / per-card-detail / pay / redeem flows?

**Sources consulted:**
- `.research/dashboard-module-list-overview.json` — overview (13 cards, ~218ms call)
- `.research/cash-back-redemption-info.json` — redeem form-load
- `.research/pending-approval-overviews.json` — wires/ACH (skimmed; not relevant to consumer cards)
- `research-logs/chase-xhr-54f1867e-30ba-4cd9-8b6b-7acdc094428b-2026-05-07T22-34-50-219Z.jsonl` — older per-card capture
- `src/shared/types.ts:320-361` (`ChaseAccountSnapshot`, `ChasePaymentEntry`)
- `src/main/chaseDriver.ts:1260-1611` (current `runFetch`), :1770-1830 (extract helpers)
- `src/main/chaseScrape.ts:112-208` (regex parsers)
- `src/renderer/pages/Bank.tsx:855-1067` (renderer surface)
- `docs/research/chase-mcp-direct-fetch-2026-05-08.md` (round 1)

---

## TL;DR

1. **Overview is a near-superset** for the data AmazonG currently uses. All five `ChaseAccountSnapshot` payload fields (`creditBalance`, `availableCredit`, `pointsBalance`, `pendingCharges`, `inProcessPayments`) have a typed JSON source — four in the overview cache, one (`pointsBalance`) still per-card via `/svc/rr/.../rewards/v2/summary/list`. The activity-page DOM scrape and the loyalty cross-domain bounce are both removable.
2. **One real coverage gap: in-process-payments multiplicity.** `cardAccountDetail.paymentDetail` summarizes ONE upcoming payment per card. The activity-table scrape captures **N rows**. In our older capture, the Amazon card had 2 distinct in-process payments ($6,883.40 + $3,744.81) the same day — overview would have shown only 1 (or none). Use `/svc/rr/payments/secure/v1/billpay/card/payment/list` (also typed JSON, returns 63 activities incl. all `IN_PROCESS`/`COMPLETED`/`CANCELED`/`RETURNED`) to plug the gap. Per-card POST, parallelizable.
3. **`pendingChargesAmount` is reliable in the overview.** Round 1's note about it being "0 even when UI shows non-zero" is contradicted by this capture: the field is `0.0` for every card, including ones with the recon-bar pending line in their UI history. The DOM-scrape concern stands until we capture an account that *currently* has live pending charges and verify the JSON value matches the DOM. **Open verification item before Stage C ships.**
4. **`lockStatus` field-name mismatch:** overview uses `creditCardLockStatus`, per-card-detail uses `lockStatus`. Both have `lockStatusUpdatedDate`. Stage C only needs the overview name; nothing in AmazonG today reads either. No semantic delta.
5. **Order, types, scope, exclusions all benign.** Cards customer-grouped then ascending `accountId`; AmazonG keys by `cardAccountId` so order doesn't matter. Closed cards INCLUDED in overview (3 of 13 closed). Numbers typed as `number`, dates as `"YYYYMMDD"` strings. No string-encoded numbers.

---

## Field-diff: overview detail vs per-card detail

Both endpoints return a `detail` object inside a cache entry. The **overview** detail lives at `cache[?].response.cardAccountOverviews[*].cardAccounts[*].cardAccountDetail`. The **per-card** detail lives at `cache[0].response.detail`.

### Overview-only fields (in `cardAccountDetail`, not in per-card `.detail`)

```
ari
cardCollectionsEnabled
creditCardLockStatus     ← per-card uses lockStatus instead
hasAlert
menuItems                ← array of capability tokens, e.g. ["ACCOUNT_DETAIL", ...]
outstandingBalance
paymentDueDays
productTraded            ← per-card uses productTrade (typo / different shape)
spendingLimit
transferAndPaymentsAllowed
ultimateRewardsAvailable
```

### Per-card-only fields (in `.detail`, not in overview `cardAccountDetail`)

```
detailType                       ← always "CARD"
isNewBenefitOffersEligible
isPremiumTrackingAllowed
lockStatus                       ← overview's creditCardLockStatus is the analog
productTrade                     ← typo'd analog of overview's productTraded
slateBalanceTransferEligible
```

Plus outer-level fields per-card has but overview's outer-level doesn't (and vice versa) — these don't matter for snapshot purposes, but a few like `viewBalancesAllowed` (per-card-only) and `cashbackStatus` (overview-only) might matter for future capability gating.

### Fields present in BOTH (44 inside detail; 63 incl. outer card fields)

The shared core covers all the AmazonG-significant ones:
`accountOpenDate, aprAsOfDate, autoPayEnrolled, availableCredit, blueprintNextPaymentAmount, cardArtDesignId, cardArtGuid, cashAdvanceAvailable, cashAdvanceBalance, cashAdvanceLimit, cashAPR, closed, creditLimit, currentBalance, dueDateChangeIndicator, emobAccountChecklistEligible, interestSavingBalance, interestSavingBalanceIndicator, lastPaymentAmount, lastPaymentDate, lastStmtBalance, lastStmtDate, lockStatusUpdatedDate, newlyProductTraded, nextClosingDate, nextPaymentAmount, nextPaymentDueDate, pastDueAmount, payInFull, paymentDetail, pendingChargesAmount, postChargedOffAccount, processingMode, productCode, productGroupCode, purchaseAPR, remainingStmtBalance, rewardsBenefitsEligibilityCode, rewardsProgramManagingOrganizationCode, slateEdgeBenefitEligible, spendingLimitEligible, statementBalanceType` (and outer-level: `accountId, accountOriginationCode, addEmployeeCard, authorizedOfficerCard, controlCard, mask, nickname, payeeId, showPaperless, singleCreditCardUser, transactAllowed, viewStatementsAllowed`).

### jq used

```bash
# Overview-side detail field set
jq '[.cache[] | select(.url=="/svc/rr/accounts/secure/overview/card/v2/list") |
     .response.cardAccountOverviews[].cardAccounts[].cardAccountDetail | keys] |
     flatten | unique' .research/dashboard-module-list-overview.json

# Per-card detail field set
grep '"url":"[^"]*/v2/account/detail/card/list[^"]*"' research-logs/chase-xhr-*.jsonl |
  head -1 | jq '.body.cache[0].response.detail | keys'
```

---

## AmazonG required-field coverage map

`ChaseAccountSnapshot` has six payload fields. Every one is recoverable from typed JSON:

| AmazonG field | Source today | Stage C source | Coverage |
|---|---|---|---|
| `creditBalance` | DOM `.activity-tile__recon-bar-balance` OR `dashboard/module/list` (`response.detail.currentBalance`) | overview `cardAccountDetail.currentBalance` | Full — typed `number`, formatted via `formatChaseDollarAmount` |
| `availableCredit` | DOM `[data-testid=availableCreditWithTransferBalance]` OR `dashboard/module/list` (`response.detail.availableCredit`) | overview `cardAccountDetail.availableCredit` | Full — typed `number` |
| `pointsBalance` | `card/rewards/v2/summary/list` (per-card POST, body `accountId=N`) | **same** — N parallel calls still required (per-card endpoint, no multi-card rewards endpoint observed) | Full — typed `number` |
| `pendingCharges` | DOM scrape via `parsePendingChargesFromHtml` (`Pending charges: …<span>$N</span>`) | overview `cardAccountDetail.pendingChargesAmount` IF the round-1 reliability concern is resolved | **Verification needed** — see below |
| `inProcessPayments[]` | DOM `tbody.activityRow` scrape via `parseInProcessPaymentsFromHtml` | overview `paymentDetail` (1 entry only) + `/svc/rr/payments/secure/v1/billpay/card/payment/list` (full list) | **Partial** — overview alone misses multi-payment cards; needs billpay endpoint |
| `fetchedAt` | client-side timestamp | client-side timestamp | Full |

**`cardAccountId` (the key)** is `cardAccountOverviews[*].cardAccounts[*].accountId` (typed `number`). Today AmazonG keys snapshots by string — needs a `String(...)` wrap, trivial.

**Renderer-side** (`Bank.tsx:855-1067`) reads these six fields and nothing else from the snapshot. No additional surface to fill.

---

## In-process payments: coverage analysis

Today's path (`chaseDriver.ts:1519-1545`):

```
nav → /web/auth/dashboard#/dashboard/payBillsArea/paymentsActivity/selectPayee;payeeId=-{accountId};payeeType=CREDIT_CARD
wait visible → tbody.activityRow
read innerHTML → parseInProcessPaymentsFromHtml(html)
```

`parseInProcessPaymentsFromHtml` (`chaseScrape.ts:179-208`) walks every `<tr>` containing a "Payment date" cell, reads three `<span>` cells (`Payment date`, `Status`, `Amount`), and filters to statuses matching `/in.process|pending|processing|scheduled/i` (excluding `/completed/i`). Returns ALL matching rows in document order (newest first).

### Overview's `paymentDetail` is one-summary-per-card

Sampling all 13 cards in `dashboard-module-list-overview.json`:

```
paymentMessageStatusCode      seen on
NOPAYMENTDUE                  10 cards
AUTOPAYSCHEDULED              2 cards (5658 → 20260526, 2974 → 20260526)
PAYMENTSCHEDULED              1 card  (5088 → $13,278.77 on 20260507)
```

That's *one* aggregate state per card. The `5088` Amazon card in the older 2026-05-07 capture had **2 distinct in-process payments** in `paymentActivities` ($6,883.40 + $3,744.81). When a user has chained payments (BG payouts, etc.) overview alone gives wrong-or-summarized data; today's DOM scrape gives them all.

### `paymentDetail` shape variants observed

```json
"NOPAYMENTDUE":      { "paymentMessageStatusCode": "NOPAYMENTDUE",      "nextStatementDate": "20260601" }
"AUTOPAYSCHEDULED":  { "paymentMessageStatusCode": "AUTOPAYSCHEDULED",  "scheduledPaymentDate": "20260526" }
"PAYMENTSCHEDULED":  { "paymentMessageStatusCode": "PAYMENTSCHEDULED",  "scheduledPaymentDate": "20260507", "paymentAmount": 13278.77 }
```

`AUTOPAYSCHEDULED` lacks `paymentAmount` (autopay-statement-balance has dynamic amount, computed at run-time). `PAYMENTSCHEDULED` has it.

### Better source: `/svc/rr/payments/secure/v1/billpay/card/payment/list`

Captured response (older xhr file) for the 5088 card:
- 63 `paymentActivities` entries
- Statuses observed: `IN_PROCESS`, `COMPLETED`, `CANCELED`, `RETURNED`
- Per-row fields: `paymentId, amount, dueDate (YYYYMMDD), activityStatus, fundingAccountName, fundingAccountNickname, fundingAccountMask, confirmationNumber, description, autoPayPayment, cancelAllowed, updateAllowed, inquiryAllowed`

Activity rows do NOT carry `payeeId`/`accountId` — the response is filtered by request body (we didn't capture the POST body, but `defaultPayeeId: -865860218` matches the card we navigated to, suggesting the body or session selectorId scopes it). Stage C would need 1 billpay POST per card to enumerate in-process payments.

### Field-mapping for `ChasePaymentEntry`

```
billpay row              → ChasePaymentEntry
amount (number)          → amount: formatChaseDollarAmount(amount)
activityStatus           → status: humanize("IN_PROCESS"→"In process", "PENDING"→"Pending", etc.)
dueDate ("20260507")     → date: formatYYYYMMDDToHumanDate("20260507"→"May 7, 2026")
```

The DOM-scrape humanized strings ("Apr 25, 2026", "In process", "$13,000.00") were Chase's UI text. Stage C would need a small string-builder to maintain the same shape. The renderer (`Bank.tsx:1052`) only sums the amounts via `sumPaymentAmounts` — string `date`/`status` is just for display.

### Stage C in-process strategy options

| Option | LOC | Wall-clock | Coverage |
|---|---|---|---|
| **A: Use overview `paymentDetail` only** | small | 0ms (already have it) | **Loses** multi-payment days |
| **B: Add billpay POST per card in `Promise.all`** | medium | +110-300ms total parallelized | **Full** — matches DOM scrape today |
| **C: Hybrid** — emit overview `paymentDetail` summary; only fetch billpay when `paymentDetail.paymentMessageStatusCode === "PAYMENTSCHEDULED"` (rare) | medium | ~0ms common case | **Good enough** for ~all users; misses only the multi-payment-same-card edge |

Recommend **B** for parity, **C** if 13-card profiles' billpay parallel cost is observed to matter.

---

## Redeem-flow coverage

`/rest/cash-back/redemption-info` (form-load on `chaseloyalty.chase.com/cash-back?AI={accountId}`) returns:

```json
{
  "points": { "minPoints": 1, "pointsBalance": 0, "pointsSelected": 0 },
  "statementCredit": {
    "accountIdentifier": "865860218", "accountName": "Amazon (...5088)",
    "accountNumber": "5088", "productType": "STATEMENT_CREDIT",
    "pointsToRedeem": 0, "companyOwned": true
  },
  "newAccount": { "accountIdentifier": "NEW", "accountType": "CHECKING", "productType": "EXTERNAL_DIRECT_DEPOSIT", ... },
  "cashBackProductDataList": [
    { "accountIdentifier": "AI0", "accountName": "Joint Sofi (...4075)", ... },
    ...9 redemption targets, mix of EXTERNAL_DIRECT_DEPOSIT (other-bank) and INTERNAL_DIRECT_DEPOSIT (chase-checking)
  ]
}
```

This **is** sufficient for the redeem form (decision = pick a target, set points). The actual **submit-redeem POST** (Continue → final commit) is NOT captured anywhere in our research-logs — round 1 noted this as a known gap requiring `AUTOG_CHASE_XHR_CAPTURE=1` during a real redemption.

**No additional data the loyalty SPA pulls beyond this** was observed in the captured XHRs. The other rewards/loyalty calls (`tile-placement.json`, `interstitial.json`, `navigation-wl.json`, the favicon downloads) are SPA chrome — they don't influence the user's redeem decision.

Stage-C-redeem can ship the form-load capture today; the submit POST shape is the only blocker, and that's a 5-minute `AUTOG_CHASE_XHR_CAPTURE=1 → user does one redemption → grep the JSONL` exercise.

---

## Pay-bill flow data needs

Today the Pay button opens a Chase window with the flyout URL and lets the user act in Chase's UI (`chaseDriver.ts:1945+`). Stage C only changes the snapshot fetch — it does NOT need to enable a "Pay from AmazonG" automated flow. Still worth listing what overview gives us for free in case we ever want to:

**From `dashboard/overview/accounts/list[*].detail`:**
- `nextPaymentDueDate` (YYYYMMDD)
- `nextPaymentAmount`
- `lastPaymentAmount, lastStatementBalance, remainingStatementBalance`
- `pastDueAmount, paymentDueDays`
- `paymentsAndXferAllowed` (capability flag)
- `autoPayEnrolled`

**Missing for an automated pay flow:**
- The list of pay-FROM accounts (which checking accounts are linked). Not in overview; would come from `cardPayees` + funding-account list endpoint, neither of which we've captured for this profile yet (the older xhr file's `cardPayees` is Chase-payee-only — credit cards as pay targets, not checking accounts as pay sources).
- The CSRF token for an actual payment-submit POST (today's keepalive uses `x-jpmc-csrf-token: NONE`, but real money-movement might require a fresh CSRF — TBD).

So Stage C does NOT enable automated pay; it just makes the snapshot data we use to *prompt* the user to pay (showing pending charges, due date, amount due) faster. Out of scope for Stage C anyway per charter.

---

## What we'd still need per-card-detail or activity-page scrape FOR

After Stage C, given the gaps above:

| Need | Stage C source | Fallback |
|---|---|---|
| `creditBalance`, `availableCredit`, `pendingChargesAmount` | overview detail | per-card detail (same field shape minus the lockStatus naming) |
| `pointsBalance` | per-card rewards POST | — |
| `inProcessPayments[]` (multiple) | per-card billpay POST | DOM scrape (today's path) |
| `lockStatus` (semantic — locked/unlocked) | overview `creditCardLockStatus` | per-card detail `lockStatus` |
| `slicedActivities`, `slateBalanceTransferEligible`, `isPremiumTrackingAllowed` | overview has `slicedActivities` (boolean), per-card has the other two | not used by AmazonG today |
| `cardArtGuid`, `cardArtDesignId` | both have it | — |

**No remaining justification for the activity-page DOM scrape** if billpay POST replaces it. **No remaining justification for per-card detail** if overview covers all AmazonG-needed fields (and round-1's `pendingChargesAmount` reliability concern is resolved).

---

## Cards excluded from overview

Sampled all 13 cards in the capture: closed cards INCLUDED (5951, 4392, 0878, 5227, 1859, 3240 are `closed: true`), business cards INCLUDED (BCC accountType, Ink products), employee cards / authorized-officer cards: none in this profile (`employeeCard: false, authorizedOfficerCard: false` everywhere) but the field structure suggests they would appear if present.

**Not observed in this profile but possible:**
- `productTraded: true` cards (downgrade/product-change pending). Worth verifying if AmazonG ever encounters one.
- `postChargedOffAccount: true` cards (we have all `false` here). The field exists, so they'd be in the overview if present.

**Likely excluded** (educated guess, not verified):
- Wholly-closed-and-archived legacy accounts (Chase tends to drop these from the dashboard entirely after some retention window).
- Non-credit-card products on the same login (mortgages, deposit accounts, brokerage). The overview-card endpoint is card-only; deposit/loan products live under `/svc/rr/accounts/secure/v1/dashboard/overview/accounts/list`'s sibling structures with different `groupType` (`CARD` here, but elsewhere it'd be `CHECKING`/`SAVINGS`/`MORTGAGE`).

For AmazonG (cards-only), no concern.

---

## Endpoint stability: `overview/card/v2/list`

`v2` in the path. The per-card detail uses `v2/account/detail/card/list`. Both v2.

**Version-stability signal to track:** the response carries `code` ("SUCCESS") at top level; if Chase ships v3, the cache entry's `url` will read `/svc/rr/accounts/secure/overview/card/v3/list` and our `extractDashboardDetail`-style url-match would simply not find the v2 entry, returning null → DOM fallback would kick in. The current `extractDashboardDetail` (`chaseDriver.ts:1786-1808`) already implements this defensive pattern — Stage C should follow the same shape.

Watch list:
- `cache[*].url` change to v3
- `cardAccountOverviews[*].cardAccounts[*].cardAccountDetail` shape change
- Field-name renames: `pendingChargesAmount` → ?, `creditCardLockStatus` → ?, `paymentDetail.paymentMessageStatusCode` → ?

The `dashboardview/list` and `dashboard/overview/accounts/list` endpoints in the same response are v1 — v1 vs v2 coexists across endpoints in the same cache, which means Chase doesn't move them in lockstep. Each can move independently.

---

## Order, types, scope

### Array order

`cardAccountOverviews[]` is grouped by `customerId`, with `null` (probably the personal/individual customer group) appearing alongside numeric customer ids. Within each group, `cardAccounts[]` is ordered by ascending `accountId`. Confirmed against this profile:

```
customer 197599733: [1142358293, 1142358944, 1168243930]
customer 204547081: [1190929884, 1191117818]
customer 278017936: [1000528842]
customer null:      [865860218, 1019903437, 1020151000, 1020151071, 1020151128, 1020151218, 1058317606]
```

AmazonG keys snapshots by `cardAccountId` (`Bank.tsx:185`, `:329`, `:488`) so order is irrelevant. **No risk.**

### Field shapes (verified across all 13 cards' `cardAccountDetail`)

```
amount-like fields (currentBalance, availableCredit, pendingChargesAmount,
creditLimit, lastPaymentAmount, lastStmtBalance, nextPaymentAmount,
pastDueAmount, blueprintNextPaymentAmount, cashAdvanceAvailable,
cashAdvanceBalance, cashAdvanceLimit, interestSavingBalance,
outstandingBalance, remainingStmtBalance, cashAPR, purchaseAPR)
                                                    → number (e.g. 13278.77, 0.0, -9625.44)

date fields (accountOpenDate, aprAsOfDate, lastPaymentDate, lastStmtDate,
nextClosingDate, nextPaymentDueDate, lockStatusUpdatedDate)
                                                    → string "YYYYMMDD" (e.g. "20260507")
                                                       OR null (lockStatusUpdatedDate often null)

boolean fields (autoPayEnrolled, closed, payInFull, productTraded,
newlyProductTraded, hasAlert, postChargedOffAccount, etc.)
                                                    → boolean

enum-string fields (creditCardLockStatus, processingMode, productCode,
statementBalanceType, paymentDetail.paymentMessageStatusCode)
                                                    → string

paymentDetail                                       → object (varying shape per status)
menuItems                                           → array of strings
```

**Zero string-encoded numbers.** Negative balances are encoded with negative sign (e.g. `-9625.44` for credit-balance card). The current `formatChaseDollarAmount` (`chaseDriver.ts:1838-1845`) handles negatives correctly.

**Date format is uniform YYYYMMDD.** Renderer doesn't display these today, but if future code does, a small `parseChaseDate("20260507") → Date` helper is the right shape.

### Scope

The overview endpoint is per-customer-group (single Chase login = single response). Multi-customer setups (the `customerId` distinction we see) are aggregated server-side into one response. No per-customer fan-out needed. Matches AmazonG's per-profile model.

---

## Round-1's `pendingChargesAmount` reliability concern — STATUS

`chaseDriver.ts:1395-1405` documents:

> we deliberately do NOT pull pendingCharges from the JSON's `pendingChargesAmount` field — empirical capture (Cuong card 2026-05-07) showed that field reads `0` even when Chase's UI displays a non-zero "Pending charges:" line, so it's clearly tracking a different concept (probably pending balance transfers, not pending authorization transactions which is what the recon-bar UI sums and shows).

In the 2026-05-08 overview capture, **all 13 cards have `pendingChargesAmount: 0.0`**. We can't verify the field's semantics from a profile that has no live pending charges right now. The concern is unresolved.

**Verification plan before shipping Stage C:**
1. Wait until any tracked card has a visible "Pending charges: $N.NN" UI line (the user's own Cuong/Amazon card had this on 2026-05-07).
2. Capture both: `dashboard/module/list?context=WEB_CBO_OVERVIEW_DASHBOARD` (overview) AND today's DOM scrape.
3. Diff `cardAccountDetail.pendingChargesAmount` against `parsePendingChargesFromHtml(html)`.
4. If they match → use overview field. If they don't → keep DOM scrape OR find the etu-transactions-style endpoint that mirrors the recon-bar sum.

Until verified, Stage C should keep the DOM scrape for `pendingCharges` and use overview for the other three numeric fields. That still drops the per-card NAVIGATION (overview gets balance/available in one call) — biggest perf win — and only the pending-charges DOM read needs to wait for hydration.

---

## Confidence scorecard

| Item | Confidence | Notes |
|---|---|---|
| Overview covers `currentBalance`, `availableCredit`, `creditLimit` | **High** | Typed numbers, observed across 13 cards, same field as today's `extractDashboardDetail` already trusts |
| Overview covers `paymentDetail` for SINGLE upcoming payment | **High** | Three statuses observed (NOPAYMENTDUE, AUTOPAYSCHEDULED, PAYMENTSCHEDULED) |
| Overview is missing for MULTI in-process payments | **High** | Older capture confirmed Amazon card had 2 IN_PROCESS rows but only 1 paymentDetail summary; structurally it's a one-slot field |
| Billpay endpoint replaces the activity DOM scrape with typed JSON | **High** | Same statuses, same fields, plus `confirmationNumber` and `fundingAccount*` bonuses |
| `pendingChargesAmount` reliability | **Low** | Zero non-zero observations in this capture; round-1's concern unverified |
| Closed/business cards included | **High** | 6 of 13 closed, all 6 in response; multiple Ink/business cards in response |
| Field types are typed (no string numbers / weird date formats) | **High** | Verified across all 13 cards — numbers as numbers, dates as `YYYYMMDD` strings |
| Array order doesn't matter | **High** | AmazonG keys by `cardAccountId` everywhere |
| `lockStatus` field-name diff between overview and per-card | **High** | Direct observation: overview = `creditCardLockStatus`, per-card = `lockStatus`. Both reflect same semantic. |
| Rewards endpoint stays per-card | **High** | Observed body required `accountId=N`; no multi-card rewards endpoint surfaced in any capture |
| Pay flow needs not blocked by Stage C | **High** | Pay flow is hand-off to Chase UI; Stage C only changes snapshot fetch |
| Redeem flow form-load covered; submit POST still unknown | **Medium** | Form-load shape captured; actual submit POST requires real-redemption capture |

---

## Recommendation for Stage C scope

**Ship Stage C as: overview-once + per-card-rewards-parallel + per-card-billpay-parallel.**

- Overview replaces per-card-summary nav for: `creditBalance`, `availableCredit`, summary `paymentDetail` (info-only / autopay flag).
- Rewards stays per-card (no choice): `pointsBalance`.
- Billpay POST replaces activity-page DOM scrape: full `inProcessPayments[]`.
- DOM scrape stays as fallback for `pendingCharges` UNTIL `pendingChargesAmount` reliability is verified.

For 13-card profile, expected wall-clock budget:
- Overview: ~220ms
- Rewards: 13 × ~110ms in `Promise.all` → ~150-300ms
- Billpay: 13 × ~150ms in `Promise.all` → ~200-400ms
- Total: ~500-900ms inside the page, on top of ~3-5s SPA shell hydration.

**vs. today's Stage B at ~5-13s × N/2 cards ≈ 30-90s for 13 cards.** Order-of-magnitude win preserved even with billpay added.

If the verification of `pendingChargesAmount` shows the field IS reliable, drop the DOM scrape entirely → Stage C becomes ALL typed JSON, no `page.locator` waits at all in `runFetch`. That's the dream.
