# Chase /billpay/card/payment/list — empirical capture — 2026-05-08

**Method:** Playwright MCP, live authenticated session against Cuong's Amazon card (account 865860218). The endpoint was identified in pass-7 round-5 audit but the request body shape and complete response schema were never captured. This run nails both down.

## Endpoint signature

```
POST /svc/rr/payments/secure/v1/billpay/card/payment/list
content-type: application/x-www-form-urlencoded; charset=UTF-8
x-jpmc-csrf-token: NONE
x-jpmc-channel: id=C30
x-jpmc-client-request-id: <uuid>

body: autoPayPendingEnabled=true&payeeId=-{cardAccountId}
```

**Crucial:** the `payeeId` body param has a leading **minus sign** (`-{cardAccountId}`). Same convention as the activity-page URL fragment Chase's SPA uses (`payeeId=-865860218`). Without the minus, the call returns 400.

## Where it fires (and where it doesn't)

- **Per-card summary nav**: NOT fired. The summary page never loads this endpoint.
- **Per-card pay-flyout** (`flyout=payCard,...`): NOT fired. Only the merchantmultipayment + multi/payment/add/options endpoints fire here.
- **Activity-page nav** (`#/dashboard/payBillsArea/paymentsActivity/selectPayee;payeeId=-{id};payeeType=CREDIT_CARD`): **fires here**. This is what AmazonG today navigates to when the Stage C `paymentDetail` fallback path engages.
- **Direct fetch from any authed page**: works. Verified from the `/dashboard/overview` page (where Stage C fires its other parallel fetches) — 200 OK in 726ms.

## Response shape (top-level keys)

```
code: "SUCCESS"
paymentActivities: Array<...>       ← 64 entries on Cuong's Amazon card
autoPayment: boolean
postChargedOff: boolean
defaultPayeeId: number              ← matches the request payeeId
cardPayees: ...
additionalPaymentActivityUnavailable: boolean
```

## paymentActivities[] shape

Each entry:
```
paymentId: number               (signed; negative on this dataset, e.g. -10061)
amount: number                  e.g. 13278.77
cancelAllowed: boolean
updateAllowed: boolean
inquiryAllowed: boolean
dueDate: "YYYYMMDD" string      e.g. "20260507"
activityStatus: enum            "IN_PROCESS" | "COMPLETED" | "RETURNED" | "CANCELED"
fundingAccountName: string      e.g. "Joint Sofi (...4075)"
fundingAccountNickname: string  e.g. "Joint Sofi"
fundingAccountMask: "...XXXX"   e.g. "...4075"
confirmationNumber: string      e.g. "9351180423"
description: string             e.g. "Website"
autoPayPayment: boolean         true on auto-pay enrollments
```

For Cuong's Amazon card on 2026-05-08:
- 64 total activities
- 1 IN_PROCESS ($13,278.77, due 2026-05-07, from Joint Sofi)
- N COMPLETED, plus a few RETURNED + CANCELED in older history

## Match against today's `paymentDetail` (from overview JSON)

The overview's `cardAccountDetail.paymentDetail` is a **one-slot** summary of the most-imminent IN_PROCESS row from this endpoint:

| paymentDetail | billpay row |
|---|---|
| `paymentMessageStatusCode: "PAYMENTSCHEDULED"` | `activityStatus: "IN_PROCESS"` |
| `scheduledPaymentDate: "20260507"` | `dueDate: "20260507"` |
| `paymentAmount: 13278.77` | `amount: 13278.77` |

Confirmed identical for the user's currently-scheduled payment. The billpay endpoint is the strict superset (multi-row).

## Implications

- **Replaces today's activity-page nav + DOM scrape** (the Stage C v1 fallback path). When billpay succeeds, no more `tbody.activityRow` reading.
- **Replaces the one-slot `paymentDetail` mapping** on the Stage C happy path. Multi-row coverage on all refreshes.
- **Activity-page DOM scrape stays as the ultimate Stage B fallback** for the rare case where Stage C entirely fails (overview endpoint failed → we don't even attempt billpay since the sentinel didn't fire).

## Anti-bot posture

Identical to Stage B's existing keepalive + Stage C overview/etu fetches: same Chromium TLS, same cookies, same `_abck` post-hydration state. The SPA itself fires this endpoint on activity-page nav; we just call it directly from inside an authed page.

## Caveat — date-range scope

The `record-count` parameter that `etu-transactions` requires is NOT a parameter on this endpoint — billpay returned 64 activities without any limit param. Suggests the response may include very old activity history. For our use case (filter to `IN_PROCESS` only) this is fine, but a user with thousands of historical payments would see proportionally larger responses. Consider polling `additionalPaymentActivityUnavailable` for forward-compat if Chase ever paginates this endpoint.
