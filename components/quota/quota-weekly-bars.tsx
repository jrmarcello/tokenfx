import type { JSX } from 'react';
import type { DailyTokenPoint } from '@/lib/queries/quota';
import { fmtCompact } from '@/lib/fmt';

const DAY_MS = 86_400_000;

const daysAgoOf = (dateKey: string, now: number): number => {
  const [y, m, d] = dateKey.split('-').map((s) => Number(s));
  if (!y || !m || !d) return -1;
  const entryMidnight = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  const nowDate = new Date(now);
  const nowMidnight = new Date(
    nowDate.getFullYear(),
    nowDate.getMonth(),
    nowDate.getDate(),
    0,
    0,
    0,
    0,
  ).getTime();
  return Math.round((nowMidnight - entryMidnight) / DAY_MS);
};

const bucketDailyIntoWeeks = (
  daily: readonly DailyTokenPoint[],
  now: number,
): readonly [number, number, number, number] => {
  // Oldest → newest. Index 3 = "this week" (0-6 days ago).
  const buckets: [number, number, number, number] = [0, 0, 0, 0];
  for (const d of daily) {
    if (d.tokens <= 0) continue;
    const ago = daysAgoOf(d.dateKey, now);
    if (ago < 0) continue;
    const bucket = Math.min(3, 3 - Math.floor(ago / 7));
    if (bucket >= 0 && bucket < 4) {
      buckets[bucket] += d.tokens;
    }
  }
  return buckets;
};

type Props = {
  daily: readonly DailyTokenPoint[];
  now: number;
};

/**
 * Horizontal bar chart of weekly token totals for the last 4 rolling
 * weeks. Oldest week first, current week last — highlighted in emerald.
 *
 * Lives below `QuotaHeatmap` in the left column of `/quota`, sharing the
 * same underlying daily data.
 */
export function QuotaWeeklyBars({ daily, now }: Props): JSX.Element {
  const weeks = bucketDailyIntoWeeks(daily, now);
  const max = Math.max(...weeks, 1);
  const labels = [
    'há 3 semanas',
    'há 2 semanas',
    'semana passada',
    'esta semana',
  ] as const;

  return (
    <section
      aria-label="Tokens por semana"
      className="space-y-3 rounded-lg border border-neutral-200 bg-white p-6 transition-colors hover:border-neutral-300 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-neutral-700"
    >
      <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
        Tokens por semana (oldest → newest)
      </h3>
      <div className="space-y-1.5">
        {weeks.map((val, i) => {
          const pct = max > 0 ? (val / max) * 100 : 0;
          const isCurrent = i === 3;
          return (
            <div
              key={labels[i]}
              className="grid grid-cols-[7rem_1fr_auto] items-center gap-x-2 text-xs"
            >
              <span
                className={
                  isCurrent
                    ? 'font-medium text-neutral-900 dark:text-neutral-100'
                    : 'text-neutral-500 dark:text-neutral-400'
                }
              >
                {labels[i]}
              </span>
              <div
                className="h-2 rounded-sm bg-neutral-100 dark:bg-neutral-800"
                role="img"
                aria-label={`${labels[i]}: ${fmtCompact(val)} tokens`}
              >
                <div
                  className={
                    isCurrent
                      ? 'h-full rounded-sm bg-emerald-500 transition-all dark:bg-emerald-500'
                      : 'h-full rounded-sm bg-neutral-400 transition-all dark:bg-neutral-600'
                  }
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="tabular-nums text-neutral-600 dark:text-neutral-300">
                {fmtCompact(val)}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
