# Chase blocklist audit — 2026-05-08

**Source:** 3 full-capture JSONLs from `AUTOG_CHASE_FULL_CAPTURE=1` covering snapshot fetch + Pay window + loyalty/cash-back flow on Cuong account 865860218.

## Existing blocklist verification ✓

Blocklist is **working correctly.** Confirmed via Playwright `requestfailed` events with `failure: "inspector"` (CDP-blocked):
- `c.go-mpulse.net/api/config.json` ✓ blocked
- `analytics.chase.com/events/analytics/public/v*/events/*` ✓ blocked (54 attempted, all blocked)
- `reco.chase.com/*` ✓ blocked

## NEW block candidates — Tier 1 (ship, zero risk)

These are pure analytics/RUM/decoration that no AmazonG code path reads. Ranked by impact:

| Pattern | What it is | Per-fetch impact |
|---|---|---|
| `*://s2.go-mpulse.net/*` | Akamai mPulse boomerang.js library (companion to `c.go-mpulse.net` already blocked, but a different host that bypasses the existing rule) | **~120KB** (60KB × 2 fires) |
| `*://fonts.gstatic.com/*` | Google Fonts woff2 (Open Sans). Decorative typography only. Chase has system-font fallbacks. | **~85KB** (~14KB × 6 fires) |
| `*://chaseoffers.chase.com/*` | Chase Offers ad images (4 fires per dashboard load) | ~10KB |
| `*://www.chase.com/apps/chase/clientlibs/foundation/tagmanagerextensions.js` | Adobe Tag Manager | ~2KB |
| `*://www.chase.com/apps/chase/clientlibs/foundation/scripts/Reporting.js` | Analytics reporting library | ~few KB |
| `*://www.chase.com/etc/chase/appsconfig/clientconfig.ccpa*` | CCPA reporting config | ~70 bytes |
| `*://www.chase.com/etc/designs/chase-ux/clientlibs/chase-ux/js/survey/*` | Feedback survey widget | ~4KB |
| `*://www.chase.com/apps/services/tagmanager/*` | Adobe tag manager beacons (42-byte responses) | tiny |
| `*://secure.chase.com/events/analytics/public/v1/cc.gif` | 1x1 analytics tracking pixel | 43 bytes |
| `*://chaseloyalty.chase.com/web-analytics/*` | Loyalty-side analytics wrapper | ~1KB |

**Total Tier 1 saving per fetch:** ~225KB bandwidth + 18-25 fewer XHRs in the hydration contention window. Estimated ~100-300ms wall-clock saving (these compete for HTTP/2 stream slots during the +0-3s hydration burst).

## NEW block candidates — Tier 2 (decorative imagery, low risk)

Visual chrome that AmazonG never displays:

| Pattern | What it is |
|---|---|
| `*://*.chasecdn.com/content/services/rendition/image.*/unified-assets/digital-cards/*` | Credit card art renderings |
| `*://sites.chase.com/content/dam/*` | Marketing illustrations (hot-air-balloon SVGs etc.) |
| `*://sites.chase.com/content/services/rendition/*` | Marketing image renditions |
| `*://*.chasecdn.com/content/dam/unified-assets/logo/*` | Chase logos |
| `*://www.chase.com/content/dam/consent-banner/*` | Cookie consent banner config |

**Total Tier 2 saving per fetch:** ~10-20KB. Cosmetic fetches that don't render in AmazonG's headless-style usage.

## NEW block candidates — Tier 3 (marketing service endpoints, MEDIUM risk)

These are SPA-internal `/svc/` calls AmazonG never reads, BUT blocking them might cause the SPA to throw if its widgets aren't graceful about empty responses. **Verify in a sacrificial profile before shipping.**

| Pattern | Fires | Risk |
|---|---|---|
| `*://secure.chase.com/svc/wr/accounts/l4/dso/v2/offers/list` | 3× per dashboard | Med — offers widget |
| `*://secure.chase.com/svc/wr/accounts/secure/gateway/mkt-aes/svc/ccb/marketing/*` | 3× per dashboard | Med — marketing offers |
| `*://secure.chase.com/svc/wr/profile/secure/gateway/ccb/marketing/*` | 3× per dashboard | Med — customer-targeted-offers |
| `*://secure.chase.com/svc/wr/accounts/l4/v1/deck/messages/list` | 8× per dashboard | Med-High — UI banners |
| `*://secure.chase.com/svc/rr/accounts/secure/gateway/credit-card/servicing/inquiry-maintenance/digital-card-statements/*` | 2× per dashboard | Low — statement metadata, not surfaced |
| `*://chaseloyalty.chase.com/rest/earn-offer/*` | 1× per loyalty home | Med — page-offers widget |
| `*://chaseloyalty.chase.com/rest/mrm` | 1× per loyalty home | Unknown |

**Tier 3 saving:** ~5-15KB but ~20 fewer XHRs in the contention window. Higher risk of breaking SPA chrome.

## DEFINITELY KEEP (load-bearing — confirmed)

These all power AmazonG functionality directly OR are required for the SPA shell to render. **Do not block.**

**Stage B / Keepalive / data extraction:**
- `secure.chase.com/svc/rl/accounts/secure/v1/dashboard/module/list` — Stage B balance/available/pending
- `secure.chase.com/svc/rr/accounts/secure/card/rewards/v2/summary/list` — Stage B points
- `secure.chase.com/svc/rr/accounts/secure/v1/menu/list` — keepalive ping
- `secure.chase.com/svc/rr/accounts/secure/gateway/credit-card/transactions/.../etu-transactions` — likely in-process payments source

**Auth / Akamai sensor:**
- `secure.chase.com/svc/wl/auth/*` — login flow
- `secure.chase.com/auth/fcc/*` — Akamai sensor lifeline (do NOT touch even though `channela.js` is decorative-looking)

**SPA shell:**
- `asset.chase.com/web/library/*` — Chase's main JS bundles (~250 small chunks per page)
- `static.chase.com/content/pq/*` — CMS page fragments (primary-navigation, brand-bar, etc.)
- `static.chasecdn.com/splitio/*` — feature-flag SDK

**Loyalty SPA shell (KEEP — discovered the loyalty REST namespace this run):**
- `chaseloyalty.chase.com/public/the-app/*` — loyalty SPA bundle (main, polyfills, styles)
- `chaseloyalty.chase.com/public/js/*` — jQuery + dependencies
- `chaseloyalty.chase.com/rest/common/*` — loyalty config (env-config, customer-profile, brand-vars, messages, maintenance-list)
- `chaseloyalty.chase.com/rest/chrome/*` — loyalty chrome
- `chaseloyalty.chase.com/rest/cash-back/*` — **REDEMPTION ENDPOINTS** (we just discovered this — blocking would break redeem)
- `chaseloyalty.chase.com/rest/rewards-activity/*` — rewards activity log

## Big-picture findings beyond blocklist

### 🎯 Discovered: chaseloyalty REST namespace structure
First time we have visibility. Endpoint families on `chaseloyalty.chase.com`:
- `/rest/common/*` — config & i18n
- `/rest/chrome/*` — UI chrome
- `/rest/cash-back/*` — redemption form
  - `/rest/cash-back/redemption-info` ← **THE ONE that powers the form** (we should look at the response body)
- `/rest/earn-offer/page-offers/HOME` — promotional offers on home page
- `/rest/rewards-activity/all-activity?cycle=0` — rewards transaction log
- `/rest/mrm` — unknown, returns 559 bytes

Pass-2 research was uncertain about the loyalty namespace — now we have it confirmed. This unblocks future Stage B-style work for the redeem flow.

### 🎯 The `s2.go-mpulse.net` bypass
Existing blocklist has `c.go-mpulse.net` (where mPulse fetches its config from) but NOT `s2.go-mpulse.net` (which serves the actual boomerang.js library, ~60KB). Result: mPulse can't config-init but the library still loads. **This single block doubles the mPulse savings.**

### 🎯 No `requestfailed` for `reco.chase.com` in this capture
The reco hosts didn't fire at all this run (they fire post-data, after both Stage B XHRs land — likely the page closed before they were attempted). Not a blocklist issue, just a timing artifact.

### 🎯 The keepalive ping is wired in
File 2 (Pay window) only ran for ~14 seconds before the user moved on. The 4-6 min keepalive interval never fired. To verify keepalive works, leave Pay or Open Rewards open for 5+ minutes next time.

## Recommended ship plan

### v0.13.28 (immediate)

Add to `BLOCKED_URL_PATTERNS_CHASE` in `chaseDriver.ts:148-152`:

```ts
const BLOCKED_URL_PATTERNS_CHASE = [
  // Already shipped
  '*://c.go-mpulse.net/*',
  '*://analytics.chase.com/*',
  '*://reco.chase.com/*',
  // Tier 1 additions (zero risk, ship now):
  '*://s2.go-mpulse.net/*',         // boomerang.js library (companion to c.go-mpulse already blocked)
  '*://fonts.gstatic.com/*',         // Google Fonts (decorative, system fallbacks work)
  '*://chaseoffers.chase.com/*',     // Chase Offers ad images
  '*://www.chase.com/apps/chase/clientlibs/foundation/tagmanagerextensions.js',
  '*://www.chase.com/apps/chase/clientlibs/foundation/scripts/Reporting.js',
  '*://www.chase.com/etc/chase/appsconfig/clientconfig.ccpa*',
  '*://www.chase.com/etc/designs/chase-ux/clientlibs/chase-ux/js/survey/*',
  '*://www.chase.com/apps/services/tagmanager/*',
  '*://secure.chase.com/events/analytics/public/v1/cc.gif',
  '*://chaseloyalty.chase.com/web-analytics/*',
  // Tier 2 (decorative images, AmazonG never displays):
  '*://chaseoffers.chase.com/offerimages/*',  // included in chaseoffers above but explicit
  '*://*.chasecdn.com/content/services/rendition/image.*/unified-assets/digital-cards/*',
  '*://sites.chase.com/content/dam/*',
  '*://sites.chase.com/content/services/rendition/*',
  '*://*.chasecdn.com/content/dam/unified-assets/logo/*',
  '*://www.chase.com/content/dam/consent-banner/*',
];
```

**Estimated saving:** ~250KB bandwidth + 20+ XHRs eliminated per fetch + ~100-300ms wall-clock.

### v0.13.29+ (after sacrificial-profile A/B)

Tier 3 marketing/offers endpoints. Need verification SPA doesn't crash without these widgets. Test in a sacrificial profile by adding the patterns one at a time and refreshing 3-5 times. If snapshot still completes correctly, ship.

## Caveats

1. **Total bandwidth from full capture is ~13MB**, but most of it is `static.chasecdn.com/splitio/*` splitChanges responses (5.5MB × 2 = 11MB). We've identified splitio as POSSIBLY blockable but it's high-risk (Split.io throws when no data). Still in the "needs sacrificial test" pile.

2. **`asset.chase.com` is 1116 requests** but mostly chunks of the SPA bundle. Don't try to filter inside this host — pattern matching is too risky.

3. **The user's capture ran briefly per flow** (~14s between flows). For longer windows we'd see more late-firing telemetry. The blocklist as-is covers the captured surface; if new patterns appear in longer captures, add them then.
