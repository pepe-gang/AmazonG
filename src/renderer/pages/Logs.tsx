import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { JobAttempt, LogEvent } from '../../shared/types.js';
import { formatDate, formatTime } from '../lib/format.js';
import { StatusBadge } from '../components/StatusBadge.js';

/**
 * Fields that are the same on every log line for a given attempt
 * (already shown in the drawer header), plus empty/null noise.
 * Strip them from the key/value tail so lines are scannable.
 */
const LOG_REDUNDANT_KEYS = new Set(['jobId', 'profile', 'attemptId']);

/**
 * Compact a `data` blob into:
 *  - a single "headline" string (prefer an explicit `message`; fall
 *    back to blank so the event name carries the line), and
 *  - the remaining key/value pairs, sorted for stable output.
 *
 * Null / undefined / empty-string values are dropped — they're never
 * interesting and they bloat every scrape.ok line with
 * `cashbackPct=null, condition=null`.
 */
function formatLogData(data: unknown): { message: string | null; pairs: [string, string][] } {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { message: null, pairs: [] };
  }
  const obj = data as Record<string, unknown>;
  let message: string | null = null;
  const pairs: [string, string][] = [];
  for (const [key, raw] of Object.entries(obj)) {
    if (LOG_REDUNDANT_KEYS.has(key)) continue;
    if (raw === null || raw === undefined || raw === '') continue;
    if (key === 'message' && typeof raw === 'string') {
      message = raw;
      continue;
    }
    let value: string;
    if (typeof raw === 'string') value = raw;
    else if (typeof raw === 'number' || typeof raw === 'boolean') value = String(raw);
    else value = JSON.stringify(raw);
    // Clip runaway long values (e.g. a 500-char error detail) so the
    // line doesn't wrap for 10 rows. Full detail still lives in the
    // raw log file + can be surfaced later via a detail view.
    if (value.length > 160) value = value.slice(0, 157) + '…';
    pairs.push([key, value]);
  }
  return { message, pairs };
}

function LogLine({ ev }: { ev: LogEvent }) {
  const { message, pairs } = useMemo(() => formatLogData(ev.data), [ev.data]);
  return (
    <div className="flex gap-3 px-3 py-1.5 hover:bg-white/[0.02] rounded">
      <span className="shrink-0 tabular-nums text-muted-foreground/70 text-[11.5px] font-mono leading-5">
        {ev.ts.slice(11, 19)}
      </span>
      <span
        className={
          'shrink-0 h-5 flex items-center px-1.5 rounded text-[10px] font-medium uppercase tracking-wider ' +
          (ev.level === 'error'
            ? 'bg-red-500/15 text-red-300'
            : ev.level === 'warn'
              ? 'bg-amber-500/15 text-amber-300'
              : ev.level === 'debug'
                ? 'bg-white/[0.06] text-muted-foreground'
                : 'bg-sky-500/15 text-sky-300')
        }
      >
        {ev.level}
      </span>
      <div className="flex-1 min-w-0 leading-5">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-mono text-[12.5px] text-foreground">{ev.message}</span>
          {message && (
            <span className="text-[12.5px] text-foreground/80">{message}</span>
          )}
        </div>
        {pairs.length > 0 && (
          <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px]">
            {pairs.map(([k, v]) => (
              <span key={k} className="text-muted-foreground">
                <span className="text-muted-foreground/60">{k}</span>
                <span className="text-muted-foreground/40">=</span>
                <span className="text-foreground/75">{v}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   Logs view (full page, per-attempt)
   ============================================================ */
export function LogsView({ attempt }: { attempt: JobAttempt }) {
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [snapshotPreview, setSnapshotPreview] = useState<'screenshot' | 'html' | null>(null);
  const [snapshotData, setSnapshotData] = useState<{ screenshot: string | null; html: string | null; hasTrace: boolean } | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const list = await window.autog.jobsLogs(attempt.attemptId);
      setLogs(list);
    } finally {
      setLoading(false);
    }
  }, [attempt.attemptId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Live tail: append any new log events that match this attempt.
  useEffect(() => {
    const off = window.autog.onLog((ev) => {
      const data = ev.data as Record<string, unknown> | undefined;
      const jobId = typeof data?.jobId === 'string' ? data.jobId : null;
      const profile = typeof data?.profile === 'string' ? data.profile : null;
      if (jobId === attempt.jobId && profile === attempt.amazonEmail) {
        setLogs((prev) => prev.concat(ev));
      }
    });
    return off;
  }, [attempt.jobId, attempt.amazonEmail]);

  const hasSnapshot = useMemo(() => logs.some((ev) => ev.message === 'snapshot.captured'), [logs]);

  const openSnapshot = async (kind: 'screenshot' | 'html') => {
    if (!snapshotData) {
      const data = await window.autog.jobsSnapshot(attempt.attemptId);
      setSnapshotData(data);
      setSnapshotPreview(kind);
    } else {
      setSnapshotPreview(kind);
    }
  };

  return (
    // Match every other page's Bestie rhythm: outer padding column,
    // content lives in a glass section.
    <div className="flex flex-1 flex-col gap-3 p-5 min-h-0">
      <section className="glass flex flex-col gap-3 px-5 py-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex flex-col gap-1.5 min-w-0">
            <div className="text-base font-medium text-foreground truncate max-w-[760px]">
              {attempt.dealTitle ?? '(untitled deal)'}
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span className="account-pill">{attempt.amazonEmail}</span>
              <span className="text-muted-foreground/60">·</span>
              <StatusBadge status={attempt.status} />
              <span className="text-muted-foreground/60">·</span>
              <span>{formatDate(attempt.createdAt)} {formatTime(attempt.createdAt)}</span>
              {attempt.cost && (
                <>
                  <span className="text-muted-foreground/60">·</span>
                  <span className="tabular-nums">{attempt.cost}</span>
                </>
              )}
              {attempt.cashbackPct !== null && (
                <>
                  <span className="text-muted-foreground/60">·</span>
                  <span className="tabular-nums">{attempt.cashbackPct}% cashback</span>
                </>
              )}
              {attempt.orderId && (
                <>
                  <span className="text-muted-foreground/60">·</span>
                  <span className="font-mono text-[11px]">order {attempt.orderId}</span>
                </>
              )}
            </div>
          </div>
          {hasSnapshot && (
            <div className="flex items-center gap-2 shrink-0">
              <Button variant="secondary" size="sm" onClick={() => void openSnapshot('screenshot')}>
                Screenshot
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void openSnapshot('html')}>
                HTML
              </Button>
              {snapshotData?.hasTrace && (
                <Button
                  variant="secondary"
                  size="sm"
                  title="Open trace file in Finder — drag into trace.playwright.dev to inspect"
                  onClick={() => void window.autog.jobsOpenTrace(attempt.attemptId)}
                >
                  Trace
                </Button>
              )}
            </div>
          )}
        </div>
      </section>

      {attempt.error && <div className="error-banner">{attempt.error}</div>}

      {snapshotPreview && snapshotData && (
        <div className="snapshot-preview">
          <div className="snapshot-preview-head">
            <div className="snapshot-preview-tabs">
              <button
                className={`ghost-btn ${snapshotPreview === 'screenshot' ? 'active' : ''}`}
                onClick={() => setSnapshotPreview('screenshot')}
              >
                Screenshot
              </button>
              <button
                className={`ghost-btn ${snapshotPreview === 'html' ? 'active' : ''}`}
                onClick={() => setSnapshotPreview('html')}
              >
                HTML Source
              </button>
            </div>
            <button className="ghost-btn" onClick={() => setSnapshotPreview(null)}>Close</button>
          </div>
          <div className="snapshot-preview-body">
            {snapshotPreview === 'screenshot'
              ? snapshotData.screenshot
                ? <img src={`data:image/png;base64,${snapshotData.screenshot}`} alt="Failure screenshot" className="snapshot-img" />
                : <div className="log-empty">No screenshot available.</div>
              : snapshotData.html
                ? <pre className="snapshot-html">{snapshotData.html}</pre>
                : <div className="log-empty">No HTML snapshot available.</div>}
          </div>
        </div>
      )}

      <div className="logs-stream">
        {logs.length === 0 ? (
          <div className="log-empty">{loading ? 'Loading logs…' : 'No logs recorded for this attempt.'}</div>
        ) : (
          logs.map((ev, i) => <LogLine key={i} ev={ev} />)
        )}
      </div>
    </div>
  );
}
