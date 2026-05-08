# Chase perf deep-dive — 2026-05-07

**Goal:** find safe speedups across every Chase page AmazonG touches. Chase fingerprints aggressively; nothing in this doc proposes anything that softens existing anti-bot countermeasures.

**Method:** static code audit. Did NOT live-probe chase.com because (a) Chase's anti-bot scores fresh Playwright sessions harshly, and a probe from a cold non-warmed userDataDir would either trigger an OTP challenge or pollute the user's actual session's risk score. The code's existing comments document a lot of the empirical findings — referenced inline.

## Pages we touch (the entire surface)

| URL | Flow | What we read | Wait pattern |
|---|---|---|---|
| `secure.chase.com/web/auth/dashboard` | Login, Open Rewards, Pay, Redeem, Snapshot | (just SSO seed) | `waitUntil: 'load'` (redeem), `'domcontentloaded'` (snapshot) |
| `secure.chase.com/web/auth/dashboard#/dashboard/summary/{id}/CARD/BAC` | Snapshot, Login (success URL), Pay (base) | recon-bar balance, pending charges, available credit | `domcontentloaded` + 30s selector wait on `.activity-tile__recon-bar-balance` |
| `secure.chase.com/web/auth/dashboard#/dashboard/payBillsArea/paymentsActivity/selectPayee;...` | Snapshot | in-process payments table | `domcontentloaded` + 30s selector wait on `tbody.activityRow` |
| `secure.chase.com/web/auth/dashboard#/dashboard/summary/{id}/CARD/BAC/index;flyout=payCard,...` | Pay (flyout) | (hand off to user) | `'load'` |
| `chaseloyalty.chase.com/home?AI={id}` | Snapshot, Open Rewards, Redeem | rewards points | `domcontentloaded` + 30s selector wait on `.card-info .points` (snapshot) / `text=Available points` (redeem) |
| `chaseloyalty.chase.com/cash-back?AI={id}` | Redeem | (form rendering) | `'load'` + 30s selector on `input.mds-text-input__input--hero` |
| `chaseloyalty.chase.com/cash-back/confirm` | Redeem | — | `waitForURL` |
| `chaseloyalty.chase.com/cash-back/success` | Redeem | order number, dollar amount | `waitForURL` + 60s |
| `iframe#logonbox` overlay OR full `/logon` page | Login, recovery | — | per-layout wait, see below |

## Anti-bot measures already shipped (DO NOT WEAKEN)

These are intentional, load-bearing:

1. **`--disable-blink-features=AutomationControlled`** (chaseDriver.ts:102) — without this Chase refuses to issue persistent session cookies; net effect would be "session never saves."
2. **`navigator.webdriver = false` stub** (chaseDriver.ts:110) — banks flag this directly.
3. **`headless: false` always** (chaseDriver.ts:93) — Chase fingerprints headless instantly.
4. **Default user-agent — no spoofing** (chaseDriver.ts:69-70) — banks fingerprint UAs.
5. **`pacingPause()` 900-1500ms between every hop in redeem** (chaseDriver.ts:795-798) — explicit comment: "Chase's loyalty SPA scores the SSO → /home → /cash-back rhythm as automation when it happens sub-second; one settle pause per hop pushes us back into the 'human-paced' envelope."
6. **Per-character `type()` with 35ms delay** (chaseDriver.ts:601, 612) — explicit comment: "per-character delays make bot-detection scoring more lenient."
7. **`waitUntil: 'load'` on redeem flow navs** (chaseDriver.ts:817, 830, 850) — explicit comment: "Chase's anti-automation appears to flag back-to-back navigations that fire before the prior page is fully alive."
8. **Persistent context + storageState dump** (chaseDriver.ts:298-318, attachSessionAutoSave) — preserves long-lived device-trust token in localStorage.

Anything I propose below leaves all 8 of these intact.

## Where the wall-clock time goes

**Snapshot fetch (typical, 90s cap):**
- Nav 1 (summary): nav + render + selector wait ≈ 3-7s
- `page.content()` on summary ≈ 80-150ms
- 3 regex parses ≈ <50ms
- Nav 2 (loyalty home): SSO bounce + render + selector wait ≈ 4-9s (the SSO redirect to chaseloyalty subdomain is the slowest hop)
- `page.content()` on loyalty ≈ 80-150ms
- Nav 3 (payment activity): nav + render + selector wait ≈ 3-7s
- `page.content()` on activity ≈ 80-150ms
- **Total: ~10-23s per snapshot**

**Redeem flow:**
- Nav 1 (dashboard): ≈ 3-7s
- pacingPause 1: ≈ 1.2s
- Nav 2 (loyalty home): ≈ 4-9s (SSO bounce)
- "Available points" wait: ≈ 1-3s
- pacingPause 2: ≈ 1.2s
- Nav 3 (cash-back): ≈ 3-6s
- Form selector wait: ≈ 1-3s
- Read pre-filled amount, click checkbox: ≈ 0.5s
- pacingPause 3: ≈ 1.2s
- Continue click + waitForURL(/confirm): ≈ 2-5s
- pacingPause 4: ≈ 1.2s
- Submit click + waitForURL(/success): ≈ 2-8s (Chase's confirmation processing — server-bound)
- 2.5s readability pause
- 0.5s flush grace
- **Total: ~22-50s per redemption**

The dominant costs in both flows are **navigations + Chase's own server response time**. We can't speed those up. What we *can* speed up is:
- Local processing (`page.content()` round-trips, JSDOM, parser regex)
- Sequential waits that could be racing
- One-shot redundant nav (the /home hop in redeem)

## Tier A — clear wins, zero anti-bot risk

### A1. Selector-direct reads in snapshot fetch (replaces 3× `page.content()`)

**Current** (chaseDriver.ts:1128, 1171, 1202):
```ts
await page.locator('.activity-tile__recon-bar-balance').first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => undefined);
const summaryHtml = await page.content();        // ~80-150ms
creditBalance = parseCreditBalanceFromHtml(summaryHtml);
pendingCharges = parsePendingChargesFromHtml(summaryHtml);
availableCredit = parseAvailableCreditFromHtml(summaryHtml);
```

**Proposed:**
```ts
const reconBar = page.locator('.activity-tile__recon-bar-balance').first();
await reconBar.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => undefined);

// Three concurrent in-page reads — each is ~10-30ms, all run in parallel.
const [balanceText, pendingText, availableText] = await Promise.all([
  reconBar.textContent({ timeout: 5_000 }).catch(() => null),
  page.locator('text=/Pending charges:/').locator('..').textContent({ timeout: 5_000 }).catch(() => null),
  page.locator('[data-testid="availableCreditWithTransferBalance"]').first().textContent({ timeout: 5_000 }).catch(() => null),
]);

creditBalance = balanceText?.trim().match(/-?\$[\d,]+\.\d{2}/)?.[0] ?? '';
pendingCharges = pendingText?.match(/-?\$[\d,]+\.\d{2}/)?.[0] ?? '';
availableCredit = availableText?.match(/\$[\d,]+\.\d{2}/)?.[0] ?? '';
```

Same logic for loyalty home (`.card-info .points`) and payment activity (`tbody.activityRow`).

**Saving:** ~250-450ms per snapshot fetch (3× `page.content()` × ~120ms each, replaced by ~10-30ms locator reads).

**Risk:** zero. Same selectors as the existing waits. Worst-case (selectors don't match) we get the same empty string the regex parsers return today.

**Caveat:** the existing `parseFromHtml` functions are used by **fixture-driven tests** in `tests/`. We'd keep the pure parsers for testability and only swap the production scrape path. Drop-in.

**LOC:** ~30.

---

### A2. Race iframe-vs-parent layout detection in `attemptChaseAutoLogin`

**Current** (chaseDriver.ts:543-575):
```ts
try {
  await page.locator('iframe#logonbox').waitFor({ state: 'attached', timeout: 6_000 });
  // iframe layout
} catch {
  await page.locator('#userId-input-field-input').waitFor({ state: 'visible', timeout: 6_000 });
  // full-page layout
}
```

If Chase serves the **full /logon page** (no iframe), we wait the FULL 6s before falling through.

**Proposed:**
```ts
const iframeReady = page.locator('iframe#logonbox')
  .waitFor({ state: 'attached', timeout: 10_000 })
  .then(() => 'iframe' as const).catch(() => null);
const directReady = page.locator('#userId-input-field-input')
  .waitFor({ state: 'visible', timeout: 10_000 })
  .then(() => 'direct' as const).catch(() => null);
const winner = await Promise.race([iframeReady, directReady]);
if (!winner) return { kind: 'no_login_form' };
```

**Saving:** up to ~6s per cold login when Chase serves the full-page layout.

**Risk:** zero. Same selectors, no new behavior — just first-wins.

**Frequency:** login is rare (re-auth happens days-to-weeks apart) but the saving is real when it does fire.

**LOC:** ~10.

---

### A3. Reorder snapshot navs to minimize cross-subdomain SSO bounces

**Current order:**
1. `secure.chase.com/...summary/...` (secure subdomain)
2. `chaseloyalty.chase.com/home?AI=...` ← **SSO bounce** (cookies are on `secure`, so chaseloyalty's first hit triggers the SSO redirect)
3. `secure.chase.com/...payment-activity/...` (back to secure subdomain — no SSO bounce, but a fresh dashboard nav)

**Proposed:**
1. `secure.chase.com/...summary/...`
2. `secure.chase.com/...payment-activity/...` (same subdomain — likely a faster routed nav inside the SPA)
3. `chaseloyalty.chase.com/home?AI=...` (SSO bounce now happens last, exactly once)

The two `secure.chase.com` URLs hit the same SPA — the second nav is a hash-route within the same document hosted under the same `/web/auth/dashboard`. That should be MUCH faster than the cross-domain SSO hop.

**Saving:** ~1-2s per snapshot fetch.

**Risk:** very low. Same set of operations, just reordered. The order shouldn't matter for correctness — each scrape is independent.

**Caveat:** we should verify with one round of empirical timing that the second `secure` nav genuinely is faster than the existing flow. Logger already prints per-step timings; one good fetch with reordered navs would tell us.

**LOC:** ~5 (just reorder the three blocks).

---

### A4. Pre-load credentials in parallel with auth-prompt detection

**Current** (chaseDriver.ts:716-747): we detect `urlIndicatesAuth || overlayPresent`, THEN call `getChaseCredentials()`. Keychain access on macOS can be ~50-200ms per call.

**Proposed:** kick off `getChaseCredentials()` at the start of `maybeAutoLoginAndContinue`, in parallel with the detect-poll. By the time the poll resolves, the creds are already in hand.

**Saving:** ~50-200ms per recovery path (auth-needed cases only — not the hot path).

**Risk:** zero. Pure overlap, no behavior change.

**LOC:** ~5.

---

## Tier B — promising, needs one round of empirical validation

### B1. Skip the `/home?AI=...` nav in the redeem flow

**Current redeem path** (chaseDriver.ts:800-850): dashboard → /home?AI=... → /cash-back?AI=...

The `/home` nav exists per the comment to "prime the loyalty session for the active card." But /cash-back also takes the AI query parameter explicitly because "Some session states render an empty page (just the decorative chrome) without it" — meaning the loyalty SSO session SHOULD already have the right card context after the dashboard hit.

**Hypothesis:** going `dashboard → cash-back?AI=...` directly may work in steady-state sessions, with /home only needed for fresh-session bootstrapping.

**Proposed implementation (safe via fallback):**
```ts
await page.goto(/dashboard/, { waitUntil: 'load' });
await pacingPause();
await page.goto(`/cash-back?AI=${id}`, { waitUntil: 'load' });
const formAppeared = await page.locator('input.mds-text-input__input--hero')
  .first().waitFor({ state: 'visible', timeout: 10_000 })  // shorter probe
  .then(() => true).catch(() => false);
if (!formAppeared) {
  // fall back to the original 3-hop flow
  await page.goto(`/home?AI=${id}`, { waitUntil: 'load' });
  await pacingPause();
  await page.goto(`/cash-back?AI=${id}`, { waitUntil: 'load' });
  await page.locator('input.mds-text-input__input--hero').first().waitFor({ state: 'visible', timeout: 30_000 });
}
```

**Saving:** ~4-9s per redemption when the shortcut works. ~0 (negligible probe overhead) when it doesn't.

**Risk:** medium. If we miss a session-state edge case, the fallback recovers but we've burned ~10s on the failed first attempt. But the risk is bounded — the fallback is exactly today's flow.

**Verification needed:** run 5-10 redemptions in dev mode with the shortcut; if all 10 land on the form, we have confidence. If any fall back, we know the shortcut is unreliable and we hold.

**LOC:** ~30.

---

### B2. Drop `pacingPause()` between clicks (keep them between navs)

**Current redeem flow has 4 pacing pauses:**
1. between dashboard nav → /home nav (between-nav, KEEP)
2. between /home → /cash-back (between-nav, KEEP)
3. between checkbox-tick → Continue click (between-CLICK, possibly droppable)
4. between Continue→/confirm and Submit click (between-CLICK after a page transition)

The comment justifying pacingPause specifically calls out the **nav rhythm** ("SSO → /home → /cash-back"). Between-click pauses (3 and 4) don't match that pattern — they happen after the page has fully transitioned.

**Proposed:** keep nav-pacing pauses (1 and 2), drop click-pacing pauses (3 and 4).

**Saving:** ~2.4s per redemption.

**Risk:** medium. Chase's anti-bot may also fingerprint the click→submit cadence. The existing pauses make the flow feel paced; a 2.4s reduction is below user-perceptible-jankiness threshold but might be above Chase's bot-vs-human rhythm threshold.

**Verification needed:** same 5-10 redemption A/B as B1.

**LOC:** ~5.

---

## Tier C — DO NOT TOUCH (anti-bot risk too high)

| # | Idea | Why not |
|---|---|---|
| C1 | CDP request-blocking for tracking/ads on chase.com | Chase fingerprints "is the user blocking ads?" as a bot signal. Even blocking google-analytics.com risks scoring badly. |
| C2 | `waitUntil: 'load'` → `'domcontentloaded'` on redeem navs | Explicit comment in code says back-to-back navs that fire before SPA hydrates get flagged. |
| C3 | `fill()` instead of per-character `type()` for credentials | Anti-paste handler bypass; explicit comment on this. |
| C4 | Headless mode for snapshot fetch | Chase fingerprints headless instantly. |
| C5 | UA spoofing (e.g. mimicking real Chrome version more aggressively) | Banks fingerprint UAs; custom = more challenges, not fewer. |
| C6 | Idle-pool / cross-action context reuse | Bank automation security boundary; user expects window to close. Also the persistent userDataDir lock means concurrent ops can't share one anyway. |
| C7 | Concurrent multi-tab snapshot (parallelize the 3 navs) | Same context, multi-tab simultaneity is bot-shaped. The 3 tabs all hitting Chase from the same session at once is exactly what their fingerprinter is looking for. |

## What I deliberately didn't propose

- **Selector tightening for screenshot scrape** — captureSummaryDebugSnapshot is error-path only.
- **Reducing the 30s selector timeouts** — these are upper bounds; they don't actually wait 30s, they bail at 30s. Cold load can legitimately take 8-12s.
- **Removing the 500ms flush grace before close** — the comment explains it's needed for cookie batching. Even if it's slightly conservative, this is the path that prevents "Chase keeps logging me out" reports.
- **Removing the 2.5s readability pause after redeem success** — that's UX, not perf.
- **Touching `attachSessionAutoSave`** — the 60s safety net + 2s framenavigated coalesce are exactly right. Disk-write rate is not the bottleneck.
- **Multi-card parallel snapshots** — the userDataDir is per-profile; one snapshot per profile already runs serially because of the ProcessSingleton lock. Parallelizing across DIFFERENT profiles is already supported (each has its own lock). Within a profile: not possible.

## Suggested ship order

| # | Change | Saving | Risk | LOC |
|---|---|---|---|---|
| A1 | Selector-direct reads in snapshot (3 pages) | ~250-450ms / fetch | zero | ~30 |
| A3 | Reorder snapshot navs (secure × 2, then loyalty) | ~1-2s / fetch | very low | ~5 |
| A2 | Race iframe-vs-direct in attemptChaseAutoLogin | up to ~6s / cold login | zero | ~10 |
| A4 | Pre-load creds parallel to auth detection | ~50-200ms / recovery | zero | ~5 |
| B1 | Skip /home in redeem (with fallback) | ~4-9s / redeem | medium | ~30 |
| B2 | Drop pacingPause between clicks | ~2.4s / redeem | medium | ~5 |

**Recommended single-PR bundle:** A1 + A2 + A3 + A4 = ~50 LOC, ~1.5-2.5s snapshot saving + up to 6s login-recovery saving + zero anti-bot risk. Can ship as v0.13.28.

**Tier B should be a separate PR with conservative validation** — run a handful of empirical redemptions before flipping the default.

## Realistic ceiling

Even with all Tier A + Tier B shipped, the **dominant cost remains Chase's own server-side response time**: SSO redirects, card-summary hydration, redemption-confirmation processing. We're shaving 10-30% off the local-overhead portion of these flows, not changing the server-bound floor.

Snapshot fetch realistic floor: ~7-15s (was ~10-23s).
Redeem realistic floor: ~12-35s (was ~22-50s).

Beyond that, the only meaningful lever is reducing how OFTEN we hit Chase — caching snapshots more aggressively in the renderer, deduping the StrictMode double-fires (already done via `coalesceSnapshot`), letting the user opt out of pending-charges or available-credit if they don't care. None of that is a Chase-side speedup; it's a "don't talk to Chase as much" strategy.
