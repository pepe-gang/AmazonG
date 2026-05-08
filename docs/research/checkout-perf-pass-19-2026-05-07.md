# Checkout perf research — pass 19 (post v0.13.27)

**Date:** 2026-05-07
**Goal:** find unexplored speed dimensions for AmazonG's Amazon-page interactions, especially /spc.

After 18 prior research passes + 4 release cycles (v0.13.24 → v0.13.27), the well-trodden ground is well-covered. This pass surveys angles we haven't touched.

## Where we are today

**Shipped optimizations on every Amazon nav:**

- 31 CDP blocklist patterns (telemetry hosts, ad systems, decorative widgets, post-/spc XHRs)
- 1 Chromium launch flag (WebAuthn passkeys disabled)
- WebAuthn JS API stub
- Anti-bot stubs (`navigator.webdriver = false`)

**Shipped /spc-specific optimizations:**

- Inline 3 cashback parsers into `page.evaluate` (drops ~1–1.3s of `page.content()` + JSDOM cost)
- 500ms wait removed in `pickBestCashbackDelivery` between iters
- 2× 1500ms blind waits removed in `cancelFillerOrder.ts` (event-driven selector wait)
- Recommendations Hub Frame (`hz/rhf*`) blocked — fires on order-details + cancel paths

**Shipped reliability work:**

- `auto-reconcile-pending-orphans` (v0.13.26) — drains stale local jobs without manual sync
- per-account `autoBuy` toggle (v0.13.27) — pause buys without losing tracking

## Unexplored dimensions

### 1. Chromium launch flags (BIGGEST untapped lever)

`src/browser/driver.ts:38-42` currently passes ONE flag:

```ts
'--disable-features=WebAuthenticationPasskeys,PasskeyAutofill,PasskeyFromAnotherDevice,WebAuthenticationConditionalUI'
```

Chromium accepts ~1,000 command-line flags that affect performance, networking, and feature toggles. Worth considering:

#### Tier A — clear wins (low risk)

| Flag | Why | Saving |
|---|---|---|
| `--disable-background-timer-throttling` | When AmazonG fans out 5 profiles in parallel, only one Chromium window has focus. The other 4 are "background" → Chrome throttles their `setTimeout` / `setInterval` to 1Hz to save battery. Our buy flow uses neither, but Amazon's JS does (eligibleshipoption polling, cashback-banner re-render timers, etc.). The throttle slows backgrounded buys by 5–15%. | ~5–15% / backgrounded buy |
| `--disable-backgrounding-occluded-windows` | Chrome v85+ stops painting occluded windows entirely (when partially or fully covered by another window). Amazon's checkout uses `requestAnimationFrame` for the cashback-radio-pick handler; if the window is occluded, those rAFs throttle. | ~50–100ms / occluded buy |
| `--disable-renderer-backgrounding` | Master switch for renderer-process backgrounding. Belt-and-suspenders with the two above. | (same window of effect) |
| `--no-pings` | Disables hyperlink-auditing pings (`<a ping="...">`). Amazon uses these on some product cards. ~1-3 fire per nav. | ~5–10ms × per nav |
| `--disable-domain-reliability` | Chrome's domain-reliability service phones home with DNS/network failure stats. Useless for our headless-ish use case; ~1-2 background HTTPS requests per session. | ~50ms / startup |
| `--disable-component-update` | Chrome auto-updates internal components (GPU drivers, WebKit fonts, etc.) on a background timer. We never need them updated. | ~500ms-2s / hour, off the buy path |
| `--password-store=basic` | macOS Chromium tries to use Keychain by default. AmazonG's persistent-context cookies don't go through Keychain; the call is a no-op but adds ~50ms to startup waiting on the unused query. | ~50ms / session start |
| `--disable-features=Translate,TranslateUI` | Disables Chrome's translate prompts. Amazon serves English; the detector still runs. | ~10-20ms / nav |
| `--disable-features=OptimizationGuideModelDownloading,OptimizationHintsFetching` | Chrome downloads ML models for proactive optimization hints. Useless for our flow. | ~background, but ~10-50MB disk |
| `--disable-default-apps` | Skips default apps installation prompts. | ~10ms / startup |
| `--disable-features=TrustTokens` | Trust Tokens API is what's been failing on Amazon (`ERR_TRUST_TOKEN_OPERATION_FAILED` in your logs). Disabling explicitly removes the failed-fetch noise. | ~0ms saving but cleaner logs |

**Aggregate Tier A:** ~50–200ms saved per buy on non-focused profiles + ~500ms-2s/hour off the buy path. Most useful when AmazonG is running fan-outs.

**Risk:** Very low. None of these touch security/CORS/cookie flags.

#### Tier B — explore later (medium risk)

| Flag | Why I'd hold off |
|---|---|
| `--disable-prerender2` | Chrome's speculative-prefetch on hover. Amazon's PDP has lots of hovers. Could change request shape. |
| `--use-mock-keychain` | More aggressive than `--password-store=basic`. May affect macOS persistent storage in ways we haven't tested. |
| `--disable-features=PaintHolding` | Disables paint-holding (which keeps old paint visible while new content loads). Disabling could make page transitions feel snappier OR cause flicker. |
| `--disable-features=PrivacySandboxAdsAPIs,FedCm` | Privacy Sandbox / FedCM. Disabling reduces some background calls but might trip Amazon's bot detector if the absence is fingerprinted. |

#### Tier C — DON'T touch

- `--no-sandbox` — security risk
- `--disable-web-security` — security + CORS risk
- `--disable-site-isolation-trials` — security risk
- Anything that changes `navigator.userAgent` shape — fingerprinted

### 2. Image-extension blocks — `.avif` is missing

Current ext blocklist (`driver.ts:144`):

```ts
'*.png*', '*.jpg*', '*.jpeg*', '*.webp*', '*.gif*', '*.bmp*', '*.ico*'
```

Amazon increasingly serves **`.avif`** for product photos and ads (newer compressed format). Chromium has supported it natively since v85; Amazon shipped it in 2024.

**Add:**

```ts
'*.avif*'
```

Modest saving (~20–80KB × ~100 image requests = ~2-8MB bandwidth per buy) but free.

`.heic` is rare on Amazon US (Apple format). Skip.
`.ts` HLS chunks — already debated; <50ms typical. Skip.

### 3. Wildcard amazon-adsystem

Currently blocks specific subdomains:

```ts
'*://aax.amazon-adsystem.com/*'
'*://s.amazon-adsystem.com/*'
```

Amazon ships ad-related calls from other subdomains too (`pagead-googleads-redirector.amazon-adsystem.com`, `cf.amazon-adsystem.com`, etc.). A wildcard catches all current + future:

```ts
'*://*.amazon-adsystem.com/*'
```

**Risk:** Very low. None of the `*.amazon-adsystem.com` subdomains feed buy-flow DOM (verified by domain purpose — all are ad/tracking).

### 4. Resource-priority hints

Chromium supports `Priority` request hints. Playwright doesn't expose them directly, but we could add `<link rel="preconnect" href="https://www.amazon.com">` via `page.addInitScript()` BEFORE navigating to /spc. That warms the TCP+TLS connection so the actual nav skips the handshake (~100-200ms on cold connections).

Mostly useful for first-of-day buy or after a long idle period. Subsequent buys on the same session reuse the same connection automatically.

**Risk:** Very low. **Saving:** ~100-200ms on first buy of a session.

### 5. Reduce `page.content()` calls in scrapeProduct

`src/actions/scrapeProduct.ts:21` does `await page.content()` + `parseProductHtml(html)` (uses JSDOM internally) + a separate `runtimeVisibilityChecks` page.evaluate.

This is the SAME pattern pass-17 found on /spc — `page.content()` costs ~80-150ms (CDP serialize a 1MB+ PDP), JSDOM costs another ~100ms.

**But:** there's a documented bug-of-record (`INC-2026-05-05`) where the static + runtime split was introduced as a safety measure (one mode catches what the other misses). Inlining everything into one in-page evaluate could regress that.

The lower-risk move: keep the static parser, but **skip the page.content() + JSDOM** when the runtime evaluate ALONE is sufficient. The runtime check at line 82 already reads live DOM. We could move the static parser's logic into a single in-page evaluate that returns the same `ProductInfo` shape.

**LOC:** ~150 (mirrors the JSDOM-side parser inline). **Risk:** Medium (touches the safety-rationale code). **Saving:** ~150-250ms / PDP nav.

I'd hold off until there's a real reason. The /spc and cancel-form work has captured most of the easy wins on this pattern.

### 6. Multi-profile shared PDP scrape (already in MASTER doc)

Each profile in a fan-out independently scrapes the PDP. For an N-profile fan-out, that's N PDP fetches. A short-lived (5-second TTL) cross-profile cache would let profile #2-N reuse profile #1's scrape result.

Already on the backlog as MASTER doc #12, ranked Med risk. Saves ~280ms × (N-1) per fan-out.

**Why not yet shipped:** the cache has subtle correctness concerns (per-profile address state, dynamic Prime eligibility based on account, qty cap differences). A naïve cache would risk shipping the wrong product info to a profile.

A safer variant: cache only the *static* PDP fields (title, ASIN, price text, dimensions) and re-do the *per-account* checks (Prime, in-stock, buy-blocker) per-profile. ~200ms saved with much lower correctness risk.

### 7. /spc HTML response size — can we shrink it server-side?

`/spc` returns ~400KB of HTML on every load. Most of it is:
- Inline `<script>` blocks (Chewbacca state hydration) — ~150KB
- Per-line-item DOM (cart contents) — ~50KB × items
- Inline CSS — ~40KB
- Various decorative widgets — ~30KB

Amazon doesn't expose a "minimal /spc" endpoint. We have no server-side levers. This dominates checkout time for the first load and there's nothing we can do directly.

**The lever we DO have:** keep the connection warm so subsequent buys on the same session don't pay the TLS+TCP handshake cost. Already happens automatically with persistent context.

## Suggested ship order

If anything in this doc gets shipped, in order of ROI:

| # | Change | Saving | Risk | LOC |
|---|---|---|---|---|
| 1 | Tier A Chromium launch flags (the 11 in the table above) | ~50-200ms / buy + cleaner background behavior | Very low | ~15 |
| 2 | `.avif` extension to image blocklist | ~2-8MB bandwidth / buy | Very low | 1 |
| 3 | `*://*.amazon-adsystem.com/*` wildcard | covers future subdomains | Very low | 1 (and remove the 2 specific patterns) |
| 4 | `page.addInitScript` preconnect hint to /spc origin | ~100-200ms on first-of-session buy | Very low | ~5 |
| 5 | Multi-profile shared PDP scrape (static-only cache) | ~200ms × (N-1) per fan-out | Medium | ~80 |
| 6 | scrapeProduct in-page parser inline | ~150-250ms / PDP nav | Medium | ~150 |

**Tier A flags + .avif + wildcard ad-system** is a single ~5-line PR with no behavior change risk. Could ship as v0.13.28 alongside any other small fix.

## What I deliberately didn't propose

- Anything that touches CORS / security flags
- Anything that bypasses Chromium sandboxing
- Direct POST shortcuts (B3 already killed in pass-8)
- Service-worker disabling (Amazon doesn't ship a SW for buy paths; nothing to gain)
- Cookie-jar pre-warming (persistent context already does this)
- Chrome's `--disk-cache-size` tuning (default is fine for our usage)

## What's left in the medium/high-risk pile from prior passes

(Same list as `improvements-ranked-2026-05-06.md`, no new findings.)

- Event-driven `waitForConfirmationOrPending` (sitting on `feature/event-driven-wait-confirmation` branch — ready to merge if desired)
- Event-driven `waitForCheckout` (~250-500ms / buy, more complex state machine)
- JSDOM → node-html-parser swap for HTTP-only paths (~500-800ms / filler buy)
- Idle-pool session lifecycle (~5-15s per consecutive same-profile buy)
- AccountLock conservative → aggressive

## Bottom line

Diminishing returns on /spc-specific work. The biggest remaining /spc savings (~250ms) require shipping the event-driven `waitForConfirmationOrPending` rewrite that's already on a branch.

The biggest unexplored area is **Chromium launch flags** — Tier A above gives modest per-buy wins (~50-200ms) and meaningful win on backgrounded fan-out profiles (5-15% throttle removal). One small commit covers it.

Beyond that, /spc is largely server-bound (Amazon's 400KB HTML response dominates), and we don't have levers there.
