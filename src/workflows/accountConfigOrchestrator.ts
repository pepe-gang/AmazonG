/**
 * Account-config bulk-dispatch orchestrator.
 *
 * Pattern:
 *   1. Poll BG for a queued AccountConfigJob (atomic claim).
 *   2. If we got one, list enabled + signed-in Amazon profiles.
 *   3. Fan out the per-profile action in parallel (capped concurrency).
 *   4. Per profile: open a browser session, run the action, close it,
 *      report the per-account result to BG.
 *   5. After all profiles finish, send the "final" rollup to BG.
 *
 * Triggered on:
 *   - Redis push wake (immediate — see main/index.ts on the
 *     redisSubscriber.onWake hook)
 *   - 30s safety-net poll (catches the case where push is off OR the
 *     wake fired during a previous run)
 *
 * Never throws — every error is captured into the BG status update so
 * the dashboard sees a clear failure reason instead of a stuck
 * "in_progress" row.
 */

import type { BrowserContext } from "playwright";
import { logger } from "../shared/logger.js";
import type { BGClient } from "../bg/client.js";
import type { AmazonProfile } from "../shared/types.js";
import { loadProfiles } from "../main/profiles.js";
import {
  setAmazonDayForProfile,
  type DayOfWeek,
  type SetAmazonDayResult,
} from "../actions/setAmazonDay.js";

export type AccountConfigDeps = {
  bg: BGClient;
  /** Open / borrow a Playwright BrowserContext for the given Amazon
   *  account email. Worker-owned; the orchestrator closes its own
   *  page after use but DOES NOT close the context (matches the
   *  pattern used by the buy/verify flows). */
  openSession: (email: string, headless: boolean) => Promise<{ context: BrowserContext }>;
  /** Best-effort session teardown for this email. Called when the
   *  worker is shutting down or a profile errored. Matches
   *  closeAndForgetSession in pollAndScrape. */
  closeSession: (email: string) => Promise<void>;
  /** Where dev-only HTML/PNG snapshots land when a per-account
   *  attempt hits an unexpected page state (e.g., "no manage button"
   *  could mean not-Prime OR an Amazon layout change — the snapshot
   *  lets us tell which after the fact). Same dir the buy flow uses. */
  debugDir?: string;
};

const MAX_PARALLEL = 4;

/** Module-level lock so a wake + a 30s tick don't both run the same
 *  job simultaneously. The BG-side claim is also atomic (FOR UPDATE
 *  SKIP LOCKED) so even if this leaks once we don't dispatch twice;
 *  the lock is mostly a politeness flag to skip the redundant call. */
let inFlight = false;

export async function runAccountConfigTickOnce(
  deps: AccountConfigDeps,
): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const job = await deps.bg.claimAccountConfigJob().catch((err) => {
      logger.warn(
        "accountConfig.claim.error",
        { error: err instanceof Error ? err.message : String(err) },
        "accountConfig",
      );
      return null;
    });
    if (!job) return;

    logger.info(
      "accountConfig.claimed",
      { jobId: job.id, kind: job.kind },
      "accountConfig",
    );

    if (job.kind !== "set_amazon_day") {
      // Forwards-compat: BG could ship a new kind without an AmazonG
      // update. Don't fail loudly — just report so the operator sees it.
      await deps.bg.reportAccountConfigFinal(job.id, {
        error: `unsupported kind: ${job.kind}`,
      });
      return;
    }

    const payload = (job.payload as { dayOfWeek?: string } | null) ?? {};
    const day = (payload.dayOfWeek ?? "").toUpperCase() as DayOfWeek;
    if (!isValidDay(day)) {
      await deps.bg.reportAccountConfigFinal(job.id, {
        error: `invalid dayOfWeek: ${JSON.stringify(payload.dayOfWeek)}`,
      });
      return;
    }

    // Load profiles fresh each tick — accounts may have been added /
    // signed in / disabled while the job was queued.
    const profiles = await loadProfiles().catch(() => [] as AmazonProfile[]);
    const eligible = profiles.filter((p) => p.enabled && p.loggedIn);
    logger.info(
      "accountConfig.dispatch.start",
      {
        jobId: job.id,
        day,
        eligibleCount: eligible.length,
        totalProfiles: profiles.length,
      },
      "accountConfig",
    );

    if (eligible.length === 0) {
      await deps.bg.reportAccountConfigFinal(job.id, {
        error: "no enabled + signed-in profiles",
      });
      return;
    }

    // Parallel fan-out, cap concurrency so we don't open 20 browsers
    // at once on a worker with many profiles.
    const queue = [...eligible];
    const workers = Array.from(
      { length: Math.min(MAX_PARALLEL, queue.length) },
      () => spawnWorker(deps, job.id, day, queue),
    );
    await Promise.all(workers);

    await deps.bg.reportAccountConfigFinal(job.id, {}).catch((err) => {
      logger.warn(
        "accountConfig.final.error",
        { jobId: job.id, error: err instanceof Error ? err.message : String(err) },
        "accountConfig",
      );
    });

    logger.info(
      "accountConfig.dispatch.done",
      { jobId: job.id, day, accounts: eligible.length },
      "accountConfig",
    );
  } finally {
    inFlight = false;
  }
}

async function spawnWorker(
  deps: AccountConfigDeps,
  jobId: string,
  day: DayOfWeek,
  queue: AmazonProfile[],
): Promise<void> {
  // Pull-from-shared-queue loop so a slow profile doesn't hold up the
  // others. JS event-loop single-threading makes the shift() atomic.
  while (queue.length > 0) {
    const profile = queue.shift();
    if (!profile) break;
    await runForOneProfile(deps, jobId, day, profile);
  }
}

async function runForOneProfile(
  deps: AccountConfigDeps,
  jobId: string,
  day: DayOfWeek,
  profile: AmazonProfile,
): Promise<void> {
  const cid = `accountConfig/${jobId}/${profile.email}`;
  let result: SetAmazonDayResult;
  let context: BrowserContext | null = null;
  try {
    const opened = await deps.openSession(profile.email, profile.headless);
    context = opened.context;
    // Reuse the persistent context's initial about:blank page instead
    // of opening a new tab on top of it. Avoids the "two tabs, one
    // permanently blank" UX. Fall back to newPage() in the (rare)
    // case the initial page is missing — e.g., another caller already
    // closed it.
    const existingPages = context.pages();
    const page =
      existingPages.length > 0 ? existingPages[0] : await context.newPage();
    result = await setAmazonDayForProfile(page, day, {
      profile: profile.email,
      correlationId: cid,
      debugDir: deps.debugDir,
    });
  } catch (err) {
    result = {
      ok: false,
      reason: "unexpected_error",
      detail: err instanceof Error ? err.message.slice(0, 200) : String(err),
    };
  } finally {
    // Close the entire context so the Chromium window goes away.
    // Without this every per-account run leaves a blank-tab window
    // sitting on the desktop until the next worker restart.
    await context?.close().catch(() => undefined);
  }

  logger.info(
    "accountConfig.profile.done",
    {
      jobId,
      profile: profile.email,
      ok: result.ok,
      reason: result.ok ? undefined : result.reason,
      via: result.ok ? result.via : undefined,
      before: result.ok ? result.before : result.before,
      after: result.ok ? result.after : undefined,
      noop: result.ok ? result.noop : undefined,
    },
    cid,
  );

  // Map the action result to the BG /status shape.
  const report = mapResult(result);
  await deps.bg
    .reportAccountConfigPerAccount(jobId, {
      email: profile.email,
      result: report,
    })
    .catch((err) => {
      logger.warn(
        "accountConfig.report.error",
        {
          jobId,
          profile: profile.email,
          error: err instanceof Error ? err.message : String(err),
        },
        cid,
      );
    });
}

function isValidDay(v: string): v is DayOfWeek {
  return [
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
    "SUNDAY",
  ].includes(v);
}

/** Pure mapping — exported so unit tests can pin the contract. */
export function mapResult(result: SetAmazonDayResult): {
  status: "ok" | "failed" | "skipped" | "noop_already_set";
  before?: string | null;
  after?: string | null;
  reason?: string;
  detail?: string;
} {
  if (result.ok) {
    return result.noop
      ? { status: "noop_already_set", before: result.before, after: result.after }
      : { status: "ok", before: result.before, after: result.after };
  }
  // "skipped" classes for the dashboard — not_prime, sign_in_required,
  // bot_challenge aren't user-correctable from this dispatch, they're
  // per-account state the operator needs to address separately
  // (re-sign-in, wait for WAF cookie to be set on the next attempt).
  if (
    result.reason === "not_prime" ||
    result.reason === "sign_in_required" ||
    result.reason === "bot_challenge"
  ) {
    return { status: "skipped", reason: result.reason, before: result.before ?? null };
  }
  return {
    status: "failed",
    reason: result.reason,
    detail: result.detail,
    before: result.before ?? null,
  };
}
