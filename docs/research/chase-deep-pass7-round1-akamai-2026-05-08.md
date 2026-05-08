# Chase Stage C — Pass 7 Round 1: Akamai / anti-bot risk audit — 2026-05-08

**Charter:** audit whether firing direct fetches via `page.evaluate(fetch())` from the SPA's authenticated origin (Stage C: 1 nav + `Promise.all` of 14 fetches) trips Akamai detection that today's passive XHR-listener pattern (Stage B) avoids.

**Method:** read-only synthesis of (a) prior in-tree research notes, (b) the captured request/response JSONLs in `research-logs/`, (c) AmazonG's existing in-page `fetch()` keepalive code (already shipping the same pattern), and (d) public documentation on Akamai bot manager mechanics. No new code written. No empirical capture run for this pass.

---

## TL;DR

1. **Stage C's transport posture is identical to Stage B** for everything Akamai's pipeline can observe at the network layer. Same Chromium TLS handshake, same JA3/JA4, same cookie jar, same UA + sec-ch-ua-* envelope, same form-encoded body, same `x-jpmc-csrf-token: NONE` + `x-jpmc-channel: id=C30` headers. (Confidence: **high**, evidence: `research-logs/chase-xhr-...jsonl` request-header dump cross-checked against MDN fetch credentials docs.)

2. **The SPA itself fires bursts that match what Stage C would do.** Empirical capture shows 5 `/svc/` POSTs in a 335ms window during natural dashboard hydration, and 4× `/svc/rr/.../menu/list` in 246ms. A 14-fetch `Promise.all` is *quantitatively* larger but *qualitatively* the same shape. (Confidence: **high**, two independent captures agree.)

3. **There IS one header gap worth surfacing:** the SPA emits a fresh `x-jpmc-client-request-id` UUID per request; AmazonG's existing `page.evaluate(fetch())` keepalive does not, and the proposed Stage C sketch in `chase-mcp-direct-fetch-2026-05-08.md` doesn't either. The keepalive empirically returns 200 in production — so the field is **not enforced** by Chase's backend today. But it's a free defense-in-depth tweak (one `crypto.randomUUID()` per call). (Confidence: **medium-high** for "not currently enforced"; **low** for "will never be enforced".)

4. **Sensor freshness is the single real risk.** If Stage C fires before the SPA's hydration sequence has shipped its bot-manager-protected XHRs (the ones we currently listen passively for), `_abck` may not yet be in its post-hydration state. Recommendation: **wait for the SPA's first natural `dashboard/module/list` to land**, *then* fire the parallel batch — instead of firing immediately on `domcontentloaded`. Adds ~1-2s but eliminates the only research-flagged risk vector. (Confidence: **medium**.)

5. **Several questions cannot be answered without empirical capture.** Specifically: rate-limit thresholds on `dashboard/module/list`, `_abck`-rotation cadence under bursty in-page fetch, response Set-Cookie observability (current capture mode doesn't record response headers). All of these would need a one-off instrumented run. Marked **unknown** below.

---

## Per-question answers

### Q1. Sensor timing — when does `bmak.js` mint the first valid `_abck`?

**Direct answer:** unknown precisely, but several constraints are documented.

**Evidence:**
- The "3 sensors to validity" rule is referenced in multiple sources (Hyper Solutions, ScrapeBadger, glizzykingdreko's v3 deep-dive) but **no source pins the exact event** the first sensor POST is gated on. ([Hyper Solutions docs](https://docs.hypersolutions.co/akamai-web/getting-started), [glizzykingdreko v3 deep dive](https://medium.com/@glizzykingdreko/akamai-v3-sensor-data-deep-dive-into-encryption-decryption-and-bypass-tools-da0adad2a784))
- Pass-6 round 1 in `docs/research/chase-session-pass6-deep-2026-05-07.md:17-30` summarizes: "First POST shortly after `bmak.js` (~512KB) loads. After 3 successful sensor POSTs, `_abck` is 'solved'."
- **Empirical from our captures:** in `research-logs/chase-xhr-...2026-05-07T22-34-50-219Z.jsonl`, the first `/svc/` POST that fires is `/svc/wl/auth/public/v1/site/availability/list` at t+0ms — but that's a *pre-auth* call. The *post-auth* dashboard hydration burst kicks off at t+2536-2891ms (a 5-XHR cluster). This means by the time `dashboard/module/list` fires naturally, the SPA has already had ~2.5s of hydration where sensor POSTs (if any) would have happened.
- **No `/auth/fcc/adaptive` or external Akamai sensor POST visible in our captures.** We're capturing post-login, after `_abck` is presumably already valid. (Capture file path: `research-logs/chase-full-54f1867e-30ba-4cd9-8b6b-7acdc094428b-2026-05-08T14-49-04-804Z.jsonl`.)

**Implication for Stage C:** if we fire fetches immediately after `domcontentloaded`, we may be racing the sensor pipeline. The SPA's natural dashboard XHR fires at t+2.5s — so the `_abck` cookie is in its post-hydration state by then. **The safest gate is: wait for the SPA's first `dashboard/module/list` to land, then fire ours.** This is the same Stage B passive listener already in place at `chaseDriver.ts:1331-1349` — Stage C can layer on top by using that arrival event as the green light to fire additional fetches.

**Confidence:** medium. We don't have direct empirical evidence of "fired-too-early breaks `_abck`." We have evidence that the SPA's natural sequence has settled by ~2.5s post-DCL, and we have the pass-3/pass-6 prior-research consensus that pre-hydration fetches are riskier than post-hydration ones.

---

### Q2. Burst patterns — is a 14-fetch `Promise.all` distinguishable from natural SPA hydration?

**Direct answer:** quantitatively larger; qualitatively same shape. The SPA already fires bursts.

**Evidence (verbatim from `research-logs/chase-xhr-...2026-05-07T22-34-50-219Z.jsonl`, decoded):**

```
+    0ms  POST /svc/wl/auth/public/v1/site/availability/list
+ 1235ms  POST /svc/wl/auth/l4/v1/user/router/list
+ 1354ms  POST /svc/rl/accounts/l4/v1/app/data/list
+ 2536ms  POST /svc/wr/accounts/l4/dso/v2/offers/list      ← burst start
+ 2587ms  POST /svc/rl/accounts/secure/v1/dashboard/module/list
+ 2626ms  POST /svc/wr/accounts/l4/v1/deck/messages/list
+ 2796ms  POST /svc/rr/accounts/secure/card/rewards/v2/summary/list
+ 2817ms  POST /svc/wr/accounts/secure/gateway/.../digital-offers/v2/offers
+ 2849ms  GET  /svc/wr/profile/secure/.../v3/customer-offers   ← 5 XHRs in 313ms
+ 4684ms  POST /svc/rr/accounts/secure/v1/menu/list           ← burst 2 start
+ 4773ms  POST /svc/rr/accounts/secure/v1/menu/list
+ 4816ms  POST /svc/rr/accounts/secure/v1/menu/list
+ 4872ms  POST /svc/rr/accounts/secure/v1/menu/list           ← 4 XHRs in 188ms
```

This is reproducible — second capture (`chase-full-...2026-05-08T14-48-31-553Z.jsonl`) shows nearly identical shape: 5 XHRs in 335ms (+2507 to +2891ms), 4 menu/list calls in 246ms (+4969 to +5215ms).

**Stage C's burst:** 1 overview + N rewards (N=13 in this user's case). With HTTP/2 stream-multiplexing the browser will multiplex over the same connection; transport-level "shape" is one upstream + 14 concurrent streams in a ~50-300ms window. The SPA's natural pattern (5 in 335ms; 4 in 188ms) shows Akamai's policy clearly tolerates concurrent-stream bursts on the same H2 socket from the same authenticated session.

**The 14 vs 5 quantitative gap is the only delta worth measuring.** Akamai rate-policy docs ([Rate Policy techdocs](https://techdocs.akamai.com/terraform/docs/rate-policy-options)) define `averageThreshold`, `burstThreshold`, `burstWindow` parameters but no public source gives Chase's specific values. Documented examples use `averageThreshold=5, burstThreshold=8, burstWindow=3s`; we don't know if Chase tunes tighter or looser.

**Confidence:** medium-high that the *shape* is non-anomalous; **low** that 14 specifically won't trip a per-second policy. **Mitigation:** if we want to be conservative, fire overview + a stagger of 2-3 rewards-batches (e.g. `Promise.all` of the overview + first 7 rewards, then `Promise.all` of remaining rewards 100-200ms later). Adds ~150ms latency for a meaningful safety margin.

---

### Q3. Header parity — what does the SPA emit that we'd miss?

**Direct answer:** 1 header missing in our current Stage C plan: `x-jpmc-client-request-id`. Otherwise transport-equivalent.

**Evidence — full SPA request header set from JSONL (`/svc/rl/accounts/secure/v1/dashboard/module/list?context=WEB_CREDIT_CARD_DASHBOARD`):**

```
accept: application/json, text/plain, */*
content-type: application/x-www-form-urlencoded; charset=UTF-8
referer: https://secure.chase.com/web/auth/dashboard
sec-ch-ua: "Chromium";v="147", "Not.A/Brand";v="8"
sec-ch-ua-arch: "arm"
sec-ch-ua-bitness: "64"
sec-ch-ua-full-version-list: "Chromium";v="147.0.7727.15", "Not.A/Brand";v="8.0.0.0"
sec-ch-ua-mobile: ?0
sec-ch-ua-model: ""
sec-ch-ua-platform: "macOS"
sec-ch-ua-platform-version: "26.4.1"
sec-ch-ua-wow64: ?0
user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36
x-jpmc-channel: id=C30
x-jpmc-client-request-id: 50c913a9-5e2b-46ad-beb3-7f488b6d8239   ← UNIQUE PER REQUEST
x-jpmc-csrf-token: NONE
```

**Browser auto-emitted (we don't need to set):** all `sec-ch-ua-*`, `user-agent`, `referer`, `accept-language`, `cookie`, `origin`. ([MDN Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch), MDN Request.credentials.)

**We must set explicitly:** `accept`, `content-type`, `x-jpmc-csrf-token: NONE`, `x-jpmc-channel: id=C30`. The Stage C sketch in `chase-mcp-direct-fetch-2026-05-08.md:124-129` covers all four.

**The gap:** `x-jpmc-client-request-id` is a **fresh UUID v4 per request**. Verified across 18 distinct `/svc/` requests in the capture: 18/18 unique UUIDs. AmazonG's current production keepalive at `chaseDriver.ts:1652-1665` fires `/svc/rr/accounts/secure/v1/menu/list` *without* this header and Chase returns 200 (`logger.info('chase.keepalive.fired', { profileId, status })` returns 200 in production — confirmed via grep). So the header is **not currently enforced as required by Chase's backend.**

**However**, two things to note:
- It's clearly tracked server-side (carried to logs / tracing infrastructure).
- A fleet of requests that all *omit* this header is a discriminating signal Chase could weaponize without code changes.
- Generating one fresh UUID per call costs ~10μs (`crypto.randomUUID()`).

**Recommendation:** include `x-jpmc-client-request-id: <uuid>` in Stage C requests, and back-port to the keepalive. Cheap insurance; matches the SPA's exact emission pattern.

**Other endpoint extras** (NOT applicable to overview/rewards, but documented for completeness): `/svc/wr/profile/secure/gateway/...customer-offers` calls add `authorization`, `channel-identifier: C30`, `channel-type: WEB`, `trace-id`, `path-params: {...JSON...}`. We're not replicating those endpoints in Stage C; they're listed here so future work knows they exist.

**Confidence:** **high** for what headers the SPA emits (direct JSONL evidence). **Medium-high** for "not currently required" (in-production keepalive returns 200 without it, but that's one endpoint and may not be the strictest one).

---

### Q4. Frequency / rate-limit — burst detection thresholds?

**Direct answer:** unknown for Chase specifically. Public Akamai docs describe configurable rate-policy parameters but no Chase-specific numbers.

**Evidence:**
- [Akamai rate-policy options](https://techdocs.akamai.com/terraform/docs/rate-policy-options) document `averageThreshold`, `burstThreshold`, `burstWindow` with example values 5/8/3 (req/burst-req/sec). These are *tenant-configurable*; Chase's policy is private.
- [Akamai bot manager product docs](https://www.akamai.com/products/bot-manager) describe behavioral analysis + anomaly detection but don't reveal specific thresholds.
- Pass-3 (`docs/research/chase-perf-pass3-roadmap-2026-05-07.md:78-85`) speculated 3-5s as the "Akamai burst-detection window" based on the empirical XHR-landing window in `chaseDriver.ts:1209`. This is **inference, not measurement** — the 3-5s is the *SPA's* hydration tail, not necessarily Akamai's policy threshold.
- **Empirical SPA pattern (from our captures):** SPA fires up to 5 XHRs in 313ms and 4 in 188ms naturally. If Akamai blocked at 5/burst, Chase's own SPA would be self-DOSing — so the threshold is clearly above 5/sec from a single authenticated session.

**Stage C's 14-fetch parallel pattern is ~2-3x the SPA's natural burst.** Whether Chase tolerates this is **unknown without an empirical run**. The Cuong-profile MCP test at `chase-mcp-direct-fetch-2026-05-08.md` shipped 1 overview + 1 detail + 1 rewards = 3 fetches and got `~282ms` end-to-end with 200 statuses — but that's a 3-fetch test, not 14.

**Risk model:**
- Best case: 14 in 200ms passes. (Likely — SPA-native bursts are plausibly 8-10 with cascading XHRs, and Chase doesn't block its own SPA.)
- Middle case: rate-policy fires, returns 429 or `_abck` invalidation on the 8th-10th fetch. Recoverable: drop concurrency to 6-8 and retry.
- Worst case: Akamai marks the session as bot-shaped and bans cookies. **Fully recoverable via the existing fall-back-to-fresh-Akamai-cookies path** (cookie filter from pass-3, currently REVERTED but restorable).

**Recommendation:** start with **concurrency cap of 6-8 per `Promise.all` batch**, with sequential batches separated by 100-200ms. For a 13-card profile this means 2 batches: 1 overview + 7 rewards (8 fetches), then 6 rewards (6 fetches), 200ms apart. Wall-clock cost vs full-parallel: ~200ms. Safety margin: substantial. If empirical testing later confirms full 14-parallel is fine, drop the staged batching.

**Confidence:** low on numeric thresholds. Medium-high that 6-8 per batch is safely under any reasonable threshold, given the SPA's own 5-XHR organic bursts.

---

### Q5. Sensor invalidation after direct fetch — does it kill `_abck`?

**Direct answer:** the cookie *rotates* on most authenticated calls; that's normal. Does our direct fetch "invalidate" rotation? No — same browser context, same cookie jar. The pass-3 finding was about **cross-launch cookie replay**, not in-session fetch.

**Evidence:**
- Pass-3 finding (`docs/research/chase-perf-pass3-roadmap-2026-05-07.md:20-46`): the original hypothesis was that restoring `_abck` from a previous session causes invalidation because the new Chromium TLS state doesn't match the old digest. **This was tested empirically and reverted** — `chaseDriver.ts:255-278` documents that filtering Akamai cookies *made sessions worse* (re-auth within ~20 min), so AmazonG now restores them. Critical: **the cookie-replay risk is between launches**, not within an in-session fetch.
- [Kameleo glossary](https://kameleo.io/glossary/akamai-abck-cookie): "_abck acts as a stateful fingerprint token... future requests can be evaluated faster." Rotation is normal during active sessions.
- [Captain Compliance _abck explainer](https://captaincompliance.com/education/_abck/): "_abck cookie typically becomes invalidated after performing a protected action; must re-solve via sensor POST."
- [Scrapfly bypass guide](https://scrapfly.io/bypass/akamai): confirms `_abck` rotates on protected actions; the value must remain valid against the requesting fingerprint.
- [MDN Request.credentials](https://developer.mozilla.org/en-US/docs/Web/API/Request/credentials): with `credentials: 'include'`, same-origin fetch fully participates in the cookie jar — Set-Cookie response headers update the jar; subsequent requests pick up the new value.

**Implication for Stage C:** in-page `fetch()` from the same browser context shares the same cookie jar as the SPA's own XHRs. When Akamai sends `Set-Cookie: _abck=...` on a response, Chrome updates the cookie jar; subsequent in-page fetches (and Playwright's `context.cookies()` + `storageState()`) all see the new value. **No cookie-jar split between SPA-fired and `page.evaluate`-fired fetches.**

**The only failure mode**: if the *first* fetch in our `Promise.all` triggers `_abck` rotation (Set-Cookie in response), the 2nd-14th fetches that we've already dispatched in parallel will carry the old value. With HTTP/2 multiplexing all 14 are likely already in-flight before any response arrives. This is **the same shape the SPA itself produces in its 5-XHR burst** — and it works. So this is not a Stage C–specific risk.

**Confidence:** medium-high.

---

### Q6. `x-jpmc-client-request-id` — is it observed server-side?

**Direct answer:** the SPA emits a fresh UUID v4 per request. Chase clearly tracks it (carried to server-side logs / tracing). It is not currently enforced as required (AmazonG's keepalive returns 200 without it). It is a free defense-in-depth tweak.

**Evidence:**
- 18/18 distinct `/svc/` requests in the JSONL capture have unique `x-jpmc-client-request-id` values (Python verified: `len(set(crids)) == len(crids)`).
- Format: lowercase UUID v4 (`50c913a9-5e2b-46ad-beb3-7f488b6d8239`).
- AmazonG's `chaseDriver.ts:1652-1665` keepalive omits this header; Chase returns 200 (verified via the `chase.keepalive.fired` log line that asserts the captured status).

**Recommendation (unchanged from Q3):** generate `crypto.randomUUID()` per fetch and include the header. ~3 LOC change.

**Confidence:** **high** for "SPA emits unique UUIDs"; **medium-high** for "not currently required." We can't rule out that *some* `/svc/` endpoints (e.g. money-moving payment POSTs) DO require it; the test here is on a read-only menu/list endpoint.

---

### Q7. isTrusted / event provenance — does Akamai's sensor care?

**Direct answer:** for FETCH/XHR triggering, no. For DOM event-derived behavioral signals (mousemove, click, keydown), yes — but those are unrelated to `fetch()` semantics.

**Evidence:**
- [MDN Event.isTrusted](https://developer.mozilla.org/en-US/docs/Web/API/Event/isTrusted): the property tracks whether an *event* was dispatched by the user agent (true) or via `EventTarget.dispatchEvent()` (false). It applies to events, not to fetches.
- A `fetch()` call is a programmatic action and **has no triggering event** in its API surface. There is no `event.isTrusted` flag on a `fetch()`. This is true whether the fetch is fired by the SPA's own JS (e.g., a React effect) or by `page.evaluate()` — both look identical from the network and from JS introspection.
- Pass-6 (`docs/research/chase-session-pass6-deep-2026-05-07.md:35-39`) confirms: "synthetic events with `isTrusted: false` cannot be spoofed from JS." The SPA's natural fetches are also fired without `isTrusted` context (e.g., from a `useEffect`'s setTimeout chain) — meaning `bmak`'s behavioral pipeline cannot distinguish SPA-fired XHR from `page.evaluate()`-fired XHR via `isTrusted` because **neither has it**.

**The behavioral pipeline (mousemove/click/keydown) is a different question** — Akamai uses these to classify sessions as bot/human, and AmazonG's Chase windows are typically idle (no user gestures during background snapshot fetches). But this is a problem for *any* current AmazonG fetch (Stage A, B, *and* C); Stage C doesn't change it. The session has already been classified by the time we fire any `/svc/` call.

**Confidence:** high.

---

### Q8. Cookie set-cookie observability

**Direct answer:** yes, in-page fetch fully participates in the page's cookie jar. Set-Cookie on responses to `page.evaluate(fetch())` updates `document.cookie` and is read by Playwright's `context.cookies()` / `storageState()`. Currently NOT verified empirically because our capture mode doesn't record response headers.

**Evidence:**
- [MDN fetch credentials docs](https://developer.mozilla.org/en-US/docs/Web/API/Request/credentials): with `credentials: 'include'` for same-origin requests, the browser respects Set-Cookie headers. Cookie-jar updates are automatic.
- [Playwright BrowserContext docs](https://playwright.dev/docs/api/class-browsercontext): `context.cookies()` reads from the same jar that in-page JS sees via `document.cookie`. `storageState()` snapshots that jar.
- Confirmed in source: `chaseDriver.ts:421-462` (`attachSessionAutoSave`) calls `context.storageState()` to snapshot cookies + localStorage on every navigation. This is the same path that captures rotated `_abck` values from SPA-fired XHRs today; in-page `page.evaluate(fetch())` rotations would land in the same place.

**Capture-side gap:** AmazonG's `attachChaseXhrCapture` at `chaseDriver.ts:1868-1931` records only `reqHeaders` on requests and `status`/`contentType`/`bodyLen`/`body` on responses. It does **NOT record `respHeaders`**, so we can't directly verify Set-Cookie rotation from the existing JSONLs. (Pass-3 #3.3 — "capture Set-Cookie headers in research mode" — flagged this as an enhancement; not yet shipped.)

**Recommendation for empirical follow-up:** before shipping Stage C, extend `attachChaseXhrCapture` to log `respHeaders` on `/svc/` responses. One run with Stage B + this enhancement will confirm `_abck` rotation cadence under normal SPA traffic, giving a baseline for Stage C testing.

**Confidence:** high (mechanism); the empirical verification is just deferred to a future capture run.

---

### Q9. CDP detection orthogonality

**Direct answer:** confirmed orthogonal. Whether AmazonG uses passive `page.on('response')` listening or active `page.evaluate(fetch())` does NOT change CDP-detection surface. The CDP attachment itself is the detected artifact, not the specific commands sent over it.

**Evidence:**
- [Rebrowser CDP detection writeup](https://rebrowser.net/blog/how-to-fix-runtime-enable-cdp-detection-of-puppeteer-playwright-and-other-automation-libraries): "The CDP detection technique is really used by major companies like Akamai and is probably in all anti-bot arsenals... `Runtime.enable` allows getting events from the browser from the Runtime domain" — the detection signal is `Runtime.consoleAPICalled` event behavior triggered by `Runtime.enable`, which is sent by Playwright on attach regardless of whether `page.evaluate()` is later called.
- Patchright / noDriver / Botasaurus all target the *attachment* surface (Runtime.enable suppression, Target IDs, etc.), not specific evaluate calls. Confirms detection is at attach-time, not call-time.

**Implication:** AmazonG's Chase pipeline is already CDP-attached today (Playwright). Whether Stage B (passive listener) or Stage C (page.evaluate fetch) is used, the same Runtime.enable signal exists. **Stage C does not increase CDP-detection surface.**

**Confidence:** high.

---

## Confidence scorecard

| Question | Claim | Confidence |
|---|---|---|
| Q1 | `_abck` is stable enough to fetch after the SPA's first natural `/svc/dashboard/module/list` lands (~2.5s post-DCL) | medium |
| Q1 | `_abck` is *not* in a stable state immediately on `domcontentloaded` | low-medium (no direct empirical) |
| Q2 | SPA's natural pattern bursts up to 5 XHRs in 313ms | high (2 captures, reproducible) |
| Q2 | A 14-fetch `Promise.all` would specifically trip Chase's rate policy | unknown (no empirical, no public threshold) |
| Q3 | The SPA emits unique `x-jpmc-client-request-id` UUIDs per request | high (18/18 unique in JSONL) |
| Q3 | `x-jpmc-client-request-id` is currently optional for `/svc/rr/.../menu/list` | medium-high (production keepalive returns 200 without it) |
| Q3 | All other headers we emit (csrf, channel, content-type) are correct | high |
| Q4 | Threshold for parallel-burst-rate-limit on `/svc/dashboard/module/list` | unknown |
| Q4 | A concurrency cap of 6-8 per `Promise.all` batch is plausibly safe | medium |
| Q5 | Same-origin in-page `fetch()` shares the page's cookie jar | high |
| Q5 | Stage C does not increase cross-launch cookie-replay risk above Stage B | high |
| Q6 | Backend tracks `x-jpmc-client-request-id` in logs/tracing | medium-high (inference; auto-generation pattern + 18/18 uniqueness) |
| Q7 | `fetch()` has no `isTrusted` flag; SPA-fired and evaluate-fired are network-indistinguishable | high |
| Q8 | Set-Cookie on in-page fetch updates `context.cookies()`/`storageState()` | high (mechanism); empirically unverified for our specific case |
| Q9 | CDP-detection surface is at-attach, orthogonal to evaluate vs listen | high |

---

## Concrete recommendations

### Ship as proposed (no extra risk vs Stage B)

1. **Stage C is anti-bot-equivalent to Stage B** at the network/cookie layer. Same TLS, same cookies, same headers (modulo Q6 below).
2. **Keep the existing Akamai-cookie-restore behavior** (`chaseDriver.ts:255-278`) — pass-3's filter was reverted because it made things worse. Stage C does not require changing this.
3. **CDP-detection is unchanged** (Q9) — Stage B already pays this cost.

### Defense-in-depth tweaks (cheap, recommended)

4. **Add `x-jpmc-client-request-id: <crypto.randomUUID()>` to every Stage C fetch.** Matches the SPA's natural emission. ~5 LOC. Also back-port to the existing keepalive at `chaseDriver.ts:1652-1665`.
5. **Gate Stage C on the SPA's first natural `/svc/dashboard/module/list` having landed.** Reuse the existing Stage B passive listener (`chaseDriver.ts:1331-1349`) — once `xhrJson.dashboard !== null`, Akamai sensor pipeline has settled. Then fire the additional `Promise.all`. Costs ~1-2s per profile; eliminates the only flagged sensor-freshness risk.
6. **Cap concurrency at 6-8 per `Promise.all` batch.** For a 13-card profile, that means: batch 1 = overview + 7 rewards (8 fetches), 100-200ms gap, batch 2 = remaining 6 rewards. Wall-clock cost: ~200ms vs full-14-parallel. Risk margin: substantial.

### Verifications to run before shipping

7. **Ship `respHeaders` capture in `attachChaseXhrCapture`.** Pass-3 #3.3 already flagged this. Single run with Stage B + this enhancement gives us:
   - Empirical `_abck` rotation cadence on natural SPA traffic
   - Confirmation that Set-Cookie on responses updates `storageState()`
   - Baseline for Stage C testing
   ~10 LOC change in `attachChaseXhrCapture`.

8. **One sacrificial Stage C test run.** With the above instrumentation, fire Stage C against a single profile with the most cards. Watch for:
   - 429s on any fetch (rate limit)
   - `_abck=~0~` or `~-1~` values appearing in `respHeaders` (Akamai invalidation marker)
   - Subsequent fetch failures
   If any of those fire, fall back to staged batching (rec #6) or to Stage B.

### Things to NOT do

9. **Don't fire Stage C immediately on `domcontentloaded`.** Race risk per Q1.
10. **Don't omit `credentials: 'include'`.** Same-origin `fetch()` defaults to `same-origin`, which would technically work for `secure.chase.com → secure.chase.com`, but explicit `include` is correct semantics and matches the Stage C plan.
11. **Don't try to proxy or rewrite Stage C through `context.request.get()`.** Pass-2 ruled this out — Node TLS / JA3 mismatch is the failure mode that motivated the `page.evaluate(fetch())` approach in the first place.
12. **Don't increase parallelism above the SPA's empirical organic burst max** without further capture work. The SPA's natural bursts are 4-5 XHRs in 188-313ms windows; staying within that envelope is the safest baseline.

---

## What's still unknown (would need empirical capture)

- **Exact Chase rate-policy thresholds** for `/svc/rl/.../dashboard/module/list` and `/svc/rr/.../rewards/v2/summary/list`. (Q4 marked unknown.)
- **`_abck` rotation cadence under bursty in-page fetch.** (Q5/Q8 — partially known via mechanism, not empirically verified for our case.)
- **Whether 14-parallel reliably succeeds** for a real 13-card profile. The MCP test in `chase-mcp-direct-fetch-2026-05-08.md` was 3-parallel and worked; 14-parallel is extrapolation.
- **The exact Chase Akamai sensor POST URL** (the random multi-segment path). Captures show no such POST in our window because we capture post-login. Would need a from-cold-launch capture with full network logging.
- **Whether the `_abck=~0~` invalidation marker is what Chase serves on bot-detection events** vs a different scheme. Public Akamai sources suggest `~0~` and `~-1~` are common; Chase-specific is unconfirmed.
- **Whether `x-jpmc-client-request-id` is enforced on payment POSTs** (only confirmed not-required for read-only menu/list).

A single instrumented run (rec #7 + #8) would resolve most of these in <5 minutes of capture time.

---

## References

### In-tree research notes
- `docs/research/chase-mcp-direct-fetch-2026-05-08.md` — the Stage C finding being audited
- `docs/research/chase-perf-pass3-roadmap-2026-05-07.md` — Akamai cookie filter (proposed, then reverted)
- `docs/research/chase-perf-pass4-deep-research-2026-05-07.md` — pass-4 round 1, Akamai mechanics
- `docs/research/chase-session-pass6-deep-2026-05-07.md` — pass-6 round 1, sensor mechanics + keepalive design
- `docs/research/chase-xhr-capture-findings-2026-05-07.md` — original Stage B XHR capture findings
- `docs/research/chase-session-lifetime-pass5-2026-05-07.md` — pass-5 capture instrumentation roadmap

### In-tree code
- `src/main/chaseDriver.ts:131-145` — cookie restoration
- `src/main/chaseDriver.ts:255-278` — Akamai cookie filter history (revert documentation)
- `src/main/chaseDriver.ts:1331-1349` — Stage B passive XHR listener
- `src/main/chaseDriver.ts:1622-1694` — `attachChaseKeepalive` — already shipping `page.evaluate(fetch())` pattern
- `src/main/chaseDriver.ts:1868-1931` — `attachChaseXhrCapture` — current capture mode (no respHeaders)

### JSONL captures consulted
- `research-logs/chase-xhr-54f1867e-30ba-4cd9-8b6b-7acdc094428b-2026-05-07T22-34-50-219Z.jsonl` — full request headers + response bodies; 18 unique `/svc/` calls
- `research-logs/chase-full-54f1867e-30ba-4cd9-8b6b-7acdc094428b-2026-05-08T14-48-31-553Z.jsonl` — second capture, confirms reproducible burst pattern
- `.research/dashboard-module-list-overview.json` — captured overview body (the new finding's evidence)

### External / web sources
- [Akamai Bot Manager product overview](https://www.akamai.com/products/bot-manager)
- [Akamai rate-policy options](https://techdocs.akamai.com/terraform/docs/rate-policy-options) — rate-policy parameter shapes (averageThreshold, burstThreshold, burstWindow)
- [Akamai detection methods](https://techdocs.akamai.com/cloud-security/docs/detection-methods)
- [Hyper Solutions Akamai docs](https://docs.hypersolutions.co/akamai-web/getting-started) — "3 sensors to validity" and POST mechanics
- [Scrapfly Akamai bypass](https://scrapfly.io/bypass/akamai) — TLS fingerprinting, `_abck` mechanics
- [Scrapfly: How to bypass Akamai 2026](https://scrapfly.io/blog/posts/how-to-bypass-akamai-anti-scraping) — TLS as primary detection in 2026
- [ScrapeBadger Akamai bypass](https://scrapebadger.com/akamai-bypass)
- [Captain Compliance _abck explainer](https://captaincompliance.com/education/_abck/) — cookie structure and invalidation
- [Kameleo _abck glossary](https://kameleo.io/glossary/akamai-abck-cookie) — stateful fingerprint token
- [glizzykingdreko v3 sensor data deep dive](https://medium.com/@glizzykingdreko/akamai-v3-sensor-data-deep-dive-into-encryption-decryption-and-bypass-tools-da0adad2a784)
- [Edioff/akamai-analysis (GitHub)](https://github.com/Edioff/akamai-analysis) — enterprise anti-bot analysis
- [Rebrowser CDP-detection writeup](https://rebrowser.net/blog/how-to-fix-runtime-enable-cdp-detection-of-puppeteer-playwright-and-other-automation-libraries) — Runtime.enable detection orthogonality
- [MDN Event.isTrusted](https://developer.mozilla.org/en-US/docs/Web/API/Event/isTrusted)
- [MDN Request.credentials](https://developer.mozilla.org/en-US/docs/Web/API/Request/credentials)
- [MDN Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)
- [MDN Using Fetch](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch)
- [Playwright BrowserContext docs](https://playwright.dev/docs/api/class-browsercontext)
- [MaxxRK chaseinvest-api (GitHub)](https://github.com/MaxxRK/chaseinvest-api) — only public Chase-reverse-engineering repo; uses Playwright for scraping
