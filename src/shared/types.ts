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
        | 'confirm_parse';
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
  status: 'in_progress' | 'awaiting_verification' | 'pending_tracking' | 'completed' | 'completed_with_filler_items' | 'partial' | 'failed' | 'cancelled';
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
    status: 'queued' | 'in_progress' | 'awaiting_verification' | 'pending_tracking' | 'completed' | 'completed_with_filler_items' | 'failed' | 'cancelled';
    purchasedCount?: number;
    orderId?: string | null;
    error?: string | null;
    placedAt?: string | null;
    placedCashbackPct?: number | null;
    placedPrice?: string | null;
    trackingIds?: string[] | null;
  }[];
};

export type FetchTrackingOutcome =
  | { kind: 'tracked'; trackingIds: string[] }
  | { kind: 'partial'; trackingIds: string[] }
  | { kind: 'not_shipped' }
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
  createdAt: string;
  updatedAt: string;
};
