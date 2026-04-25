import { useMemo } from 'react';
import type { AmazonProfile, JobAttempt } from '../../shared/types.js';

/**
 * "Active jobs" panel — surfaces in-flight work the worker is about
 * to do or is doing right now. Two kinds of rows:
 *
 *  - `queued`: BG has the job in queue but the AmazonG poll loop
 *    hasn't claimed it yet. Static amber dot. Brief window (≤5s),
 *    but useful when the user just queued something and wants
 *    immediate confirmation it's about to be picked up.
 *  - `in_progress`: worker is actively driving Playwright. Pulsing
 *    purple dot with a live elapsed timer.
 *
 * Hides itself entirely when there's nothing in flight so the page
 * isn't cluttered with an empty card. Lives on both Dashboard and
 * Purchases — the dashboard re-renders every second from the
 * uptime tick (so the elapsed timer is free); on Purchases it just
 * re-renders on `evt:jobs` events, which is enough since elapsed
 * accuracy isn't critical there.
 */
export function ActiveJobsPanel({
  attempts,
  profiles,
}: {
  attempts: JobAttempt[];
  profiles: AmazonProfile[];
}) {
  const active = useMemo(
    () =>
      attempts.filter(
        (a) => a.status === 'in_progress' || a.status === 'queued',
      ),
    [attempts],
  );
  if (active.length === 0) return null;
  const now = Date.now();
  return (
    <section className="glass rounded-xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75 animate-ping" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-purple-500" />
        </span>
        <span className="text-sm font-medium text-foreground/90">
          Active jobs
          <span className="ml-1 text-xs text-muted-foreground">({active.length})</span>
        </span>
      </div>
      {/* Cap visible rows at ~3 and let the rest scroll. The panel
          had no ceiling before, so a fan-out across many accounts
          would push the rest of the page (Purchases table) below
          the fold. Max-height is ~3 row-heights + the gaps between
          them; pr-1 gives the scrollbar a gutter so row content
          doesn't reflow when scroll appears. The scroll only
          activates when there are >3 active rows. */}
      <div className="flex flex-col gap-2 max-h-[12rem] overflow-y-auto pr-1">
        {active.map((a) => {
          const p = profiles.find(
            (pp) => pp.email.toLowerCase() === a.amazonEmail.toLowerCase(),
          );
          const startedMs = new Date(a.updatedAt).getTime();
          const elapsedSec = Math.max(0, Math.floor((now - startedMs) / 1000));
          const isQueued = a.status === 'queued';
          const phaseLabel =
            a.phase === 'buy'
              ? 'Buy'
              : a.phase === 'verify'
                ? 'Verify'
                : 'Tracking';
          return (
            <div
              key={a.attemptId}
              className="flex items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2"
            >
              <span
                className={`status-pill shrink-0 ${isQueued ? 'idle' : 'running'}`}
                title={isQueued ? 'Waiting for the worker to claim this job' : `Worker is running the ${phaseLabel.toLowerCase()} phase`}
              >
                <span className="dot" />
                {isQueued ? 'Queued' : phaseLabel}
              </span>
              <div className="flex-1 min-w-0">
                <div className="truncate text-sm">
                  {a.dealTitle ?? a.dealId ?? a.productUrl}
                </div>
                <div className="text-xs text-muted-foreground truncate">
                  {p?.displayName ?? a.amazonEmail}
                  <span className="mx-1.5">·</span>
                  {isQueued ? 'Waiting to claim' : formatElapsed(elapsedSec)}
                </div>
              </div>
              {a.price !== null && (
                <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
                  ${a.price.toFixed(2)}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}s elapsed`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s elapsed`;
}
