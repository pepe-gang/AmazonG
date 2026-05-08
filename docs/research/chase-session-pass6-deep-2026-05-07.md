# Chase session lifetime — pass 6 (5-round deep research)

**Date:** 2026-05-07
**Triggered by:** user wants to keep Chase sessions alive longer; willing to invest research time
**Status:** research only

Five parallel rounds: Akamai sensor refresh mechanics, Chase keepalive XHR identification, localStorage device-trust deep dive, real-Chrome behavior comparison, "Stay signed in" dialog mechanics.

## TL;DR — three actionable findings

1. **`storageState({ indexedDB: true })` is OFF in AmazonG.** Real bug. Playwright's storageState defaults to cookies + localStorage only; IndexedDB requires opt-in (added in Playwright 1.51). If Chase puts ANY device-trust JWT or auth token in IDB, AmazonG drops it on every relaunch — looking like a "new device" each time. **Fix: 2 LOC change.** Highest-confidence concrete gap identified.

2. **The "Stay signed in" warning dialog is a real, capturable session extension surface.** Confirmed dialog text from HN: "Your session is about to end. You've been inactive for a while. For your security, we'll automatically sign you out in approximately 1 minute." 1-minute warning window. Two buttons: "Stay signed in" / "Sign out". Empirical capture script (browser DevTools console snippet) included below to identify exact selectors + which XHR fires when "Stay signed in" is clicked. **Once captured, ~60 LOC implementation to detect + click.**

3. **Best keepalive XHR endpoint: `POST /svc/rr/accounts/secure/v1/menu/list`** (smaller payload than dashboard/module/list, same anti-bot envelope). Fire from `page.evaluate()` inside an open Chase user-facing window every 4-5 minutes (jittered) while `document.visibilityState === 'visible'`. ~30 LOC. Anti-bot risk: low (transport-indistinguishable from SPA's own XHR).

## Round 1 — Akamai `_abck` sensor refresh mechanics

**Confirmed canonical event listeners** (Akamai's Boomerang RUM doc, cross-checked against `bmak` reverse-engineering):
- `mousemove`, `scroll`, `click`, `keydown`, `pointerdown`, `pointerup`, `mousedown`, `touchstart`, `visibilitychange`

**Sensor postback cadence** — the canonical "3 sensors to validity" rule (Hyper Solutions, ScrapeBadger, xvertile/akamai-bmp-generator):
- First POST shortly after `bmak.js` (~512KB) loads
- After 3 successful sensor POSTs, `_abck` is "solved"
- After protected actions, cookie typically invalidates (`~0~`) → must re-solve
- **Steady-state idle cadence: no public source.** Boomerang's analogous `afterOnloadMinWait` is 5000ms with up to 60s debounce. Most likely 30-120s for `bmak`, but unconfirmed.

**Sensor postback URL pattern** — DYNAMICALLY GENERATED per session:
- Path is parsed from a `<script src=...>` tag near the end of the protected page's HTML
- Format: random multi-segment, e.g., `/yMOlMy/yS/3T/NVx6/a7xTRI1O5hJJ8/...`
- Payload: `POST {"sensor_data": "<encrypted_blob>"}`
- **Chase-specific URL: not in any public capture I could find** — would need empirical capture

**`_abck` freshness window:** "~1 hour" is folklore; no source pins it definitively. Tenant-variable; banks (high-risk) likely run tighter windows.

**Synthetic events with `isTrusted: false`:** confirmed cannot be spoofed from JS. `bmak` filters on `isTrusted`. `page.evaluate(() => document.dispatchEvent(new MouseEvent(...)))` produces UNTRUSTED events that get discarded or flagged.

**CDP-dispatched events (Playwright `page.mouse.move`):** `isTrusted = true`. Picked up by `bmak`. **Caveat:** CDP itself is detected by Akamai (`Runtime.enable` artifacts). Trusted events from a detected CDP session are still problematic.

**`bm_sv` and `bm_sz` lifecycles:** TTL 2h and 4h respectively (cookie.is). `bm_sz` seeds the PRNG used in subsequent sensor encryption. Refresh in lockstep with `_abck` server-side, not independently.

**Recommended `_abck`-warming techniques (ranked by risk + LOC):**

| Tier | Technique | LOC | Risk |
|---|---|---|---|
| 1 | `Page.bringToFront` / `Emulation.setFocusEmulationEnabled(true)` on 30-60s timer (triggers `visibilitychange`) | ~10 | Near-zero |
| 1 | Don't navigate the Chase tab unnecessarily — keep it focused | ~5 | Zero |
| 2 | Periodic CDP `page.mouse.move()` to randomized point, jittered 30-90s | ~30 | Low |
| 2 | Sparse `page.keyboard.press('Shift')` (modifier, no input) every ~5 min | ~10 | Low |
| 3 | Force sensor POST via intra-page navigation | ~40 | Higher |
| 4 | Direct `bmak.bpd()` invocation — DO NOT, classic bypasser pattern | n/a | Bypasser-detected |

**Critical:** randomize jitter — perfectly periodic 30s tick is itself a bot signal.

## Round 2 — Chase keepalive XHR identification

**The captured AmazonG JSONL doesn't show heartbeat traffic** — capture window was 5.6s (single login + dashboard render), not idle observation. No periodic XHR visible.

**Public Chase reverse-engineering: ZERO documentation of a dedicated session-extend endpoint.** The MaxxRK chaseinvest-api has NO keepalive code — relies entirely on natural request traffic.

**Hypothesis (medium-high confidence):** Chase's "Stay signed in" button doesn't call a dedicated endpoint — it just re-fires one of the dashboard XHRs. Any successful authenticated `/svc/` POST resets the server-side idle timer. This is consistent with industry-standard SPA patterns (Akamai mPulse SPA tracking docs).

**Best candidates for AmazonG keepalive XHR (ranked):**

| Rank | Endpoint | Why |
|---|---|---|
| 1 | `POST /svc/rr/accounts/secure/v1/menu/list` | Smallest expected payload (KB-range), authenticated, idempotent. Fire from `page.evaluate(fetch(...))`. |
| 2 | `POST /svc/rl/accounts/secure/v1/dashboard/module/list?context=WEB_CREDIT_CARD_DASHBOARD` | Larger payload (20-100KB) but lowest detection risk — exactly what real users fire on dashboard view. |
| 3 | `POST /svc/wl/auth/l4/v1/user/router/list` | Likely small, alternative shape. |

**Implementation pattern (~30 LOC):**
```ts
// Inside an open user-facing Chase window
async function attachChaseKeepalive(page: Page): Promise<() => void> {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    if (await page.evaluate(() => document.visibilityState !== 'visible').catch(() => true)) {
      schedule(); return; // skip if backgrounded
    }
    await page.evaluate(() => fetch('/svc/rr/accounts/secure/v1/menu/list', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'x-jpmc-csrf-token': 'NONE',
        'x-jpmc-channel': 'id=C30',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
    }).then(r => r.status).catch(() => null));
    schedule();
  };
  const schedule = () => {
    const ms = (4 + Math.random() * 2) * 60_000; // 4-6 min jittered
    setTimeout(tick, ms);
  };
  schedule();
  return () => { stopped = true; };
}
```

**DON'T fire from `context.request.get()`** — Node TLS / JA3 mismatch (pass-2 finding).

## Round 3 — localStorage device-trust deep dive

**The concrete bug:** `storageState()` is called WITHOUT `indexedDB: true` in `chaseDriver.ts:319-336` and `:421-462`. Playwright defaults to cookies + localStorage; IndexedDB is opt-in.

**If Chase puts a device-trust JWT in IDB**, AmazonG drops it on every relaunch. Chase mints a new one → looks like a "new device" → tighter TTL.

**Fix:** 2 LOC change to add `indexedDB: true` to both `storageState()` calls. Zero risk. Free win regardless of whether Chase actually uses IDB (no-op if they don't).

**Other localStorage findings:**
- AmazonG's `getItem === null` guard is correct (don't overwrite Chase-updated values)
- Cross-origin coverage seems reasonable (per-origin restore in addInitScript)
- Cookies with `Domain=.chase.com` are correctly captured
- Service-worker Cache API storage is NOT captured by Playwright (no API for it) — gap, but probably not where Chase keeps auth

**No public source identifies specific Chase localStorage key names.** Need to grep your actual snapshot file (`~/Library/Application Support/AmazonG/chase-profiles/<id>.session.json`) for clues:
- Keys starting with `bm-`, `bm_`, `ak-`, `ak_` (Akamai)
- Keys containing `chase`, `JPMC`, `device`, `MFA`, `OTP`, `pkp`, `passport`, `trust`
- Long base64-ish values starting with `eyJ` (JWTs)

**Other recommended changes:**
| # | Change | LOC | Risk |
|---|---|---|---|
| 1 | `storageState({ indexedDB: true })` | 2 | Very low |
| 2 | Log inventory of localStorage key names per origin at save | 10 | Zero (names only, no PII) |
| 3 | Atomic-write session JSON (write-tmp-rename) | 5 | Very low |

## Round 4 — Real Chrome vs AmazonG comparison

**Functionally equivalent for cookie/localStorage persistence.** The honest gaps:

| # | Gap | Likelihood matters | LOC to close |
|---|---|---|---|
| 1 | **Real users click; AmazonG fetches headlessly via XHR.** Idle Chrome doesn't extend sessions either — it's the casual clicking that resets the idle timer. | High | ~30 (Round 2's keepalive) |
| 2 | **Stale `_abck` snapshot between auto-saves** — force-quit drops the rotation | Medium | ~40 (more aggressive autoSave) |
| 3 | **No "Stay signed in" dialog interception** | Medium (only matters in 10-11 min idle window) | ~60 (Round 5) |
| 4 | **IndexedDB not captured** | Unknown — depends on whether Chase uses it | 2 (Round 3 #1) |

**Definitively NOT gaps:**
- Service worker (Chase auth surface almost certainly doesn't use one)
- BroadcastChannel / SharedWorker
- Push notifications (Chase doesn't ship a subscription)
- Notification API
- Chrome's idle background activity (it doesn't extend sessions, period)

## Round 5 — "Stay signed in" dialog mechanics

**Confirmed dialog text (HN 35038210, March 2023):**
> Your session is about to end. You've been inactive for a while. For your security, we'll automatically sign you out in approximately 1 minute. You may choose "Stay signed in" to continue or sign out if you're done.

Buttons: **"Stay signed in"** / **"Sign out"**. Warning window: ~1 minute.

**DOM structure: NOT in any public source.** Hypothesis based on JPMC's design system (Mosaic) and ARIA conventions:
```html
<div role="dialog" aria-modal="true" aria-labelledby="...">
  <h2>Your session is about to end.</h2>
  <p>You've been inactive...</p>
  <button>Stay signed in</button>
  <button>Sign out</button>
</div>
```

**Locator chain (priority order):**
1. `getByRole('dialog').getByRole('button', { name: /stay signed in/i })`
2. `page.locator('[role="dialog"]:visible button:has-text("Stay signed in")')`
3. ChaseLock fallback: `button:has-text("Continue"):visible`
4. XPath: `//button[normalize-space()="Stay signed in" or normalize-space()="Continue"]`

**Click handler:** trusted click via `locator.click()` (NOT `force: true`, NOT `dispatchEvent`). Akamai/Chase increasingly check `event.isTrusted`.

**Polling interval:** 5 sec inside open user-facing windows (cheap; in-memory locator query). The 1-minute warning gives plenty of margin.

**Empirical capture script — paste in DevTools console of an authenticated Chase tab, leave idle 12-15 min:**

```js
const log = (label, data) => console.log(`[chase-capture] ${label}`, data);
new MutationObserver((muts) => {
  for (const m of muts) for (const n of m.addedNodes) {
    if (n.nodeType !== 1) continue;
    const dlg = n.matches?.('[role="dialog"], dialog')
      ? n
      : n.querySelector?.('[role="dialog"], dialog');
    if (dlg && /sign|session|expire/i.test(dlg.textContent)) {
      log('DIALOG_APPEARED', {
        outerHTML: dlg.outerHTML.slice(0, 4000),
        tag: dlg.tagName,
        role: dlg.getAttribute('role'),
        classes: dlg.className,
      });
      dlg.querySelectorAll('button, a[role="button"]').forEach(b =>
        log('BUTTON', {
          text: b.textContent.trim(),
          id: b.id,
          classes: b.className,
          dataset: { ...b.dataset },
          ariaLabel: b.getAttribute('aria-label'),
        }),
      );
    }
  }
}).observe(document.body, { childList: true, subtree: true });

const origFetch = window.fetch;
window.fetch = function (...args) {
  const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
  if (/session|extend|keep|refresh|svc\/(rl|wr|wl|rr)/i.test(url || '')) log('FETCH', { url, method: args[1]?.method || 'GET' });
  return origFetch.apply(this, args);
};
const origOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (m, u, ...rest) {
  if (/session|extend|keep|refresh|svc\/(rl|wr|wl|rr)/i.test(u)) log('XHR', { method: m, url: u });
  return origOpen.call(this, m, u, ...rest);
};
console.log('[chase-capture] armed — leave tab idle 10–15 min, then click "Stay signed in"');
```

When the dialog appears, COPY the `DIALOG_APPEARED` + `BUTTON` log lines. Then click "Stay signed in" and copy the `FETCH` / `XHR` line(s) that fire next.

That gives us:
- Exact `outerHTML` (selectors confirmed)
- Exact button identifiers
- Exact endpoint URL fired on click

After capture, ~60 LOC implementation to detect + click is mechanical.

## Synthesized priority ship plan

### Tier 1 — Ship without further research (low risk, real value)

| # | Change | LOC | Source |
|---|---|---|---|
| 1 | `storageState({ indexedDB: true })` in both spots in `chaseDriver.ts` | 2 | Round 3 |
| 2 | Atomic-write session JSON | 5 | Round 3 |
| 3 | Diagnostic instrumentation patch from pass-5 | ~480 | Pass-5 round 2 |

The `indexedDB: true` change is the single highest-confidence concrete bug fix in this entire pass. 2 LOC. Ship today.

### Tier 2 — Ship after one capture run

| # | Change | LOC | Prerequisite |
|---|---|---|---|
| 4 | Chase keepalive XHR (`/svc/rr/accounts/secure/v1/menu/list` every 4-6 min in open windows) | ~30 | Verify endpoint behaves as keepalive (idle 9 min → fire XHR → stays alive) |
| 5 | "Stay signed in" dialog detection + click | ~60 | DOM capture script (above) confirms exact selector + endpoint |

Tier 2 needs ~15 minutes of empirical capture work each. Once done, both are mechanical implementations.

### Tier 3 — Defer

| # | Change | Why defer |
|---|---|---|
| 6 | CDP mouse-jiggle for `_abck` warming | Tier 2 should be sufficient; mouse-jiggle adds detection surface (CDP fingerprint) |
| 7 | More aggressive autoSave triggers | Already pass-5 plan; ship after Tier 1+2 prove insufficient |

## Bottom line

**The single highest-leverage move RIGHT NOW: add `indexedDB: true` to `storageState()` calls.** 2 LOC, zero risk, plausibly closes a real device-trust gap that's been in the codebase since AmazonG's beginning. Ships today.

After that, the empirical capture work (Stay signed in dialog mechanics) is a 15-minute investment that unlocks Tier 2 (~90 LOC for a real session-extension feature).
