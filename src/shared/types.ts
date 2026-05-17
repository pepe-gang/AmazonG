export type AutoGJob = {
  id: string;
  /**
   * cancel_fillers — per-Amazon-account batch claim that drives the
   * FillerCancelTask state machine. The job carries
   * `placedEmail` (the account that placed the original buy) and
   * `buyJobId` (the parent buy). Worker queries
   * GET /api/autog/filler-cancel-tasks?jobId=<id> to fetch the
   * pending tasks, processes each, and reports per-task signal
   * updates back via the standard /jobs/[id]/status route.
   */
  phase: 'buy' | 'verify' | 'fetch_tracking' | 'cancel_fillers';
  dealTitle: string | null;
  dealKey: string | null;
  /** Human-readable BG deal id (e.g. "DL-04260029"). Joined server-side. */
  dealId: string | null;
  productUrl: string;
  maxPrice: number | null;
  /** BG's current deal price (what the user gets paid — "Payout" column). */
  price: number | null;
  quantity: number;
  commitmentId: string | null;
  attempts: number;
  buyJobId: string | null;
  placedOrderId: string | null;
  placedEmail: string | null;
  viaFiller: boolean;
  /** Per-job override for the min-cashback gate. When false, the worker
   *  skips its 6%-CB check at /spc time for this specific job, regardless
   *  of the per-account `requireMinCashback` setting. Default true. */
  requireMinCashback: boolean;
  /** Per-job override for the checkout price-cap gate. When true, the
   *  worker skips `verifyCheckoutPrice` at /spc and proceeds straight to
   *  Place Order. Set on the BG manual Trigger panel via the "Bypass
   *  price check" checkbox. Independent of requireMinCashback. Default
   *  false (safe — enforce the cap). */
  bypassPriceCheck: boolean;
};

export type ProductCondition = 'new' | 'used' | 'renewed';

export type CheckoutInfo = {
  placeOrderReady: boolean;
  cashbackPct: number | null;
  finalPrice: number | null;
  finalPriceText: string | null;
};

export type OrderConfirmation = {
  orderId: string | null;
  finalPriceText: string | null;
  finalPrice: number | null;
  /** Qty as shown on the thankyou page's `.checkout-quantity-badge` image
   *  badge. Null when the badge is absent (Amazon hides it for qty=1). */
  quantity: number | null;
};

export type BuyResult =
  | {
      ok: true;
      dryRun: boolean;
      orderId: string | null;
      /**
       * Amazon's checkout-session ID from the thank-you URL (`?purchaseId=`).
       * **Distinct from `orderId`** — Amazon's number-spaces don't overlap.
       * One per Place Order click; persists across cart fan-out (multiple
       * orders share one purchaseId). Captured here at order-placement
       * because Amazon does NOT expose this correlation on any
       * post-checkout endpoint — see `docs/research/amazon-pipeline.md`.
       * Useful only for audit / cross-reference; never use for order lookup.
       */
      amazonPurchaseId: string | null;
      finalPrice: number | null;
      finalPriceText: string | null;
      cashbackPct: number | null;
      /** Actual qty selected at /spc (max numeric option from the dropdown, 1 if no dropdown). */
      quantity: number;
    }
  | {
      ok: false;
      stage:
        | 'buy_click'
        | 'checkout_wait'
        | 'item_unavailable'
        | 'checkout_price'
        | 'checkout_address'
        | 'checkout_payment'
        | 'cashback_gate'
        | 'place_order'
        | 'confirm_parse'
        // Filler-mode specific stages. Keeping them here (rather than a
        // separate union) lets the worker loop handle filler and normal
        // buys with the same BuyResult surface — just different stage
        // labels in logs.
        | 'clear_cart'
        | 'product_verify'
        | 'buy_now_click'
        | 'buy_now_nav'
        | 'cart_verify'
        | 'proceed_checkout'
        | 'spc_wait'
        | 'spc_ready'
        // Filler-search rate-limit: every term in the configured pool
        // (and the in-attempt fallback pool) hit Amazon's meta-refresh
        // stub on /s?k=... — we'd ship a naked cart to /spc with just
        // the target item. Fail-fast here instead so the outer retry
        // doesn't fire (cashback_gate retries don't help when there
        // are no fillers to retry with) and the row's error reads
        // clearly in the BG dashboard.
        | 'filler_search';
      reason: string;
      detail?: string;
    };

export type ProductInfo = {
  url: string;
  title: string | null;
  price: number | null;
  priceText: string | null;
  cashbackPct: number | null;
  inStock: boolean;
  availabilityText: string | null;
  condition: ProductCondition | null;
  shipsToAddress: boolean | null;
  isPrime: boolean | null;
  hasBuyNow: boolean | null;
  /** Add-to-Cart fallback. Some product pages (Echo Dot, certain Prime
   *  exclusives) hide Buy Now entirely and surface only Add to Cart.
   *  Set true when the page exposes a clickable Add to Cart, false when
   *  we have a product UI but no add-to-cart, null when indeterminate. */
  hasAddToCart: boolean | null;
  /** Whether the Amazon header reads "Hello, <name>" (signed in) versus
   *  "Hello, sign in" (signed out). Critical to check before every other
   *  buy-box constraint — when signed out, Amazon hides the Prime badge
   *  and Buy Now button regardless of the product's actual eligibility,
   *  so downstream checks would surface misleading reasons like
   *  not_prime / no_buy_now. Null when indeterminate (nav not rendered). */
  isSignedIn: boolean | null;
  buyBlocker: string | null;
};

/**
 * Per-FillerCancelTask signal update sent by the cancel_fillers worker.
 * Mirrors the `FillerCancelTaskUpdate` shape in BG's
 * `src/lib/fillerCancelOrchestration.ts`. Each entry maps to one task
 * the worker processed in this batch — BG runs each through the pure
 * state machine to compute the resulting transition.
 */
export type FillerCancelTaskUpdate = {
  taskId: string;
  signal:
    | 'cancel_confirmed'
    | 'cancel_unable'
    | 'order_already_cancelled'
    | 'order_shipped_detected'
    | 'order_not_found'
    | 'tracking_codes_received'
    | 'tracking_unavailable'
    | 'tracking_submitted'
    | 'transient_error'
    | 'profile_signed_out'
    | 'wall_clock_expired'
    | 'danger_target_in_order';
  trackingIds?: string[];
  bgAccepted?: number;
  bgDuplicates?: number;
  bgUnmatched?: number;
  bgAccountId?: string | null;
  bgSubmissionStatus?: string | null;
  bgSubmissionError?: string | null;
};

/**
 * One FillerCancelTask as returned by GET /api/autog/filler-cancel-tasks.
 * The worker uses this list to know what work to do for the just-claimed
 * cancel_fillers job. `expiredSafetyNet=true` means the row aged past
 * its wall-clock cap (7d for pending_cancel, 14d for pending_tracking)
 * — the worker reports it back as `wall_clock_expired` without an
 * Amazon round-trip.
 */
export type ServerFillerCancelTask = {
  taskId: string;
  amazonOrderId: string;
  targetAsin: string | null;
  status:
    | 'pending_cancel'
    | 'pending_tracking';
  attempts: number;
  expiredSafetyNet: boolean;
  autoBuyPurchaseId: string;
  buyJobOrderId: string | null;
  lastError: string | null;
  lastSignal: string | null;
};

/** Payload shape accepted by POST /api/autog/jobs/[id]/status */
export type JobStatusReport = {
  status: 'in_progress' | 'awaiting_verification' | 'pending_tracking' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'action_required';
  error?: string | null;
  placedAt?: string | null;
  placedQuantity?: number | null;
  placedCashbackPct?: number | null;
  placedPrice?: string | null;
  placedEmail?: string | null;
  placedOrderId?: string | null;
  /** Carrier tracking codes collected by a fetch_tracking job. One order
   *  can split into multiple shipments (qty=3 MacBooks → 3 codes). */
  trackingIds?: string[] | null;
  /** Verify-phase only: surgical correction to AutoBuyPurchase.purchasedCount
   *  for the (buyJobId, placedEmail) match. Set by verifyOrder when the
   *  order-details page reports a different qty than what was captured
   *  at buy time (e.g. /spc-DOM-read returning 1 when Amazon actually
   *  placed 2). BG updates ONLY purchasedCount — leaves status, orderId,
   *  trackingIds, and other fields untouched. */
  correctPurchasedCount?: number | null;
  /** True when Amazon's order-details page shows "Payment revision needed"
   *  (card declined, order parked awaiting a re-charge). The order is
   *  technically active but won't ship until the user revises payment.
   *  Forwarded by both verify and fetch_tracking jobs. BG persists this
   *  on AutoBuyPurchase so the dashboard keeps the row in the Pending
   *  bucket — Amazon won't ship → no tracking will arrive → don't show
   *  it as Success on the back of a passing verify alone. */
  paymentRevisionRequired?: boolean;
  /** Outcome of the verify-phase `cancelNonTargetItems` call against the
   *  target order. Reported when `runVerifyFillerCleanup` actually ran
   *  (i.e. target survived verify as 'active' and filler-mode buy). BG
   *  persists `targetOrderHasUncancelledFillers = !cleaned` and the
   *  reason on AutoBuyPurchase; the dashboard surfaces target orders
   *  with `cleaned=false` in the "Uncancelled filler orders" list so
   *  the user knows to return the bundled fillers manually.
   *
   *  Omit (undefined) when cleanup didn't run — non-filler buy, target
   *  was already cancelled, verify errored/timed out. BG handler treats
   *  undefined as no-op (preserves prior state). */
  targetOrderCleanupOutcome?: {
    cleaned: boolean;
    error: string | null;
    /**
     * True when cancelNonTargetItems reported
     * `code: 'target_absent_from_cancel_page'` — the cancel page
     * surfaces sibling items but NOT the target's checkbox. This is
     * the canonical signal that the target was cancelled (by Amazon
     * or the user) while fillers in the same order are still active.
     *
     * BG flips purchase.status to `target_cancelled` when this is
     * true, so the dashboard can stop showing the row as a successful
     * buy and instead surface the "fillers will ship without the
     * target" outcome for manual follow-up.
     *
     * Only sent when cleanup ran on a still-active target order;
     * false on the normal "fillers stuck inside target" path.
     */
    targetCancelledInsideActiveOrder?: boolean;
  };
  purchases?: {
    amazonEmail: string;
    status: 'queued' | 'in_progress' | 'awaiting_verification' | 'pending_tracking' | 'completed' | 'failed' | 'cancelled' | 'action_required';
    /**
     * When true, this purchase used the "Buy with Fillers" flow (cart
     * padded with random items). BG reads this flag to decide whether
     * to set `viaFiller=true` on the scheduled verify job — which
     * triggers AmazonG's filler-cancellation cleanup on the verify-
     * phase run.
     */
    viaFiller?: boolean;
    purchasedCount?: number;
    orderId?: string | null;
    error?: string | null;
    /**
     * Structured failure category from BuyResult.stage (e.g.
     * 'cashback_gate', 'item_unavailable', 'place_order'). Forwarded so
     * BG can route follow-up actions like auto-rebuy with fillers on
     * cashback_gate failures without text-matching the human-readable
     * error string. Omitted on success / dry-run / pre-buy verify
     * failures (no buy stage to report).
     */
    stage?: string | null;
    placedAt?: string | null;
    placedCashbackPct?: number | null;
    placedPrice?: string | null;
    trackingIds?: string[] | null;
    /**
     * Audit snapshot: every Amazon order id from the Place Order fan-out
     * that does NOT contain the target ASIN. BG persists these on the
     * purchase row for manual reconciliation — AutoG cancels each one
     * inline + in verify phase, but if anything slips through the user
     * needs a list to cross-check against Amazon Your Orders. Omit on
     * single-mode purchases.
     */
    fillerOrderIds?: string[] | null;
    /**
     * Amazon's checkout-session ID from the thank-you URL (`?purchaseId=`).
     * Distinct from `orderId`; one per Place Order click, persists across
     * fan-out splits. Audit-only — Amazon does NOT expose a purchaseId↔
     * orderId mapping endpoint, so AmazonG must capture this at the time
     * of the click or it's permanently lost. See
     * `docs/research/amazon-pipeline.md` for the empirical research
     * behind this field.
     */
    amazonPurchaseId?: string | null;
    /**
     * ASIN of the deal item this filler buy was for. Snapshotted by the
     * worker at buy time (parsed from productUrl) and forwarded to BG
     * so each FillerCancelTask row stores it. The cancel worker
     * re-verifies on every attempt that the filler order does NOT
     * contain this ASIN before clicking Cancel — defense against a
     * parser bug that would otherwise cancel the user's actual deal
     * order. Optional; omitted on non-filler buys.
     */
    targetAsin?: string | null;
  }[];
  /**
   * Per-task signal updates from a `cancel_fillers` worker batch. Only
   * sent when reporting back from a cancel_fillers job. Each update
   * runs through BG's pure state machine and either transitions the
   * task to a new state (cancelled / pending_tracking / tracked / etc.)
   * or schedules a retry (`transient_error`, `profile_signed_out`).
   */
  fillerCancelTaskUpdates?: FillerCancelTaskUpdate[];
};

export type FetchTrackingOutcome =
  | { kind: 'tracked'; trackingIds: string[]; paymentRevisionRequired?: boolean }
  | { kind: 'partial'; trackingIds: string[]; paymentRevisionRequired?: boolean }
  | { kind: 'not_shipped'; paymentRevisionRequired?: boolean }
  | { kind: 'retry'; reason: 'verify_error' | 'verify_timeout' }
  /** verifyOrder (or this function's order-details fetch) was redirected
   *  to /ap/signin — the account's session is dead. Caller flips the
   *  profile's loggedIn flag and surfaces the cause; nothing to retry
   *  until the user re-signs-in. */
  | { kind: 'signed_out'; landedUrl: string }
  | { kind: 'cancelled'; reason: string };

export type IdentityInfo = {
  userEmail: string;
  last4: string;
  keyCreatedAt: string;
};

/** A BG receiving address saved against a specific Amazon profile.
 *  AutoG types these values into Amazon's /a/addresses/add form when
 *  the user clicks "Add BG Address" on the profile row, or when a
 *  buy-flow's address picker can't find a matching saved address.
 *  Per-Amazon-account — different accounts often ship to different
 *  BG receivers. All fields required except `street2` (apartment /
 *  suite number — usually empty for BG warehouses). */
export type BGAddress = {
  fullName: string;
  phone: string;
  street1: string;
  street2: string | null;
  city: string;
  state: string;
  zip: string;
};

export type AmazonProfile = {
  email: string;
  displayName: string | null;
  /**
   * Master per-account participation flag. When false, the worker
   * skips this account on EVERY phase (buy, verify, fetch_tracking).
   * Use this to fully take an account out of the worker pool — e.g.,
   * the account is signed-out, flagged by Amazon, on a temporary
   * pause, etc. Defaults to true.
   *
   * Distinct from `autoBuy`: `enabled` is "is this account live at
   * all"; `autoBuy` (when `enabled` is true) is "should it claim new
   * buy jobs". To pause buys but keep verify/tracking running for
   * existing orders, set `enabled: true, autoBuy: false`.
   */
  enabled: boolean;
  /**
   * When true (and `enabled` is also true), this account claims new
   * buy-phase jobs. When false (with `enabled: true`), the worker
   * SKIPS new buys for this account but still runs verify and
   * fetch_tracking phases for orders this account already placed.
   *
   * Use this to temporarily stop new buys without taking the account
   * out of the worker pool entirely (e.g., card declined, hit daily
   * cap, taking a break). Defaults to true.
   *
   * Loaded with backfill default `true` for existing profiles whose
   * stored JSON predates this field — see profiles.ts.
   */
  autoBuy: boolean;
  addedAt: string;
  lastLoginAt: string | null;
  loggedIn: boolean;
  /**
   * Whether Chromium runs headless for this account. true = invisible
   * (default, faster); false = show the Chromium window (useful for
   * debugging a specific account). Settable per-account via the toggle
   * on the account card.
   */
  headless: boolean;
  /**
   * Whether this account uses the "Buy with Fillers" checkout flow
   * (cart the target + ~10 random Prime fillers, place the order, then
   * cancel the fillers after verify). Defaults to false; settable per-
   * account via the toggle on the account card. The master toggle on the
   * settings screen cascades this field across every profile.
   */
  buyWithFillers: boolean;
  /**
   * BG receiving address to type into Amazon's /a/addresses/add form
   * for this account. Null when the user hasn't configured an address
   * for this profile — the "Add BG Address" button is hidden and
   * auto-recovery on address-picker fail is skipped.
   */
  bgAddress: BGAddress | null;
  /**
   * Id of the saved payment card (cardVault) this account should use.
   * Null when none is assigned. Multiple accounts may reference the
   * same card id — it's just a pointer into the vault, so sharing is
   * free. Settable per-account via the card dropdown on the account
   * row. Synced across machines via the cross-device sync.
   */
  cardId: string | null;
};

/**
 * Chase login profile — entirely local to the desktop. No BG sync, no
 * remote storage. Cookies + storage persist across launches in the
 * per-profile Playwright user-data dir under
 * `userData/chase-profiles/{id}/`, so a returning user typically
 * doesn't need to re-2FA every session.
 *
 * Fields:
 *   - id            UUID generated locally; opaque to the user
 *   - label         human-readable name ("Personal Chase", "Business Chase")
 *   - loggedIn      true once the manual login flow saw Chase route to
 *                   the card-summary URL. Stale on its own — the
 *                   persistent context might still have a valid session
 *                   even if "Re-login" was never clicked again, or the
 *                   server may have invalidated the session before the
 *                   user opened the Bank tab.
 *   - lastLoginAt   ISO timestamp of the most recent successful login;
 *                   null if never logged in
 *   - createdAt     ISO timestamp the profile row was added
 */
export type ChaseProfile = {
  id: string;
  label: string;
  loggedIn: boolean;
  lastLoginAt: string | null;
  /**
   * Chase's internal numeric id for the credit card this profile is
   * tracking. Captured during login from the URL the user lands on
   * after clicking into a specific card
   * (.../dashboard/summary/<id>/CARD/BAC). Null until first successful
   * login. Persisted so subsequent flows (list cards, redeem points,
   * pay statement) know which card to operate on without making the
   * user re-pick.
   */
  cardAccountId: string | null;
  /**
   * Auto-redeem schedule. When `enabled` is true, the main-process
   * scheduler triggers redeemAllToStatementCredit at `time` daily.
   * Defaults to disabled with time "15:00" (3 PM local) — set when
   * the user toggles the switch in the Bank tab.
   *
   * Skip-today-on-enable semantics: when a user flips `enabled` from
   * false → true and today's scheduled time has already passed, the
   * scheduler waits until tomorrow's window instead of firing
   * immediately. Implemented by stamping `lastRunAt` to start-of-today
   * on the enable transition. Prevents the "I enabled it at 11 PM and
   * it ran my whole points balance immediately" surprise.
   *
   * Optional on the type so older profiles persisted before this
   * field shipped parse cleanly — loader backfills with disabled
   * defaults.
   */
  autoRedeem?: {
    enabled: boolean;
    /** "HH:MM" 24h, local timezone. */
    time: string;
    lastRunAt: string | null;
    lastRunResult: 'ok' | 'no_points' | 'error' | null;
    lastRunError: string | null;
  };
  createdAt: string;
};

/** Outcome shape for chaseLogin IPC. The `cancelled` reason is
 *  surfaced separately from generic failures so the UI can render it
 *  as a neutral state ("you closed the window") rather than an error. */
export type ChaseLoginResult =
  | { ok: true }
  | { ok: false; reason: string; cancelled?: boolean };

/** Outcome shape for chaseRedeemAll IPC. On success, the renderer can
 *  print "Redeemed $X as statement credit (order …)".
 *  On failure, `kind` distinguishes "0 points" (informational, neutral
 *  styling) from any real error (red error styling). */
export type ChaseRedeemResult =
  | {
      ok: true;
      orderNumber: string;
      amount: string;
      pointsRedeemed: string;
    }
  | {
      ok: false;
      kind: 'no_points' | 'error';
      reason: string;
    };

/** One historical redemption row, persisted to disk per profile and
 *  surfaced via chaseRedeemHistory IPC. ts is ISO-8601; amount is the
 *  raw "$704.73" Chase showed on the success page. */
export type ChaseRedeemEntry = {
  ts: string;
  orderNumber: string;
  amount: string;
  pointsRedeemed: string;
};

/** Cached card snapshot (rewards points + current credit balance +
 *  in-process payments) scraped from a profile's signed-in Chase
 *  session. Persisted to userData/chase-account-snapshots.json so
 *  the Bank tab can render immediately on mount without re-fetching
 *  every time. */
export type ChaseAccountSnapshot = {
  /** Header text from /chaseloyalty home, e.g. "70,473 pts". Empty
   *  if the scrape couldn't locate it. */
  pointsBalance: string;
  /** Dollar amount from the secure.chase.com card summary page,
   *  e.g. "$1,234.56". Empty if the scrape couldn't locate it. */
  creditBalance: string;
  /** "Pending charges" total from the same summary page — the sum
   *  of authorized-but-not-posted activity that's about to push the
   *  balance up. e.g. "$11,758.95". Empty when there's no pending
   *  block on the page (no pending activity). Optional for backwards-
   *  compat; renderers should treat undefined as empty. */
  pendingCharges?: string;
  /** "Available credit" from the recon row on the summary page —
   *  what the user has left to spend before hitting the credit limit
   *  (credit limit minus current balance minus pending), e.g.
   *  "$18,709.67". Empty when the recon row didn't surface it.
   *  Optional for backwards-compat with snapshots written before this
   *  field existed; renderers should treat undefined as empty. */
  availableCredit?: string;
  /** Payments scraped from the secure.chase.com payment-activity page
   *  whose status is "In process" / "Pending" / "Scheduled" / similar
   *  not-yet-completed value. Newest first by Chase's own ordering.
   *  Optional for backwards-compat with snapshots persisted before
   *  this field existed; renderers should treat undefined as []. */
  inProcessPayments?: ChasePaymentEntry[];
  /** Card lock status from Chase's overview JSON, e.g. "UNLOCKED",
   *  "LOCKED", "TEMPORARILY_LOCKED". Stage C populates this from
   *  /svc/rl/.../dashboard/module/list (overview) — optional because
   *  Stage B doesn't surface it and old snapshots persisted before
   *  Stage C don't have it. Renderers should treat undefined as
   *  "unknown" and not show a lock indicator. */
  lockStatus?: string;
  /** Auto-pay enrollment flag from Chase's overview JSON. Optional
   *  for the same reason as lockStatus. Renderers should hide the
   *  auto-pay badge when undefined. */
  autoPayEnrolled?: boolean;
  /** ISO-8601 of when the snapshot was captured. */
  fetchedAt: string;
};

/** One row from the secure.chase.com payment-activity table. We keep
 *  the displayed strings verbatim (no Date parsing, no amount math)
 *  — the Bank tab renders them as-is, and Chase's formatting is
 *  the user's mental model. */
export type ChasePaymentEntry = {
  /** "Apr 25, 2026" */
  date: string;
  /** "In process", "Pending", "Scheduled", "Completed", etc. */
  status: string;
  /** "$13,000.00" with sign + commas preserved. */
  amount: string;
};

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export type LogEvent = {
  ts: string;
  level: LogLevel;
  correlationId?: string;
  message: string;
  data?: Record<string, unknown>;
};

export type RendererStatus = {
  connected: boolean;
  running: boolean;
  identity: IdentityInfo | null;
  lastError: string | null;
};

export type JobAttemptStatus =
  | 'queued'
  | 'in_progress'
  /** Buy succeeded; waiting for the verify-phase job (~10 min later) to
   *  confirm Amazon didn't silently auto-cancel the order. */
  | 'awaiting_verification'
  /** Verify-phase confirmed the order is still active in Amazon's order
   *  history — final happy outcome for a buy attempt. */
  | 'verified'
  /** Verify-phase found the order was cancelled by Amazon after we placed
   *  it (auto-cancel, fraud filter, stock change). */
  | 'cancelled_by_amazon'
  /** Used by verify-phase rows themselves (the row that ran the check)
   *  and by legacy buy attempts pre-verify-phase. */
  | 'completed'
  | 'failed'
  /** The bot couldn't proceed and a human needs to step in. Distinct
   *  from `failed` so users can quickly find rows they personally need
   *  to act on (re-login, satisfy a card-verification challenge, etc.)
   *  rather than rows that failed for product-side reasons (oos, price,
   *  etc.). Set when verify reports `signed_out` or buyNow hits the
   *  PMTS "Verify your card" challenge. */
  | 'action_required'
  | 'dry_run_success';

export type JobAttempt = {
  attemptId: string;
  jobId: string;
  amazonEmail: string;
  phase: 'buy' | 'verify' | 'fetch_tracking';
  dealKey: string | null;
  /** Human-readable BG deal id (e.g. "DL-04260029"). Displayed in the Jobs table. */
  dealId: string | null;
  dealTitle: string | null;
  productUrl: string;
  /** BG-specified retail / max-pay cap for this deal (null when BG didn't set one). */
  maxPrice: number | null;
  /** BG's current deal price (what the user gets paid — "Payout" column). */
  price: number | null;
  /** Target quantity BG asked us to check out. */
  quantity: number | null;
  cost: string | null;
  cashbackPct: number | null;
  orderId: string | null;
  status: JobAttemptStatus;
  error: string | null;
  buyMode: 'single' | 'filler';
  dryRun: boolean;
  /** Carrier tracking codes collected by fetch_tracking. Null until the
   *  fetch_tracking loop runs; empty array if the loop ran but Amazon
   *  hasn't shipped anything yet. */
  trackingIds: string[] | null;
  /**
   * For filler-mode buys: every order id that came out of this Place
   * Order click and does NOT contain the target ASIN. Persisted on the
   * buy attempt so the verify phase (~10 min later) can re-check each
   * one and retry cancelling any that slipped through the immediate
   * post-placement sweep. Null on single-mode buys.
   */
  fillerOrderIds: string[] | null;
  /**
   * For filler-mode buys: the FULL cart ASIN list at the time of the
   * Place Order click (target + every committed filler). Persisted so
   * the verify phase can RE-SCAN order history with the full list and
   * catch any filler-only orders that hadn't propagated yet at buy
   * time — INC-2026-05-10 (purchaseId 106-0543366-6065024) had a
   * filler-only order 114-4485329-7352228 that was missing from
   * `fillerOrderIds` because it propagated after our buy-time scan
   * completed. Null on single-mode buys + on pre-feature attempts
   * still in the local store.
   */
  cartAsins: string[] | null;
  /**
   * For filler-mode buys: the pre-buy order-history snapshot — every
   * order id visible on /gp/css/order-history BEFORE Place Order was
   * clicked. Captured at buy time and persisted so the verify-phase
   * rescan (~10 min later) can use snapshot-DIFF instead of the legacy
   * ASIN-walker that bled cross-deal contamination (a 2-day-old order
   * containing the same ASIN as today's filler would be falsely
   * attributed to today's buy). Empty array OK — means snapshot was
   * captured but order history was empty. Null = no snapshot saved
   * (pre-feature attempt or non-filler buy), rescan falls back to
   * the ASIN-walker.
   */
  preBuyOrderIds: string[] | null;
  /**
   * Per-filler-order cancel state from BG's FillerCancelTask table.
   * Each task tracks one filler order id through cancel_fillers's
   * state machine. JobsTable colors each chip per status. Null on
   * single-mode buys + when running against pre-feature BG.
   */
  fillerCancelTasks: Array<{
    id: string;
    amazonOrderId: string;
    status: string;
    attempts: number;
  }> | null;
  /**
   * Target item's title as shown on /spc (Amazon's real title, not BG's
   * dealTitle). Needed by the verify phase to locate the target line
   * item on the cancel-items page when we uncheck-target-cancel-rest.
   * Chewbacca /spc hides ASINs, so title match is our primary lookup.
   */
  productTitle: string | null;
  /**
   * Fine-grained stage flag for the narrow critical window between
   * dispatching the Place Order click and confirming its outcome. Set
   * to 'placing' immediately before the click; cleared back to null
   * once Amazon's confirmation page is parsed. Any stop / crash while
   * `stage === 'placing'` is an "unknown-outcome" case (the click may
   * or may not have been accepted by Amazon), so recovery code treats
   * those rows as needs-manual-review instead of safe-to-retry.
   */
  stage: 'placing' | null;
  createdAt: string;
  updatedAt: string;
};


/**
 * One RemoteFetchJob as returned by POST /api/autog/remote-fetch/claim.
 * AmazonG's relay loop processes these — fetches the URL from the
 * desktop's IP, posts the response back. URLs are guaranteed to be
 * api.prod.buyinggroup.com (BG-side decideRelay enforces this; AmazonG
 * also re-validates as defense-in-depth).
 */
export type ServerRemoteFetchJob = {
  id: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  callTag: string;
};

/**
 * Result body posted back to /api/autog/remote-fetch/[id]/result. On
 * network/abort failures, set `error`. On any HTTP response (including
 * 4xx/5xx from buyinggroup.com), set status + headers + body — that's
 * the actual answer, not a relay failure.
 */
export type RemoteFetchResult = {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  error?: string;
  clientIp?: string;
  cloudDurationMs?: number;
};

/**
 * Per-user fetch-stats response from /api/autog/fetch-stats. Subset
 * the AmazonG header pill needs — full shape is on the BG dashboard.
 */
export type FetchStatsSummary = {
  range: 'today' | '7d' | 'lifetime';
  totals: { autog: number; cloud: number; total: number; pctAutog: number };
  liveStatus: { online: boolean; lastSeenAt: string | null; ageMs: number | null };
};

/**
 * Renderer-safe view of a stored payment card. The full card number
 * and the CVV are encrypted at rest in the main process
 * (card-vault.json via OS keychain) and NEVER cross IPC — only this
 * view does. `label` + `last4` + `expiry` are shown so the renderer
 * can render a card dropdown ("Label ···· 1234 · 12/27").
 */
export type CreditCardSafe = {
  id: string;
  label: string;
  last4: string;
  /** MM/YY, or null for legacy cards saved before the expiry field. */
  expiry: string | null;
  /** Cardholder name — shown so the edit modal can pre-fill it. */
  cardholderName: string;
  /** Billing address — non-sensitive, shown so the edit modal can
   *  pre-fill it. The card number + CVV are NOT in the safe view. */
  billingAddress: BillingAddress | null;
};

/**
 * Billing address for a saved payment card — distinct from the
 * shipping address. Typed into Amazon's card "billing address" form
 * when adding the card at checkout. `line2` may be blank.
 */
export type BillingAddress = {
  fullName: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  zip: string;
  /** ISO-ish country, e.g. 'US'. */
  country: string;
  phone: string;
};

/**
 * Fields the renderer sends to add/save a payment card. `expiry` +
 * `cvv` may be blank. The full number + CVV are encrypted in the main
 * process the instant they arrive and never persist in plaintext.
 */
export type CreditCardInput = {
  label: string;
  /** Cardholder name — typed into Amazon's "Name on card" field. */
  cardholderName: string;
  number: string;
  expiry: string;
  cvv: string;
  /** Billing address for the card. */
  billingAddress: BillingAddress;
};

/**
 * Editable fields of a saved card. The card number + CVV are
 * write-once (encrypted, can't be read back) — to change those,
 * remove and re-add the card.
 */
export type CreditCardEdit = Omit<CreditCardInput, 'number' | 'cvv'>;

/**
 * One payment card in the cross-device sync blob — carries the full
 * card number, expiry and CVV in cleartext. Main-process + BG-wire
 * only; this type must never reach the renderer (see CreditCardSafe).
 */
export type SyncCard = {
  id: string;
  label: string;
  /** Cardholder name; '' for legacy cards saved before the field. */
  cardholderName: string;
  last4: string;
  number: string;
  /** MM/YY, or null for legacy cards. */
  expiry: string | null;
  cvv: string | null;
  /** Billing address; null for legacy cards / when not provided. */
  billingAddress: BillingAddress | null;
};

/**
 * A resolved payment card ready to type into Amazon's checkout
 * "Add a credit or debit card" form. Main-process + Playwright only —
 * the full number + CVV must never reach the renderer.
 */
export type PaymentCardFill = {
  cardholderName: string;
  number: string;
  /** MM/YY. Null when the card has no expiry — Amazon's add-card form
   *  requires one, so a null-expiry card can't be auto-added. */
  expiry: string | null;
  cvv: string | null;
  /** Billing address — set as the card's billing address (distinct
   *  from the shipping address). Null when the card has none. */
  billingAddress: BillingAddress | null;
};

/**
 * Cross-device sync payload exchanged with BG's /api/autog/sync.
 * `exists` is false (and the value fields null) when the user has no
 * sync row on BG yet. `updatedAt` is BG's ISO timestamp.
 *
 * `cardAssignments` maps a lowercased Amazon-account email to the
 * cardVault card id that account uses — synced so a second machine
 * picks up the same per-account card choices.
 */
export type AutoGSyncBlob = {
  exists: boolean;
  cards: SyncCard[];
  cardAssignments: Record<string, string> | null;
  buyWithFillers: boolean | null;
  fillerAttempts: string[] | null;
  /** Synced Chase profiles — metadata only. May be absent when talking
   *  to a BG that predates this field; treat undefined as []. */
  chaseProfiles?: SyncChaseProfile[];
  updatedAt: string | null;
};

/**
 * The syncable subset of a ChaseProfile. Login/session state
 * (`loggedIn`, `lastLoginAt`, the Chrome user-data dir, auth cookies)
 * is deliberately excluded — it's machine-bound, so a synced profile
 * lands on a new device logged-out and the user does OTP once there.
 * `autoRedeem` carries only the config (enabled + time); the per-run
 * history fields stay local.
 */
export type SyncChaseProfile = {
  id: string;
  label: string;
  cardAccountId: string | null;
  autoRedeem: { enabled: boolean; time: string } | null;
  createdAt: string;
  /**
   * Chase login credentials, plaintext — synced so a new device needs
   * only the OTP step. Omitted when the profile has none saved (or the
   * local copy couldn't be decrypted). Main-process only; the renderer
   * never receives this shape.
   */
  username?: string | null;
  password?: string | null;
};
