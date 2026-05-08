# Chase deep pass 7 — round 5: adjacent direct-fetch opportunities — 2026-05-08

**Charter:** Map every other AmazonG flow that navigates Chase windows or scrapes Chase DOM, rank by feasibility of converting to the same direct-fetch pattern proven in `chase-mcp-direct-fetch-2026-05-08.md`.

**Sources used:**
- `research-logs/chase-full-*.jsonl` (3 files, 2026-05-08, full request/response metadata, no bodies)
- `research-logs/chase-xhr-*.jsonl` (4 files, 2026-05-07, request/response with JSON bodies)
- `.research/dashboard-module-list-overview.json` (canonical overview cache)
- `.research/cash-back-redemption-info.json` (loyalty form-load response)
- `.research/pending-approval-overviews.json` (wires/ACH approval queue, not relevant)
- `src/main/chaseDriver.ts` (~2000 LoC)
- `src/main/index.ts` (Chase IPC handlers)

## TL;DR

1. **Pay-bill flow form-load is fully direct-fetchable.** 4 captured XHRs (`/billpay/card/payment/list`, `/autopayment/status/list`, `/merchantmultipayment/payee/list`, `/multi/payment/add/options`) cover everything Chase shows on the Pay flyout. The Submit POST itself is unknown but should remain user-clicked anyway. Total saving: would let AmazonG **prefetch + display** pay-from accounts and projected payment dates inline in the renderer instead of opening a Chrome window — a structural win, not just a perf win.
2. **In-process payments source endpoint identified.** `paymentDetail` in the overview already encodes scheduled/in-process payment status (`PAYMENTSCHEDULED`, `PAYMENTTODAY` etc.). The full `/billpay/card/payment/list` body (2423 bytes when populated) is the authoritative source. **Both paths replace today's HTML scrape of `tbody.activityRow`** — this is a 1-2s win per fetch and removes a brittle DOM dependency.
3. **`creditCardLockStatus` and `autoPayEnrolled` are already in the overview** we just fetched. Surfacing them is a renderer-only feature, no new XHR.
4. **Redemption submit POST remains uncaptured.** All capture work to date has been zero-points sessions. The `/rest/cash-back/redemption-info` form-load is direct-fetchable (already proven). Continue → Submit → Success XHRs will only appear during a real redemption — gated on the `AUTOG_CHASE_XHR_CAPTURE=1` capture path during a live redemption (pass-4 recommendation, still open).
5. **Top-leverage adjacencies in priority order:** in-process payments via `/billpay/card/payment/list` (replaces DOM scrape, ships immediately), pay-flow data prefetch (structural UX shift), session-alive ping via `/svc/wl/auth/l4/v1/user/router/list` (smaller than menu/list), surfacing `lockStatus`+`autoPayEnrolled` from existing overview, redemption history via `/rest/rewards-activity/all-activity`.

## Per-flow feasibility table

| Flow | Today | Endpoints | Direct-fetch? | Estimated win | Risk |
|---|---|---|---|---|---|
| **Snapshot fetch (Stage C)** | per-card nav + DOM scrape | `/dashboard/module/list?context=WEB_CBO_OVERVIEW_DASHBOARD` + `/rewards/v2/summary/list` per card | YES (already designed in pass-7 round-4) | 30-50× speedup multi-card | Low |
| **In-process payments** | nav `/payBillsArea/paymentsActivity` + DOM scrape `tbody.activityRow` | `/svc/rr/payments/secure/v1/billpay/card/payment/list` (POST, 2423B) AND already-typed `paymentDetail` in overview | YES | -1 nav, -1.5-3s per fetch, removes DOM dependency | Low |
| **Pay-bill data prefetch** | open visible Chrome window, user fills form | 4 form-load XHRs, see below | YES (data load) | Renderer-side payment summary; no Chrome window for "what payment is queued?" | Medium (UX redesign) |
| **Pay-bill SUBMIT** | user clicks in Chrome | unknown POST endpoint | NO — must stay click-through for safety + Chase fraud signals | n/a | Money-moving |
| **Redeem form-load** | nav `/cash-back?AI=...`, DOM scrape `input.mds-text-input__input--hero` | `GET /rest/cash-back/redemption-info` (loyalty side, 416B body captured) | YES — proven in pass-7 round-4 | -3-5s vs `/home` then `/cash-back` nav | Low |
| **Redeem Continue/Submit** | click Continue → `/cash-back/confirm`, click Submit → `/cash-back/success` | UNKNOWN | UNKNOWN — needs live capture | unknown | **Money-moving + uncaptured = leave click-through** |
| **Statement download / transactions** | not implemented | `/etu-transactions/v4/accounts/transactions` + `/digital-card-statements/v1/statement-flyouts` (both captured) | YES | n/a today, future feature | Low |
| **Auto-pay enrollment status** | not surfaced | `autoPayEnrolled` field already in overview | YES — already in our cached response, zero new XHR | renderer-only | Zero |
| **Auto-pay TOGGLE** | not implemented | unknown (probably `/billpay/.../autopayment/...` POST) | possible but money-adjacent | n/a today | Medium-high — gated |
| **Card lock/unlock status** | not surfaced | `creditCardLockStatus: "UNLOCKED"` already in overview | YES — zero new XHR | renderer-only | Zero |
| **Card lock/unlock TOGGLE** | not implemented | endpoint not yet captured | unknown | n/a today | High — security action |
| **Keepalive ping** | `/svc/rr/.../menu/list` (~136B response) | already direct-fetch | already done | n/a | n/a |
| **Lighter session-alive probe** | n/a | `/svc/wl/auth/l4/v1/user/router/list` (282B, but POST returns reauth state directly) | YES | useful as "is this session still warm?" pre-flight before heavier overview fetch | Low |
| **Profile metadata (loyalty)** | nav-loaded only | `/rest/common/customer-profile`, `/rest/common/messages/en` | YES if needed | none — purely decorative for Chase chrome | Skip |
| **Redemption history (chase-side)** | local-only `chase-redeem-history.json` | `/rest/rewards-activity/all-activity?cycle=0` (1511B captured, body unknown) | YES likely | source-of-truth dual-check | Low |
| **Marketing/offers** | already blocklist-targeted | `/svc/wr/.../offers/*` etc. | n/a | already blocked | n/a |

## Top-5 highest-leverage opportunities

### 1. Replace in-process payments DOM scrape with `/billpay/card/payment/list` direct-fetch — SHIP NEXT

Today (chaseDriver.ts:1525-1545):
- Extra `goto` to `secure.chase.com/web/auth/dashboard#/dashboard/payBillsArea/paymentsActivity/selectPayee;payeeId=-{cardAccountId}` (1.5-3s)
- `waitFor` on `tbody.activityRow` (up to 30s on stalls)
- `innerHTML` scrape, regex-parse via `parseInProcessPaymentsFromHtml`

Direct-fetch alternative:
```
POST /svc/rr/payments/secure/v1/billpay/card/payment/list
content-type: application/x-www-form-urlencoded; charset=UTF-8
x-jpmc-csrf-token: NONE
x-jpmc-channel: id=C30
body: (request body unknown — need capture; 2423-byte JSON response confirmed)
```

Captured response is 2423B JSON, served on the activity page. Note: request **body** for this endpoint was NOT captured in any of the existing JSONL files (the full-capture format only stores URL + method + headers, never `postData`; the older XHR captures stored `postData: null` for this endpoint). This means a 5-min capture sprint is needed before shipping.

**Belt-and-suspenders fallback (already free):** the overview response already includes `paymentDetail` per card with `paymentMessageStatusCode` ∈ {`PAYMENTTODAY`, `PAYMENTSCHEDULED`, `NOPAYMENTDUE`, ...} + `scheduledPaymentDate` + `paymentAmount`. For most users this is sufficient — the user sees "Payment of $13,278.77 scheduled for 5/7" in the renderer without any extra fetch. The full `/billpay/card/payment/list` only matters if the user has multiple in-flight payments per card.

**Estimated win:** -1 nav (~1.5-3s), -1 DOM-wait timeout, removes the only remaining HTML-scrape from the snapshot path. Net: snapshot-fetch becomes 100% JSON-driven.

**Risk:** Low. If the request-body capture turns out to need profile-id/account-id query params, the failure mode is "fall back to Stage B activity-page scrape" — which is already the current path.

### 2. Pay-bill flow → renderer-side data + minimal Chrome handoff

Today: `openChasePayPage` opens a visible Chromium window pointed at the flyout URL (chaseDriver.ts:1934-1998). User picks pay-from account, amount, date, clicks Submit. Window has a watcher that auto-closes on success-text detection.

Captured pay-flyout XHRs (all POSTs returning JSON):
| URL | Resp size | Purpose (inferred) |
|---|---|---|
| `/svc/rr/payments/secure/v1/billpay/card/payment/list` | 2423B | scheduled+pending payments for this card |
| `/svc/rr/payments/secure/billpay/card/v2/autopayment/status/list` | 86B | autopay-on/off + when next charge |
| `/svc/rr/payments/secure/v1/billpay/merchantmultipayment/payee/list` | 1450B | list of pay-from accounts (the "from" dropdown) |
| `/svc/rr/payments/secure/v2/billpay/multi/payment/add/options` | 105B | available payment dates / amount-types |

These 4 endpoints together = "everything the Pay flyout needs to render the form except the Submit". A Stage-C-style hybrid would:

1. Spawn the Chase context (already paid for if we're keeping a session warm anyway).
2. Direct-fetch all 4 endpoints in parallel via `page.evaluate(fetch())`.
3. Render a native AmazonG modal with: pay-from dropdown, amount field, date picker, autopay status, scheduled-payment summary.
4. **Only on Submit**, hand off to a click-through Chrome window that's already pre-filled. (Or: directly POST the submit endpoint if we capture it, but money-moving + Chase fraud signals = leave the click in the user's hands for at least the v1.)

**Win:** removes the user's mental cost of "what window am I in / what is loaded", and would also unlock a "schedule this payment for next month" feature where AmazonG auto-fires a future payment without opening a window each time.

**Risk:** Medium. Submit-side of pay flow is where Chase fraud rules are most aggressive — keep it click-through unless we have a really compelling reason. The form-load is fine.

**Capture gap:** request bodies for all 4 endpoints unknown. Same 5-min capture sprint as opportunity #1.

### 3. Surface `creditCardLockStatus` + `autoPayEnrolled` on the Bank tab

**Zero new fetches.** Both fields are in the overview cache we already grab in Stage C:

```
.cache[].response.cardAccountOverviews[].cardAccounts[].cardAccountDetail.creditCardLockStatus  // "UNLOCKED" | "LOCKED"
.cache[].response.cardAccountOverviews[].cardAccounts[].cardAccountDetail.autoPayEnrolled       // boolean
```

Renderer-side change only — adds a lock icon + "AutoPay: ON" badge to the Bank card row. Useful for users who want to confirm at a glance their card isn't locked or autopay is configured before a high-value Buy Now run.

**Win:** trust signal on the dashboard. No backend cost.

**Risk:** Zero — just JSON we already fetch.

### 4. Lighter session-alive probe via `/svc/wl/auth/l4/v1/user/router/list`

Today's keepalive uses `/svc/rr/accounts/secure/v1/menu/list` (136-222B response, `chaseDriver.ts:1635-1694`). The `/svc/wl/auth/l4/v1/user/router/list` endpoint returns a deterministic 282B JSON with `statusCode`, `redirectUrl`, `pod`, `brandId`. Crucially, the `statusCode === "SUCCESS"` field directly answers "am I still authenticated?" — useful as a **pre-flight** before firing the heavier `/dashboard/module/list` for snapshot fetch.

Captured request shape:
```
POST /svc/wl/auth/l4/v1/user/router/list
content-type: application/x-www-form-urlencoded
x-jpmc-csrf-token: NONE
x-jpmc-channel: id=C30
postData: null  (probably empty)
```

Use case: when the user opens the Bank tab and the snapshot is stale, fire this lightweight probe first. If `statusCode === "SUCCESS"`, proceed with the parallel overview+rewards fetches. If not, jump straight to login UI. Today we'd have to fire the full `/dashboard/module/list` to discover an expired session, which costs +50KB and an extra round-trip.

**Win:** ~50ms saved on cold-tab + faster expired-session detection.

**Risk:** Low. We already use the same endpoint family for keepalive — no new attack surface.

### 5. Redemption history dual-check via `/rest/rewards-activity/all-activity?cycle=0`

Today: `chase-redeem-history.json` records ONLY successful AmazonG-driven redemptions (chaseRedeemHistory.ts). If the user redeems via the Chase app (or a previous AmazonG run failed mid-flow), AmazonG has no record.

Direct-fetch:
```
GET /rest/rewards-activity/all-activity?cycle=0   (chaseloyalty.chase.com origin, 1511B body, body shape uncaptured)
```

Use case: dual-source the redemption-history view. Show a tab "Chase Activity" alongside today's "AmazonG Redemptions". Surfaces drift between the two — useful for reconciling failed/partial redemptions.

**Win:** new feature, source-of-truth alignment.

**Risk:** Low. Read-only on the chaseloyalty origin (already authenticated via the loyalty SSO bounce we do anyway during redeem).

**Capture gap:** the body shape is uncaptured. Probably contains `.activities[]` with `points`, `description`, `date`, `category` (cash-back redemption vs. earned points). Needs a 1-min capture pass to confirm.

## Endpoints catalogued but currently unused (potential future features)

These are all live and authenticated on the Chase side; AmazonG doesn't read them today:

### `/svc/rl/accounts/l4/v1/app/data/list` — site capabilities + feature flags

Returns 3742B JSON enumerating which Chase features are enabled for this customer (`siteFeatures.{billPay, autoSaveXfer, achCollections, ultimateRewards, balanceTransfer, ...}`). Useful for: hiding/showing UI elements in AmazonG's Bank tab based on per-customer Chase capabilities (e.g. don't show "Pay" button if `siteFeatures.billPay === false`).

Body sample (truncated):
```json
{"code":"SUCCESS","cache":[{"url":"/svc/rl/accounts/public/v1/site/availability/list","usage":"SESSION","response":{"siteFeatures":{"atmCardActivation":true,"billPay":true,"ultimateRewards":true,"alerts":true,"chaseAppIOSFingerprint":true,...}}}]}
```

### `/svc/rr/.../digital-card-statements/v1/statement-flyouts` — statement metadata

Returns 764B JSON per card with `statementSpendAmount`, `statementCreditAmount`, `paymentDueDate`, `statementStartDate`, `statementEndDate`. Useful for: showing "this cycle: $X spent / $Y credits / due Z" on the Bank card. NOT covered by the overview (overview has the `lastStmtBalance` as a single number; this has full breakdown).

Body shape:
```json
{"statementStartDate":null,"statementEndDate":null,"previousStatementBalanceAmount":0,"totalCyclePaymentAmount":28536.03,"statementSpendAmount":31424.26,"balanceAmount":1002.77,"statementCreditAmount":1885.46,...}
```

### `/svc/rr/.../etu-transactions/v4/accounts/transactions` — full transaction history

Captured a 6523B body with `activities[]` of pending+posted transactions, each with merchant name, amount, date, category, last 4 of card. The user's snapshot included 9 pending authorizations + 36 posted. Useful for: a "Recent activity" tab in AmazonG showing Chase-side transactions matched against AmazonG order history (auto-reconciliation).

Direct-fetch shape (URL has query params):
```
GET /svc/rr/accounts/secure/gateway/credit-card/transactions/inquiry-maintenance/etu-transactions/v4/accounts/transactions?digital-account-identifier={cardAccountId}&provide-available-statement-indicator=true&record-count=50&sort-order-code=D&sort-key-code=T
```

The endpoint accepts **GET**, not POST — different from most `/svc/rr/` endpoints. Useful for direct-fetch experiments.

### `/svc/rr/.../digital-channel-message-center-service/v1/messages` — secure messages

Returns 15B (empty inbox) but the URL suggests a Chase Message Center inbox. Very low value for AmazonG.

### `/svc/rl/accounts/secure/v1/dashboard/module/list?context=WEB_CREDIT_CARD_DASHBOARD` (single-card variant)

Already mentioned in pass-7 round-4 finding. Useful only if the overview response (which already returns all cards) doesn't include the card we want, or if per-card-only fields like `lockStatusUpdatedDate` are needed. **NOT CALLABLE WITHOUT THE WRAPPER:** the underlying `/svc/rr/accounts/secure/v2/account/detail/card/list` URL would normally be called directly, but in capture every call routed through the `dashboard/module/list` wrapper. We have no evidence the inner URL is reachable directly. Wrapper appears mandatory.

## What needs additional capture to nail down

| Question | Endpoint | What to capture | How to trigger |
|---|---|---|---|
| Pay-flow form-load request bodies | 4 `/billpay/...` POSTs | request `postData` for each | open Pay flyout in AmazonG |
| In-process payments query shape | `/billpay/card/payment/list` | request body (probably needs `payeeId` + `cardAccountId`) | snapshot fetch on a card with scheduled payment |
| Redemption Continue/Submit | unknown | URL, method, body, response (3 endpoints fired during the redeem flow) | run redeem on a card with ≥1 point — needs `AUTOG_CHASE_XHR_CAPTURE=1` env at AmazonG launch |
| Card lock/unlock toggle endpoint | unknown | URL, method, body | toggle lock from a Chase web session on any card |
| Auto-pay enroll/disenroll endpoint | unknown | URL, method, body | toggle auto-pay from a Chase web session |
| `/rest/rewards-activity/all-activity` body shape | confirmed URL, GET | response body | already-captured but body wasn't recorded — capture during a redeem flow |
| `app/data/list` per-customer caching | confirmed URL, body | check if response varies per profile or is shared | already captured |

**The critical gap is still redemption submit.** Pass-4's recommendation to ship `AUTOG_CHASE_XHR_CAPTURE=1` flag and ask the user to run one redemption with capture on remains the single highest-value capture target. Everything else is nice-to-have.

## Risk classification

**Safe to direct-fetch (read-only data loads):**
- `/dashboard/module/list?context=WEB_CBO_OVERVIEW_DASHBOARD` (overview)
- `/rewards/v2/summary/list` (points)
- `/rest/cash-back/redemption-info` (form data)
- `/billpay/card/payment/list` (scheduled payments — read-only)
- `/billpay/merchantmultipayment/payee/list` (pay-from accounts — read-only)
- `/billpay/card/v2/autopayment/status/list` (autopay state — read-only)
- `/multi/payment/add/options` (form options — read-only)
- `/etu-transactions/v4/accounts/transactions` (transaction history — read-only)
- `/digital-card-statements/v1/statement-flyouts` (statement metadata — read-only)
- `/svc/wl/auth/l4/v1/user/router/list` (session-alive probe — read-only)
- `/rest/rewards-activity/all-activity?cycle=0` (rewards log — read-only)

**Money-moving — leave click-through:**
- Redemption Continue + Submit POSTs (whatever they end up being)
- Pay flow Submit POST
- Auto-pay enrollment toggle
- Card lock/unlock toggle (security action)
- Balance transfer / cash advance / any `add/payment` POST that creates a money movement

**General principle:** any POST whose URL includes `add`, `submit`, `enroll`, `lock`, or `update` should remain user-initiated through a visible window with the keepalive + visibility-checked Akamai cookie state. Direct-fetch makes sense for `list`, `get`, `info`, `summary`, `status`, `overviews`, `details`.

## Implementation suggestions (priority-ranked, no code changes per charter)

1. **Now (no new capture needed):** wire `lockStatus` + `autoPayEnrolled` into `ChaseAccountSnapshot` + Bank tab renderer. Pure data plumbing.
2. **Now (no new capture needed):** in Stage C, derive in-process payments from `paymentDetail.paymentMessageStatusCode` + `paymentAmount` + `scheduledPaymentDate` instead of HTML-scraping the activity page. Drops the `payBillsArea/paymentsActivity` nav from the snapshot path entirely. -1.5 to 3s per fetch + zero DOM-fragility.
3. **Capture-and-then-ship (5 min capture):** request bodies for the 4 pay-flow endpoints. Once we have them, can pre-fetch + render a native pay-summary modal (still hand off Submit to a Chrome window).
4. **Capture-and-then-ship (1 min capture):** body shape of `/rest/rewards-activity/all-activity`. Powers a "Chase activity" tab next to "AmazonG redemptions".
5. **Wait for live capture:** redemption submit POST. This is the only capture-blocker for a fully-headless redeem flow, and it requires the user to actually have points + run a redemption with `AUTOG_CHASE_XHR_CAPTURE=1`. Defer until natural opportunity arises.
6. **Maybe-later:** session-alive probe via `user/router/list`. Marginal win (~50ms) and adds minor complexity. Only worthwhile if we observe expired-session-on-snapshot is a measurable user pain point.

## What stays the same

Per charter: this is research only. No code changes. The `chase-perf-tier-a` branch's existing hybrid + Stage C planning continues unchanged. These findings extend Stage C to 4 additional flows but are independent ship items.

## Caveats and unknowns

1. **All capture sessions had 0 points on the Amazon card.** No live redemption capture exists. The `redemption-info` body we have is the form-load shape; the Continue/Submit request/response triplet is uncaptured.
2. **Capture format limitation:** the full-capture JSONL stores headers + URL + content metadata but NOT request bodies. The older xhr-capture JSONL stores `postData` but it was almost always `null`. **Most form-encoded POSTs in the captures have unknown bodies.** AmazonG's `runFetchStageC` design relied on the SPA's empirical request shape (we know `accountId={id}` is right for rewards summary because we tested it via Playwright MCP) — for the new endpoints, similar Playwright MCP probing will be needed.
3. **The user's profile is a JPMC business account** (`brandId: "BUSINESS"` in `user/router/list` body). Some endpoint shapes (especially `customer-offers`) may differ for personal-account users. Worth a sanity-check against a personal Chase profile if any of these ship.
4. **`paymentDetail` in the overview only encodes ONE in-process payment per card.** Users with 2+ pending payments per card (rare) need the full `/billpay/card/payment/list` to enumerate. The overview alone is sufficient for the typical case but should fall through to the activity-page scrape (Stage B fallback) when overview shows a payment but the user reports more.
5. **Anti-bot posture is identical to Stage C** — all these endpoints are in-page `fetch()` from the same authenticated SPA context. Same TLS, same `_abck`/`bm_*` cookies, same Chrome fingerprint envelope. Adding more direct-fetches doesn't change the bot-shape risk surface.
6. **`/rest/rewards-activity/all-activity?cycle=0` requires loyalty origin.** Today we only navigate to chaseloyalty.chase.com during a redemption (and pass-7 round-4 confirmed we can skip the `/home` nav). Adding a "rewards history" feature would need a chaseloyalty-origin nav at minimum once per session — but the SPA shell can be cached after first load.

## Cross-references

- Stage C design: `docs/research/chase-mcp-direct-fetch-2026-05-08.md`
- Blocklist scope: `docs/research/chase-blocklist-audit-2026-05-08.md` (loyalty REST namespace section confirms the `/rest/cash-back/*` and `/rest/rewards-activity/*` paths must NOT be blocked)
- Original Stage B XHR research: `docs/research/chase-xhr-capture-findings-2026-05-07.md`
- Session-pass deep dive: `docs/research/chase-session-pass6-deep-2026-05-07.md`
