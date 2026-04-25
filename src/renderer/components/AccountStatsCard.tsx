import { useMemo, useState } from 'react';
import { computeProfit } from '@shared/profit';
import type { AmazonProfile, JobAttempt } from '../../shared/types.js';
import { STATUS_GROUP } from '../lib/jobsColumns.js';
import { UsersIcon } from './icons.js';

type SortKey = 'account' | 'today' | 'month' | 'lastMonth' | 'year' | 'all';
type SortDir = 'asc' | 'desc';

/**
 * Per-account performance card — answers "which account is doing the
 * work and making money." Shown on the dashboard below the three
 * top-line stat cards as the natural drill-down: overall → per-account.
 *
 * Counts only verified ("Success") rows so the numbers match the
 * dashboard's Success pill exactly; pending / awaiting_verification /
 * failed rows are ignored. Profit comes from `computeProfit`, which
 * only computes for verified rows — same accounting as the existing
 * Profit card so the per-account totals roll up to the same all-time
 * figure.
 *
 * Hidden when the user has no enabled profiles so the dashboard isn't
 * cluttered with an empty card on a fresh install.
 */
export function AccountStatsCard({
  attempts,
  profiles,
}: {
  attempts: JobAttempt[];
  profiles: AmazonProfile[];
}) {
  const enabledProfiles = useMemo(
    () => profiles.filter((p) => p.enabled),
    [profiles],
  );

  const perAccount = useMemo(() => {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayMs = startOfToday.getTime();
    const startOfMonth = new Date();
    startOfMonth.setHours(0, 0, 0, 0);
    startOfMonth.setDate(1);
    const monthMs = startOfMonth.getTime();
    // Previous calendar month: [first-of-prev-month, first-of-this-month).
    // new Date(year, month, 1) handles January rollover automatically
    // (month=-1 returns December of the previous year).
    const startOfLastMonth = new Date(startOfMonth);
    startOfLastMonth.setMonth(startOfLastMonth.getMonth() - 1);
    const lastMonthMs = startOfLastMonth.getTime();
    const startOfYear = new Date(startOfMonth);
    startOfYear.setMonth(0);
    startOfYear.setDate(1);
    const yearMs = startOfYear.getTime();

    return enabledProfiles.map((p) => {
      const stats = {
        todayCount: 0,
        todayProfit: 0,
        monthCount: 0,
        monthProfit: 0,
        lastMonthCount: 0,
        lastMonthProfit: 0,
        yearCount: 0,
        yearProfit: 0,
        allCount: 0,
        allProfit: 0,
      };
      const emailLower = p.email.toLowerCase();
      for (const a of attempts) {
        if (a.amazonEmail.toLowerCase() !== emailLower) continue;
        if (STATUS_GROUP[a.status] !== 'success') continue;
        const profit = computeProfit(a) ?? 0;
        const t = new Date(a.createdAt).getTime();

        stats.allCount += 1;
        stats.allProfit += profit;
        if (t >= yearMs) {
          stats.yearCount += 1;
          stats.yearProfit += profit;
        }
        // Last month is a closed range — must NOT include this month,
        // hence the explicit upper bound. Using the same `monthMs`
        // boundary keeps the two month buckets disjoint.
        if (t >= lastMonthMs && t < monthMs) {
          stats.lastMonthCount += 1;
          stats.lastMonthProfit += profit;
        }
        if (t >= monthMs) {
          stats.monthCount += 1;
          stats.monthProfit += profit;
        }
        if (t >= todayMs) {
          stats.todayCount += 1;
          stats.todayProfit += profit;
        }
      }
      return { profile: p, stats };
    });
  }, [enabledProfiles, attempts]);

  // Default to most-profitable-all-time at the top — that's the question
  // most users are scanning the card to answer. Account name is asc by
  // default (alphabetical); profit columns are desc by default.
  const [sortKey, setSortKey] = useState<SortKey>('all');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const sorted = useMemo(() => {
    const rows = [...perAccount];
    rows.sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'account') {
        const an = (a.profile.displayName ?? a.profile.email).toLowerCase();
        const bn = (b.profile.displayName ?? b.profile.email).toLowerCase();
        cmp = an.localeCompare(bn);
      } else if (sortKey === 'today') {
        cmp = a.stats.todayProfit - b.stats.todayProfit;
      } else if (sortKey === 'month') {
        cmp = a.stats.monthProfit - b.stats.monthProfit;
      } else if (sortKey === 'lastMonth') {
        cmp = a.stats.lastMonthProfit - b.stats.lastMonthProfit;
      } else if (sortKey === 'year') {
        cmp = a.stats.yearProfit - b.stats.yearProfit;
      } else {
        cmp = a.stats.allProfit - b.stats.allProfit;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return rows;
  }, [perAccount, sortKey, sortDir]);

  const onSort = (k: SortKey) => {
    if (k === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(k);
      // New column → sensible default direction.
      setSortDir(k === 'account' ? 'asc' : 'desc');
    }
  };

  if (enabledProfiles.length === 0) return null;

  return (
    <section className="glass rounded-xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-violet-500/30 bg-violet-500/15 text-violet-300">
          <UsersIcon />
        </span>
        <span className="text-sm font-medium text-foreground/90">
          Per-account performance
          <span className="ml-1 text-xs text-muted-foreground">
            ({enabledProfiles.length})
          </span>
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wider text-muted-foreground/80">
              <SortHeader
                label="Account"
                k="account"
                sortKey={sortKey}
                sortDir={sortDir}
                onSort={onSort}
                align="left"
                title="Sort by account name"
              />
              <SortHeader
                label="Today"
                k="today"
                sortKey={sortKey}
                sortDir={sortDir}
                onSort={onSort}
                title="Sort by today's profit"
              />
              <SortHeader
                label="This month"
                k="month"
                sortKey={sortKey}
                sortDir={sortDir}
                onSort={onSort}
                title="Sort by this month's profit"
              />
              <SortHeader
                label="Last month"
                k="lastMonth"
                sortKey={sortKey}
                sortDir={sortDir}
                onSort={onSort}
                title="Sort by last month's profit (full previous calendar month)"
              />
              <SortHeader
                label="This year"
                k="year"
                sortKey={sortKey}
                sortDir={sortDir}
                onSort={onSort}
                title="Sort by this year's profit (Jan 1 to now)"
              />
              <SortHeader
                label="All-time"
                k="all"
                sortKey={sortKey}
                sortDir={sortDir}
                onSort={onSort}
                title="Sort by all-time profit"
              />
            </tr>
          </thead>
          <tbody>
            {sorted.map(({ profile, stats }) => {
              const display = profile.displayName ?? profile.email;
              return (
                <tr
                  key={profile.email}
                  className="border-t border-white/[0.04]"
                >
                  <td className="py-2 pr-3">
                    <div
                      className="truncate max-w-[220px]"
                      title={profile.email}
                    >
                      {display}
                    </div>
                  </td>
                  <td className="py-2 px-3 text-right">
                    <CountProfit
                      count={stats.todayCount}
                      profit={stats.todayProfit}
                    />
                  </td>
                  <td className="py-2 px-3 text-right">
                    <CountProfit
                      count={stats.monthCount}
                      profit={stats.monthProfit}
                    />
                  </td>
                  <td className="py-2 px-3 text-right">
                    <CountProfit
                      count={stats.lastMonthCount}
                      profit={stats.lastMonthProfit}
                    />
                  </td>
                  <td className="py-2 px-3 text-right">
                    <CountProfit
                      count={stats.yearCount}
                      profit={stats.yearProfit}
                    />
                  </td>
                  <td className="py-2 pl-3 text-right">
                    <CountProfit
                      count={stats.allCount}
                      profit={stats.allProfit}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SortHeader({
  label,
  k,
  sortKey,
  sortDir,
  onSort,
  align = 'right',
  title,
}: {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
  align?: 'left' | 'right';
  title: string;
}) {
  const active = sortKey === k;
  const arrow = active ? (sortDir === 'asc' ? '▲' : '▼') : '';
  const thAlign = align === 'left' ? 'text-left pr-3' : 'text-right px-3';
  const btnAlign = align === 'left' ? 'justify-start' : 'justify-end';
  return (
    <th className={`font-normal pb-2 ${thAlign}`}>
      <button
        type="button"
        onClick={() => onSort(k)}
        title={title}
        className={`inline-flex items-center gap-1 ${btnAlign} cursor-pointer select-none uppercase tracking-wider text-muted-foreground/80 hover:text-foreground/90 transition-colors ${active ? 'text-foreground/90' : ''}`}
      >
        {label}
        <span className="text-[9px] w-2 inline-block">{arrow}</span>
      </button>
    </th>
  );
}

function CountProfit({ count, profit }: { count: number; profit: number }) {
  if (count === 0) {
    return <span className="text-muted-foreground tabular-nums">—</span>;
  }
  const profitColor =
    profit > 0
      ? 'text-emerald-300'
      : profit < 0
        ? 'text-red-300'
        : 'text-muted-foreground';
  const sign = profit >= 0 ? '+' : '−';
  return (
    <div className="flex flex-col items-end leading-tight tabular-nums">
      <span className="text-foreground/80">
        {count} order{count === 1 ? '' : 's'}
      </span>
      <span className={'text-xs ' + profitColor}>
        {sign}${Math.abs(profit).toFixed(2)} profit
      </span>
    </div>
  );
}
