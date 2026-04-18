export type AutoGJob = {
  id: string;
  phase: 'buy' | 'verify';
  dealTitle: string | null;
  dealKey: string | null;
  productUrl: string;
  maxPrice: number | null;
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
};

export type BuyResult =
  | {
      ok: true;
      dryRun: boolean;
      orderId: string | null;
      finalPrice: number | null;
      finalPriceText: string | null;
      cashbackPct: number | null;
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
  status: 'in_progress' | 'completed' | 'completed_with_filler_items' | 'partial' | 'failed' | 'cancelled';
  error?: string | null;
  placedAt?: string | null;
  placedQuantity?: number | null;
  placedCashbackPct?: number | null;
  placedPrice?: string | null;
  placedEmail?: string | null;
  placedOrderId?: string | null;
  purchases?: {
    amazonEmail: string;
    status: 'queued' | 'in_progress' | 'completed' | 'completed_with_filler_items' | 'failed' | 'cancelled';
    purchasedCount?: number;
    orderId?: string | null;
    error?: string | null;
    placedAt?: string | null;
    placedCashbackPct?: number | null;
    placedPrice?: string | null;
  }[];
};

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
  | 'completed'
  | 'failed'
  | 'dry_run_success';

export type JobAttempt = {
  attemptId: string;
  jobId: string;
  amazonEmail: string;
  phase: 'buy' | 'verify';
  dealKey: string | null;
  dealTitle: string | null;
  productUrl: string;
  cost: string | null;
  cashbackPct: number | null;
  orderId: string | null;
  status: JobAttemptStatus;
  error: string | null;
  dryRun: boolean;
  createdAt: string;
  updatedAt: string;
};
