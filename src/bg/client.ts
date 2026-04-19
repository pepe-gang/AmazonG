import { BGApiError } from '../shared/errors.js';
import type {
  AutoGJob,
  IdentityInfo,
  JobAttemptStatus,
  JobStatusReport,
} from '../shared/types.js';

/**
 * One row from GET /api/autog/purchases — BetterBG normalizes statuses
 * into AmazonG's per-attempt vocabulary server-side, so this shape maps
 * almost 1:1 onto the local JobAttempt. Dates arrive as ISO strings
 * (Next.js's default Date serialization).
 */
export type ServerPurchase = {
  attemptId: string;
  jobId: string;
  commitmentId: string;
  dealKey: string;
  dealId: string | null;
  dealTitle: string;
  imageUrl: string | null;
  upc: string | null;
  productUrl: string;
  maxPrice: string;
  price: string | null;
  quantity: number;
  phase: 'buy' | 'verify';
  amazonEmail: string | null;
  status: JobAttemptStatus;
  placedAt: string | null;
  placedPrice: string | null;
  placedCashbackPct: number | null;
  placedOrderId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type VersionInfo = {
  latestVersion: string | null;
  downloadUrls: { darwin?: string; win32?: string; linux?: string };
};

export type BGClient = {
  readonly baseUrl: string;
  me(): Promise<IdentityInfo>;
  claimJob(): Promise<AutoGJob | null>;
  reportStatus(jobId: string, report: JobStatusReport): Promise<void>;
  listPurchases(limit?: number): Promise<ServerPurchase[]>;
  checkVersion(): Promise<VersionInfo>;
};

/**
 * BG's Prisma layer returns Decimal columns (like maxPrice) as strings in
 * JSON. Coerce them to numbers once at the boundary so the rest of the app
 * can trust the typed `AutoGJob` shape.
 */
function normalizeJob(raw: unknown): AutoGJob | null {
  if (!raw || typeof raw !== 'object') return null;
  const j = raw as Record<string, unknown>;
  return {
    id: String(j.id ?? ''),
    phase: (j.phase === 'verify' ? 'verify' : 'buy'),
    dealTitle: typeof j.dealTitle === 'string' ? j.dealTitle : null,
    dealKey: typeof j.dealKey === 'string' ? j.dealKey : null,
    dealId: typeof j.dealId === 'string' && j.dealId.length > 0 ? j.dealId : null,
    productUrl: String(j.productUrl ?? ''),
    maxPrice: toNumber(j.maxPrice),
    price: toNumber(j.price),
    quantity: typeof j.quantity === 'number' ? j.quantity : Number(j.quantity) || 1,
    commitmentId: typeof j.commitmentId === 'string' ? j.commitmentId : null,
    attempts: typeof j.attempts === 'number' ? j.attempts : Number(j.attempts) || 0,
    buyJobId: typeof j.buyJobId === 'string' ? j.buyJobId : null,
    placedOrderId: typeof j.placedOrderId === 'string' ? j.placedOrderId : null,
    placedEmail: typeof j.placedEmail === 'string' ? j.placedEmail : null,
    viaFiller: Boolean(j.viaFiller),
  };
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function createBGClient(baseUrl: string, apiKey: string): BGClient {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  async function request<T>(path: string, init: RequestInit, allow204 = false): Promise<T | null> {
    const url = `${baseUrl}${path}`;
    const res = await fetch(url, { ...init, headers: { ...headers, ...init.headers } });
    if (allow204 && res.status === 204) return null;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new BGApiError(res.status, path, body.slice(0, 500));
    }
    return (await res.json()) as T;
  }

  return {
    baseUrl,

    async me() {
      const r = await request<IdentityInfo>('/api/autog/me', { method: 'GET' });
      if (!r) throw new BGApiError(500, '/api/autog/me', 'empty response');
      return r;
    },

    async claimJob() {
      const wrapped = await request<{ job: unknown }>(
        '/api/autog/jobs/claim',
        { method: 'POST', body: JSON.stringify({}) },
        true,
      );
      return normalizeJob(wrapped?.job);
    },

    async reportStatus(jobId, report) {
      await request<{ ok: true }>(`/api/autog/jobs/${encodeURIComponent(jobId)}/status`, {
        method: 'POST',
        body: JSON.stringify(report),
      });
    },

    async listPurchases(limit = 500) {
      const n = Math.max(1, Math.min(500, Math.floor(limit)));
      const r = await request<{ attempts: ServerPurchase[] }>(
        `/api/autog/purchases?limit=${n}`,
        { method: 'GET' },
      );
      return r?.attempts ?? [];
    },

    async checkVersion() {
      const r = await request<VersionInfo>('/api/autog/version', { method: 'GET' });
      return r ?? { latestVersion: null, downloadUrls: {} };
    },
  };
}
