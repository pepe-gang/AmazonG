import type {
  AmazonProfile,
  ChaseAccountSnapshot,
  ChaseLoginResult,
  ChaseProfile,
  ChaseRedeemEntry,
  ChaseRedeemResult,
  IdentityInfo,
  JobAttempt,
  LogEvent,
  RendererStatus,
} from './types.js';

export const IPC = {
  identityGet: 'identity:get',
  identityConnect: 'identity:connect',
  identityDisconnect: 'identity:disconnect',
  workerStart: 'worker:start',
  workerStop: 'worker:stop',
  statusGet: 'status:get',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  openExternal: 'shell:open-external',
  appVersion: 'app:version',
  versionCheck: 'version:check',

  profilesList: 'profiles:list',
  profilesAdd: 'profiles:add',
  profilesRemove: 'profiles:remove',
  profilesLogin: 'profiles:login',
  profilesRefresh: 'profiles:refresh',
  profilesSetEnabled: 'profiles:set-enabled',
  profilesSetHeadless: 'profiles:set-headless',
  profilesSetBuyWithFillers: 'profiles:set-buy-with-fillers',
  profilesRename: 'profiles:rename',
  profilesOpenOrders: 'profiles:open-orders',
  profilesOpenOrder: 'profiles:open-order',
  profilesReorder: 'profiles:reorder',
  /** Fetch the current live Amazon deals catalog from BetterBG's
   *  public endpoint (x-api-key: pepe-gang). The renderer re-fetches
   *  on user click; no polling. */
  dealsList: 'deals:list',
  /** Enqueue a buy job on BetterBG for a specific Amazon deal. Job is
   *  scoped to the authed user, invisible to any other AutoG key. */
  dealsTrigger: 'deals:trigger',
  /** Fetch the per-Amazon-account remote settings map from BG (keyed by
   *  email → { requireMinCashback, bgAccountId }) plus the user's
   *  list of BGAccounts (so the per-account dropdown can render).
   *  Renderer calls this when the Accounts tab mounts to paint the
   *  toggles + dropdown with the live state. */
  profilesRemoteSettings: 'profiles:remote-settings',
  /** Toggle the cashback gate for one Amazon account on BG. Returns the
   *  updated setting row so the caller can reconcile optimistic state. */
  profilesSetRequireMinCashback: 'profiles:set-require-min-cashback',
  /** Set or clear the per-Amazon-account tracking-submit routing target
   *  (`AmazonAccount.bgAccountId` on BG). Pass null to clear; the
   *  resolver then falls through to single-BGAccount auto-fill. */
  profilesSetBgAccount: 'profiles:set-bg-account',
  /** Live status of the scheduled auto-enqueue feature: enabled flag,
   *  configured interval, last/next run timestamps, and the in-memory
   *  result of the most recent tick (queued/skipped/failed counts). The
   *  Deals page polls this so the user can see "next run in 2h". */
  autoEnqueueStatus: 'auto-enqueue:status',
  /** Chase profile management — entirely local. List/add/remove
   *  profiles, plus a user-driven login flow that opens a Chromium
   *  window pointed at chase.com, lets the user enter credentials +
   *  any 2FA challenges by hand, and auto-closes once the post-login
   *  dashboard URL is reached. */
  chaseList: 'chase:list',
  chaseAdd: 'chase:add',
  chaseRemove: 'chase:remove',
  chaseLogin: 'chase:login',
  /** Save / overwrite username + password for one Chase profile.
   *  Encrypted at rest via OS keychain. The plaintext password
   *  never goes back over IPC; renderer can only set / clear /
   *  has (boolean check). */
  chaseCredentialsSet: 'chase:credentials-set',
  chaseCredentialsClear: 'chase:credentials-clear',
  chaseCredentialsHas: 'chase:credentials-has',
  /** Cancel an in-flight chase:login (closes the window, leaves the
   *  profile's loggedIn flag unchanged). Used when the user clicks
   *  the cancel button mid-login. */
  chaseAbortLogin: 'chase:abort-login',
  /** Open Chase's "redeem rewards" page in the profile's persistent
   *  context so the user is already logged in. Window stays open
   *  until the user closes it manually — we don't track the redeem
   *  outcome here; the user navigates the Chase UI by hand. */
  chaseOpenRewards: 'chase:open-rewards',
  /** Fully-automated redemption: convert all available rewards points
   *  on the profile's tracked card to a statement credit on the same
   *  card. Window opens visibly so the user can watch / 2FA, then
   *  closes itself once /cash-back/success loads. */
  chaseRedeemAll: 'chase:redeem-all',
  /** Per-profile history of successful automated redemptions. Reads
   *  userData/chase-redeem-history.json. Returned newest-first. */
  chaseRedeemHistory: 'chase:redeem-history',
  /** Read the cached card snapshot (rewards points + current credit
   *  balance). Returns null when nothing has been fetched yet. */
  chaseSnapshotGet: 'chase:snapshot-get',
  /** Open a Chase window, scrape the snapshot fresh, persist, and
   *  return the new values. Used both by the Bank tab on first load
   *  (when no cache exists) and by an explicit refresh button. */
  chaseSnapshotRefresh: 'chase:snapshot-refresh',
  /** Open a visible Chase window pointed at the pay-card flyout
   *  for this profile's card. AmazonG does NOT auto-fill or submit
   *  — the user picks amount + bank + date themselves and clicks
   *  the final Schedule payment / Pay this bill button in the
   *  Chase window. Window stays open until the user closes it. */
  chasePayBalance: 'chase:pay-balance',
  /** Force-close the Pay-my-Balance Chase window from the renderer
   *  (the "Close browser" button on the Bank card). Calls
   *  session.close() which persists cookies + tears down the context.
   *  No-op when no pay session is registered. */
  chasePayCancel: 'chase:pay-cancel',

  jobsList: 'jobs:list',
  jobsLogs: 'jobs:logs',
  jobsClearAll: 'jobs:clear-all',
  jobsClearFailed: 'jobs:clear-failed',
  jobsClearCanceled: 'jobs:clear-canceled',
  jobsDelete: 'jobs:delete',
  jobsDeleteBulk: 'jobs:delete-bulk',
  jobsReconcileStuck: 'jobs:reconcile-stuck',
  jobsVerifyOrder: 'jobs:verify-order',
  jobsFetchTracking: 'jobs:fetch-tracking',
  jobsRebuy: 'jobs:rebuy',
  jobsSnapshot: 'jobs:snapshot',
  jobsOpenTrace: 'jobs:open-trace',
  snapshotsDiskUsage: 'snapshots:disk-usage',
  snapshotsClearAll: 'snapshots:clear-all',

  evtLog: 'evt:log',
  evtStatus: 'evt:status',
  evtProfiles: 'evt:profiles',
  evtJobs: 'evt:jobs',
  /** Fired when the Pay-my-Balance auto-close watcher detects
   *  Chase's "You've scheduled a …" confirmation. Carries the
   *  profile id so the renderer can refresh that profile's
   *  snapshot (pending charges + balance shift after the payment
   *  posts to Chase's intake queue). */
  evtChasePaySuccess: 'evt:chase-pay-success',
} as const;

export type Settings = {
  headless: boolean;
  bgBaseUrl: string;
  buyDryRun: boolean;
  minCashbackPct: number;
  /**
   * Allowed house-number prefixes for the Amazon delivery address. The
   * worker only allows checkout to proceed if the current /spc address's
   * street line starts with one of these prefixes (e.g. "13132 NE Portland
   * Way"); otherwise it opens the address picker and selects the matching
   * saved address. Mirrors old AutoG's behavior.
   */
  allowedAddressPrefixes: string[];
  /**
   * Whether the polling worker should start automatically when the app
   * launches (assuming a connected BG identity exists). Off by default
   * so a fresh launch doesn't start spending money before the user has
   * had a chance to review settings.
   */
  autoStartWorker: boolean;
  /**
   * User-chosen ordering of the Jobs-table columns. The TSV copy uses
   * this same ordering so users can shape the paste to match their
   * spreadsheet layout. Empty array = use the default order. Unknown
   * ids are ignored; missing ids fall back to the end of the table.
   */
  jobsColumnOrder: string[];
  /**
   * Set of column ids the user has hidden via the Columns dropdown.
   * Hidden columns are dropped from both the table render and the TSV
   * copy. Empty = show all columns.
   */
  jobsColumnHidden: string[];
  /**
   * Status ids the user wants to see in the Jobs table. Defaults are
   * applied via DEFAULT_VISIBLE_STATUSES on the renderer side — fresh
   * installs see everything EXCEPT Failed and Cancelled (which are
   * mostly noise once an order is finalized).
   *
   * Empty array == use defaults. The dropdown writes the explicit
   * full set whenever the user toggles, so any change survives.
   */
  jobsStatusFilter: string[];
  /** Capture screenshot + HTML snapshot on checkout failure. */
  snapshotOnFailure: boolean;
  /** Which error groups to capture. Empty = capture all groups. */
  snapshotGroups: string[];
  /**
   * Global default for "Buy with Fillers" mode. When on, the worker places
   * the target item alongside ~10 random Prime filler items to disguise the
   * order, then cancels the fillers once verify confirms the order is
   * active. The per-account toggle (AmazonProfile.buyWithFillers) overrides
   * this for individual accounts; this global setting is the default for
   * new profiles and the master cascade control on the settings screen.
   */
  buyWithFillers: boolean;
  /**
   * When on (and the buy is in filler mode), the filler picker uses a
   * whey-protein search-term pool only. 10–12 fillers per buy (random
   * count). Same Prime + price-band rules ($30–$100). No effect when
   * filler mode is off.
   */
  wheyProteinFillerOnly: boolean;
  /**
   * When set, the Dashboard's Failed counter + the failures-by-reason
   * popover ignore every attempt whose createdAt predates this
   * timestamp. Used by the popover's Clear action to "reset" the
   * counter without actually deleting rows server-side (BG's copy of
   * failed purchases keeps syncing back through listMergedAttempts,
   * so a local-only row delete would bounce right back). ISO-8601
   * string; null means "show every failure".
   */
  failedHiddenBeforeTs: string | null;
  /**
   * Attempt ids the user has explicitly deleted from their view.
   * BG's listPurchases() keeps re-syncing server-side purchase rows on
   * every merge, so a local-only deleteAttempt would bounce the row
   * right back. We remember the hidden ids locally and filter them
   * out in listMergedAttempts — lets "Delete N" mean "stop showing
   * these, even if BG still has them". Pruned automatically when an
   * id is no longer in either local or server lists.
   */
  hiddenAttemptIds: string[];
  /**
   * Scheduled auto-enqueue: when on, the main process periodically
   * fetches the live BG deals catalog and enqueues every active,
   * non-expired deal that the user hasn't already attempted within the
   * dedup window. Selection-free by design — the rule is evergreen, so
   * new deals that show up between ticks are picked up automatically
   * on the next run. See src/main/autoEnqueueScheduler.ts.
   */
  autoEnqueueEnabled: boolean;
  /** Run cadence for the scheduler. Bounds: 1–168 (one hour to one week). */
  autoEnqueueIntervalHours: number;
  /**
   * Ship-to-state filter applied before enqueue (lowercased, e.g.
   * 'oregon'). 'all' disables the filter. Independent of the Deals
   * page's UI filter so the schedule isn't accidentally narrowed by
   * an ephemeral viewing choice.
   */
  autoEnqueueShipToFilter: string;
  /**
   * Margin floor (inclusive). Deals with `marginPct >= this` are
   * eligible; deals below are dropped. Margin is `(payout - retail) /
   * retail * 100`, so values are typically negative (payout less than
   * retail) and the cashback closes the gap. A floor of -3.5 means
   * "let through every deal where retail is at most 3.5% above
   * payout"; -100 disables the filter; 0 only passes break-even or
   * profitable-by-payout-alone deals.
   */
  autoEnqueueMinMarginPct: number;
  /**
   * Hard cap on how many deals one tick may enqueue. Guards against a
   * surge of new BG deals queueing dozens of buys at once. On normal
   * days where only a handful of deals trickle in, the cap is never
   * reached.
   */
  autoEnqueueMaxPerTick: number;
  /** Epoch ms of the last successful tick. null = never run. */
  autoEnqueueLastRunAt: number | null;
  /**
   * How many Amazon accounts run the same deal in parallel during a
   * single-mode (no filler) buy. Default 3. Each account opens its
   * own Chrome window — higher = faster across multiple accounts but
   * uses more CPU/memory and runs hotter. 1-5 inclusive.
   */
  maxConcurrentSingleBuys: number;
  /**
   * How many Amazon accounts run the same deal in parallel during a
   * Buy-with-Fillers buy. Default 1. Filler carts are heavy (~10
   * extra items) and Amazon's anti-automation is touchier on rapid-
   * fire filler checkouts, so the safe default is one-at-a-time.
   * 1-3 inclusive.
   */
  maxConcurrentFillerBuys: number;
  /**
   * Parallel tabs inside a single Buy-with-Fillers buy. Each tab adds
   * filler items to the cart concurrently — all share cookies + cart
   * server-side so the writes land on one order. Default 4 (historical).
   * 1 = sequential (slowest but safest). 1-6 inclusive.
   */
  fillerParallelTabs: number;
  /**
   * When true, automated Chase flows (Bank-tab snapshot refresh +
   * rewards redemption) launch their persistent context with
   * headless Chromium so no window pops up. Login is exempt — it
   * always opens a visible window so the user can type credentials
   * and answer 2FA. Default false: visible windows for everything.
   */
  chaseHeadless: boolean;
};

/**
 * One row from BetterBG's GET /api/public/deals/amazon endpoint —
 * the shape the public catalog serves. Prices come back as string
 * Decimals from the server; we keep them as strings in the wire type
 * and parse to numbers at render time where the deals UI needs math.
 */
export type AmazonDeal = {
  dealId: string;
  dealKey: string;
  dealTitle: string;
  price: string;           // Decimal as string, e.g. "386.00"
  oldPrice: string | null; // null when retail not known
  expiryDay: string | null; // "MM-DD-YYYY" when present
  upc: string | null;
  shipToStates: string[];
  imageUrl: string | null;
  dealCreatedAt: string;   // ISO
  discoveredAt: string;    // ISO
  amazonLink: string;
};

export type AutoGBridge = {
  identityGet(): Promise<IdentityInfo | null>;
  identityConnect(apiKey: string): Promise<IdentityInfo>;
  identityDisconnect(): Promise<void>;
  workerStart(): Promise<void>;
  workerStop(): Promise<void>;
  statusGet(): Promise<RendererStatus>;
  settingsGet(): Promise<Settings>;
  settingsSet(partial: Partial<Settings>): Promise<Settings>;
  openExternal(url: string): Promise<void>;
  appVersion(): Promise<string>;
  versionCheck(): Promise<{
    updateAvailable: boolean;
    latest: string | null;
    current: string;
    downloadUrl: string | null;
  }>;
  profilesList(): Promise<AmazonProfile[]>;
  profilesAdd(email: string, displayName?: string): Promise<AmazonProfile[]>;
  profilesRemove(email: string): Promise<AmazonProfile[]>;
  profilesLogin(email: string): Promise<{ loggedIn: boolean; reason?: string }>;
  profilesRefresh(email: string): Promise<AmazonProfile | null>;
  profilesSetEnabled(email: string, enabled: boolean): Promise<AmazonProfile[]>;
  profilesSetHeadless(email: string, headless: boolean): Promise<AmazonProfile[]>;
  profilesSetBuyWithFillers(email: string, buyWithFillers: boolean): Promise<AmazonProfile[]>;
  profilesRename(email: string, displayName: string | null): Promise<AmazonProfile[]>;
  profilesOpenOrders(email: string): Promise<void>;
  profilesOpenOrder(email: string, orderId: string): Promise<void>;
  profilesReorder(orderedEmails: string[]): Promise<AmazonProfile[]>;
  dealsList(): Promise<AmazonDeal[]>;
  dealsTrigger(dealId: string): Promise<{
    jobId: string;
    dealTitle: string;
    price: string | null;
    oldPrice: string | null;
  }>;
  profilesRemoteSettings(): Promise<{
    /** Map of lowercased email → per-account remote settings. */
    settings: Record<string, { requireMinCashback: boolean; bgAccountId: string | null }>;
    /** User's BGAccount list for the per-account dropdown. Empty when
     *  the user hasn't connected any BG accounts yet. */
    bgAccounts: { id: string; label: string; username: string }[];
  }>;
  profilesSetRequireMinCashback(email: string, requireMinCashback: boolean): Promise<{ email: string; requireMinCashback: boolean }>;
  profilesSetBgAccount(email: string, bgAccountId: string | null): Promise<{
    email: string;
    bgAccountId: string | null;
  }>;
  autoEnqueueStatus(): Promise<{
    enabled: boolean;
    intervalHours: number;
    lastRunAt: number | null;
    nextRunAt: number | null;
    lastResult: {
      runAt: number;
      queued: number;
      skipped: number;
      failed: number;
      error: string | null;
    } | null;
  }>;
  chaseList(): Promise<ChaseProfile[]>;
  /** Create a Chase profile and (optionally) save credentials in the
   *  same shot. Pass `null` for credentials when the user wants to
   *  add a profile without saved-credentials auto-login (rare). */
  chaseAdd(
    label: string,
    credentials?: { username: string; password: string } | null,
  ): Promise<ChaseProfile[]>;
  chaseRemove(id: string): Promise<ChaseProfile[]>;
  chaseCredentialsSet(
    id: string,
    credentials: { username: string; password: string },
  ): Promise<void>;
  chaseCredentialsClear(id: string): Promise<void>;
  chaseCredentialsHas(id: string): Promise<boolean>;
  chaseLogin(id: string): Promise<ChaseLoginResult>;
  chaseAbortLogin(id: string): Promise<void>;
  chaseOpenRewards(id: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  chaseRedeemAll(id: string): Promise<ChaseRedeemResult>;
  chaseRedeemHistory(id: string): Promise<ChaseRedeemEntry[]>;
  chaseSnapshotGet(id: string): Promise<ChaseAccountSnapshot | null>;
  chaseSnapshotRefresh(
    id: string,
  ): Promise<{ ok: true; snapshot: ChaseAccountSnapshot } | { ok: false; reason: string }>;
  chasePayBalance(id: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  chasePayCancel(id: string): Promise<void>;
  jobsList(): Promise<JobAttempt[]>;
  jobsLogs(attemptId: string): Promise<LogEvent[]>;
  jobsClearAll(): Promise<void>;
  jobsClearFailed(): Promise<number>;
  jobsClearCanceled(): Promise<number>;
  jobsDelete(attemptId: string): Promise<void>;
  /** Delete many attempts in one pass. Returns the count actually removed. */
  jobsDeleteBulk(attemptIds: string[]): Promise<number>;
  /** Reconcile local Pending rows against BG's authoritative purchase
   *  list. Any local in_progress / awaiting_verification / queued row
   *  with no matching BG purchase (common after the app was closed
   *  mid-buy) gets flipped to `failed`. Returns the count flipped, plus
   *  `kind:'offline'` if BG couldn't be reached so the renderer can
   *  toast a clear message. */
  jobsReconcileStuck(): Promise<{ kind: 'ok'; marked: number } | { kind: 'offline' }>;
  jobsVerifyOrder(attemptId: string): Promise<
    | { kind: 'active' | 'cancelled' | 'timeout'; orderId: string }
    | { kind: 'error' | 'busy'; message: string }
  >;
  jobsFetchTracking(attemptId: string): Promise<
    | { kind: 'tracked' | 'partial'; orderId: string; trackingIds: string[] }
    | { kind: 'not_shipped' | 'retry'; orderId: string; reason?: string }
    | { kind: 'cancelled'; orderId: string; reason: string }
    | { kind: 'error' | 'busy'; message: string }
  >;
  jobsRebuy(attemptId: string): Promise<
    | { kind: 'queued'; jobId: string; deduped: boolean }
    | { kind: 'error'; message: string }
  >;

  jobsSnapshot(attemptId: string): Promise<{ screenshot: string | null; html: string | null; hasTrace: boolean }>;
  jobsOpenTrace(attemptId: string): Promise<void>;
  snapshotsDiskUsage(): Promise<{ count: number; bytes: number }>;
  snapshotsClearAll(): Promise<number>;
  onLog(cb: (events: LogEvent[]) => void): () => void;
  onStatus(cb: (s: RendererStatus) => void): () => void;
  onProfiles(cb: (profiles: AmazonProfile[]) => void): () => void;
  onJobs(cb: (attempts: JobAttempt[]) => void): () => void;
  onChasePaySuccess(cb: (profileId: string) => void): () => void;
};

declare global {
  interface Window {
    autog: AutoGBridge;
  }
}
