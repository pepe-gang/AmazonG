import type {
  AmazonProfile,
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
  /** Fetch the per-Amazon-account remote settings map from BG (keyed by
   *  email → { requireMinCashback }). Renderer calls this when the
   *  Accounts tab mounts to paint the toggles with the live state. */
  profilesRemoteSettings: 'profiles:remote-settings',
  /** Toggle the cashback gate for one Amazon account on BG. Returns the
   *  updated setting row so the caller can reconcile optimistic state. */
  profilesSetRequireMinCashback: 'profiles:set-require-min-cashback',

  jobsList: 'jobs:list',
  jobsLogs: 'jobs:logs',
  jobsClearAll: 'jobs:clear-all',
  jobsClearFailed: 'jobs:clear-failed',
  jobsClearCanceled: 'jobs:clear-canceled',
  jobsDelete: 'jobs:delete',
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
  versionCheck(): Promise<{ updateAvailable: boolean; latest: string | null; current: string }>;
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
  profilesRemoteSettings(): Promise<Record<string, { requireMinCashback: boolean }>>;
  profilesSetRequireMinCashback(email: string, requireMinCashback: boolean): Promise<{ email: string; requireMinCashback: boolean }>;
  jobsList(): Promise<JobAttempt[]>;
  jobsLogs(attemptId: string): Promise<LogEvent[]>;
  jobsClearAll(): Promise<void>;
  jobsClearFailed(): Promise<number>;
  jobsClearCanceled(): Promise<number>;
  jobsDelete(attemptId: string): Promise<void>;
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
  onLog(cb: (ev: LogEvent) => void): () => void;
  onStatus(cb: (s: RendererStatus) => void): () => void;
  onProfiles(cb: (profiles: AmazonProfile[]) => void): () => void;
  onJobs(cb: (attempts: JobAttempt[]) => void): () => void;
};

declare global {
  interface Window {
    autog: AutoGBridge;
  }
}
