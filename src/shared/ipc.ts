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

  profilesList: 'profiles:list',
  profilesAdd: 'profiles:add',
  profilesRemove: 'profiles:remove',
  profilesLogin: 'profiles:login',
  profilesRefresh: 'profiles:refresh',
  profilesSetEnabled: 'profiles:set-enabled',
  profilesRename: 'profiles:rename',
  profilesOpenOrders: 'profiles:open-orders',
  profilesOpenOrder: 'profiles:open-order',
  profilesReorder: 'profiles:reorder',

  jobsList: 'jobs:list',
  jobsLogs: 'jobs:logs',
  jobsClearAll: 'jobs:clear-all',
  jobsClearFailed: 'jobs:clear-failed',
  jobsClearCanceled: 'jobs:clear-canceled',

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
  profilesList(): Promise<AmazonProfile[]>;
  profilesAdd(email: string, displayName?: string): Promise<AmazonProfile[]>;
  profilesRemove(email: string): Promise<AmazonProfile[]>;
  profilesLogin(email: string): Promise<{ loggedIn: boolean; reason?: string }>;
  profilesRefresh(email: string): Promise<AmazonProfile | null>;
  profilesSetEnabled(email: string, enabled: boolean): Promise<AmazonProfile[]>;
  profilesRename(email: string, displayName: string | null): Promise<AmazonProfile[]>;
  profilesOpenOrders(email: string): Promise<void>;
  profilesOpenOrder(email: string, orderId: string): Promise<void>;
  profilesReorder(orderedEmails: string[]): Promise<AmazonProfile[]>;
  jobsList(): Promise<JobAttempt[]>;
  jobsLogs(attemptId: string): Promise<LogEvent[]>;
  jobsClearAll(): Promise<void>;
  jobsClearFailed(): Promise<number>;
  jobsClearCanceled(): Promise<number>;
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
