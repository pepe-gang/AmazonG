export type AutoGJob = {
  id: string;
  phase: 'buy' | 'verify' | 'fetch_tracking';
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
        | 'spc_ready';
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
  buyBlocker: string | null;
};

/** Payload shape accepted by POST /api/autog/jobs/[id]/status */
export type JobStatusReport = {
  status: 'in_progress' | 'awaiting_verification' | 'pending_tracking' | 'completed' | 'partial' | 'failed' | 'cancelled';
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
  purchases?: {
    amazonEmail: string;
    status: 'queued' | 'in_progress' | 'awaiting_verification' | 'pending_tracking' | 'completed' | 'failed' | 'cancelled';
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
  }[];
};

export type FetchTrackingOutcome =
  | { kind: 'tracked'; trackingIds: string[]; paymentRevisionRequired?: boolean }
  | { kind: 'partial'; trackingIds: string[]; paymentRevisionRequired?: boolean }
  | { kind: 'not_shipped'; paymentRevisionRequired?: boolean }
  | { kind: 'retry'; reason: 'verify_error' | 'verify_timeout' }
  | { kind: 'cancelled'; reason: string };

export type IdentityInfo = {
  userEmail: string;
  last4: string;
  keyCreatedAt: string;
};

export type AmazonProfile = {
  email: string;
  displayName: string | null;
  enabled: boolean;
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
