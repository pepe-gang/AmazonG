import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type AutoGBridge, type Settings } from '../shared/ipc.js';
import type {
  AmazonProfile,
  IdentityInfo,
  JobAttempt,
  LogEvent,
  RendererStatus,
} from '../shared/types.js';

const bridge: AutoGBridge = {
  identityGet: () => ipcRenderer.invoke(IPC.identityGet) as Promise<IdentityInfo | null>,
  identityConnect: (apiKey) =>
    ipcRenderer.invoke(IPC.identityConnect, apiKey) as Promise<IdentityInfo>,
  identityDisconnect: () => ipcRenderer.invoke(IPC.identityDisconnect) as Promise<void>,
  workerStart: () => ipcRenderer.invoke(IPC.workerStart) as Promise<void>,
  workerStop: () => ipcRenderer.invoke(IPC.workerStop) as Promise<void>,
  statusGet: () => ipcRenderer.invoke(IPC.statusGet) as Promise<RendererStatus>,
  settingsGet: () => ipcRenderer.invoke(IPC.settingsGet) as Promise<Settings>,
  settingsSet: (p) => ipcRenderer.invoke(IPC.settingsSet, p) as Promise<Settings>,
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url) as Promise<void>,
  appVersion: () => ipcRenderer.invoke(IPC.appVersion) as Promise<string>,
  versionCheck: () =>
    ipcRenderer.invoke(IPC.versionCheck) as ReturnType<AutoGBridge['versionCheck']>,

  profilesList: () => ipcRenderer.invoke(IPC.profilesList) as Promise<AmazonProfile[]>,
  profilesAdd: (email, displayName) =>
    ipcRenderer.invoke(IPC.profilesAdd, email, displayName) as Promise<AmazonProfile[]>,
  profilesRemove: (email) =>
    ipcRenderer.invoke(IPC.profilesRemove, email) as Promise<AmazonProfile[]>,
  profilesLogin: (email) =>
    ipcRenderer.invoke(IPC.profilesLogin, email) as Promise<{ loggedIn: boolean; reason?: string }>,
  profilesRefresh: (email) =>
    ipcRenderer.invoke(IPC.profilesRefresh, email) as Promise<AmazonProfile | null>,
  profilesSetEnabled: (email, enabled) =>
    ipcRenderer.invoke(IPC.profilesSetEnabled, email, enabled) as Promise<AmazonProfile[]>,
  profilesSetHeadless: (email, headless) =>
    ipcRenderer.invoke(IPC.profilesSetHeadless, email, headless) as Promise<AmazonProfile[]>,
  profilesSetBuyWithFillers: (email, buyWithFillers) =>
    ipcRenderer.invoke(IPC.profilesSetBuyWithFillers, email, buyWithFillers) as Promise<
      AmazonProfile[]
    >,
  profilesRename: (email, displayName) =>
    ipcRenderer.invoke(IPC.profilesRename, email, displayName) as Promise<AmazonProfile[]>,
  profilesOpenOrders: (email) =>
    ipcRenderer.invoke(IPC.profilesOpenOrders, email) as Promise<void>,
  profilesOpenOrder: (email, orderId) =>
    ipcRenderer.invoke(IPC.profilesOpenOrder, email, orderId) as Promise<void>,
  profilesReorder: (orderedEmails) =>
    ipcRenderer.invoke(IPC.profilesReorder, orderedEmails) as Promise<AmazonProfile[]>,
  dealsList: () =>
    ipcRenderer.invoke(IPC.dealsList) as ReturnType<AutoGBridge['dealsList']>,
  dealsTrigger: (dealId) =>
    ipcRenderer.invoke(IPC.dealsTrigger, dealId) as ReturnType<AutoGBridge['dealsTrigger']>,
  profilesRemoteSettings: () =>
    ipcRenderer.invoke(IPC.profilesRemoteSettings) as Promise<
      Record<string, { requireMinCashback: boolean }>
    >,
  profilesSetRequireMinCashback: (email, requireMinCashback) =>
    ipcRenderer.invoke(IPC.profilesSetRequireMinCashback, email, requireMinCashback) as Promise<{
      email: string;
      requireMinCashback: boolean;
    }>,

  jobsList: () => ipcRenderer.invoke(IPC.jobsList) as Promise<JobAttempt[]>,
  jobsLogs: (attemptId) =>
    ipcRenderer.invoke(IPC.jobsLogs, attemptId) as Promise<LogEvent[]>,
  jobsClearAll: () => ipcRenderer.invoke(IPC.jobsClearAll) as Promise<void>,
  jobsClearFailed: () => ipcRenderer.invoke(IPC.jobsClearFailed) as Promise<number>,
  jobsClearCanceled: () => ipcRenderer.invoke(IPC.jobsClearCanceled) as Promise<number>,
  jobsDelete: (attemptId) => ipcRenderer.invoke(IPC.jobsDelete, attemptId) as Promise<void>,
  jobsDeleteBulk: (attemptIds) =>
    ipcRenderer.invoke(IPC.jobsDeleteBulk, attemptIds) as Promise<number>,
  jobsVerifyOrder: (attemptId) =>
    ipcRenderer.invoke(IPC.jobsVerifyOrder, attemptId) as ReturnType<
      AutoGBridge['jobsVerifyOrder']
    >,
  jobsFetchTracking: (attemptId) =>
    ipcRenderer.invoke(IPC.jobsFetchTracking, attemptId) as ReturnType<
      AutoGBridge['jobsFetchTracking']
    >,
  jobsRebuy: (attemptId) =>
    ipcRenderer.invoke(IPC.jobsRebuy, attemptId) as ReturnType<
      AutoGBridge['jobsRebuy']
    >,
  jobsSnapshot: (attemptId) =>
    ipcRenderer.invoke(IPC.jobsSnapshot, attemptId) as ReturnType<
      AutoGBridge['jobsSnapshot']
    >,
  jobsOpenTrace: (attemptId) =>
    ipcRenderer.invoke(IPC.jobsOpenTrace, attemptId) as Promise<void>,
  snapshotsDiskUsage: () =>
    ipcRenderer.invoke(IPC.snapshotsDiskUsage) as ReturnType<AutoGBridge['snapshotsDiskUsage']>,
  snapshotsClearAll: () =>
    ipcRenderer.invoke(IPC.snapshotsClearAll) as ReturnType<AutoGBridge['snapshotsClearAll']>,

  onLog(cb) {
    const listener = (_: unknown, ev: LogEvent) => cb(ev);
    ipcRenderer.on(IPC.evtLog, listener);
    return () => ipcRenderer.off(IPC.evtLog, listener);
  },
  onStatus(cb) {
    const listener = (_: unknown, s: RendererStatus) => cb(s);
    ipcRenderer.on(IPC.evtStatus, listener);
    return () => ipcRenderer.off(IPC.evtStatus, listener);
  },
  onProfiles(cb) {
    const listener = (_: unknown, p: AmazonProfile[]) => cb(p);
    ipcRenderer.on(IPC.evtProfiles, listener);
    return () => ipcRenderer.off(IPC.evtProfiles, listener);
  },
  onJobs(cb) {
    const listener = (_: unknown, attempts: JobAttempt[]) => cb(attempts);
    ipcRenderer.on(IPC.evtJobs, listener);
    return () => ipcRenderer.off(IPC.evtJobs, listener);
  },
};

contextBridge.exposeInMainWorld('autog', bridge);
