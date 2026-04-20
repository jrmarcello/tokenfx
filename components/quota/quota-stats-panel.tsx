import type { JSX } from 'react';
import type {
  DailyTokenPoint,
  QuotaHeatmapCell,
} from '@/lib/queries/quota';
import { fmtCompact } from '@/lib/fmt';

// strftime %w (0=Sunday .. 6=Saturday)
const WEEKDAY_LABELS_FULL = [
  'Domingo',
  'Segunda',
  'Terça',
  'Quarta',
  'Quinta',
  'Sexta',
  'Sábado',
] as const;

const WEEKDAY_LABELS_SHORT = [
  'Dom',
  'Seg',
  'Ter',
  'Qua',
  'Qui',
  'Sex',
  'Sáb',
] as const;

const DAY_MS = 86_400_000;

const fmtHour = (h: number): string => `${String(h).padStart(2, '0')}h`;

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

type DayRanked = { dow: number; tokens: number };
type PeakCell = { dow: number; hour: number; tokens: number };

const deriveStats = (
  heatmap: readonly QuotaHeatmapCell[],
  daily: readonly DailyTokenPoint[],
  now: number,
): {
  total28d: number;
  activeDays: number;
  avgPerActiveDay: number;
  topDays: readonly DayRanked[];
  topPeaks: readonly PeakCell[];
} => {
  // Totals + activity from the daily series (accurate "active days" count).
  let total28d = 0;
  let activeDays = 0;
  for (const d of daily) {
    if (d.tokens <= 0) continue;
    const ago = daysAgoOf(d.dateKey, now);
    if (ago < 0 || ago >= 28) continue;
    total28d += d.tokens;
    activeDays += 1;
  }
  const avgPerActiveDay = activeDays > 0 ? total28d / activeDays : 0;

  // Top 3 weekdays (aggregated across all hours).
  const byDow = new Map<number, number>();
  for (const c of heatmap) {
    byDow.set(c.dow, (byDow.get(c.dow) ?? 0) + c.tokens);
  }
  const topDays: DayRanked[] = [...byDow.entries()]
    .map(([dow, tokens]) => ({ dow, tokens }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 3);

  // Top 3 peak cells (specific dow+hour combinations).
  const topPeaks: PeakCell[] = [...heatmap]
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 3)
    .map((c) => ({ dow: c.dow, hour: c.hour, tokens: c.tokens }));

  return {
    total28d,
    activeDays,
    avgPerActiveDay,
    topDays,
    topPeaks,
  };
};

type Props = {
  heatmap: readonly QuotaHeatmapCell[];
  daily: readonly DailyTokenPoint[];
  now: number;
};

/**
 * Right-column stats panel on the `/quota` page. Three sections:
 *   1. Global summary — total, active days, daily average (28d).
 *   2. Top 3 dias — weekdays ranked by aggregate token sum.
 *   3. Top 3 picos — specific (weekday, hour) heatmap cells by tokens.
 *
 * Meant to vertically fill alongside [heatmap + weekly bars] in the left
 * column via CSS grid `align-items: stretch` default.
 */
export function QuotaStatsPanel({ heatmap, daily, now }: Props): JSX.Element {
  const stats = deriveStats(heatmap, daily, now);

  return (
    <section
      aria-label="Estatísticas de consumo"
      className="flex h-full flex-col gap-6 rounded-lg border border-neutral-200 bg-white p-6 transition-colors hover:border-neutral-300 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-neutral-700"
    >
      <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
        Estatísticas de consumo (últimas 4 semanas)
      </h3>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-neutral-500 dark:text-neutral-400">Total 28d</dt>
        <dd className="tabular-nums text-neutral-900 dark:text-neutral-100">
          {fmtCompact(stats.total28d)} tokens
        </dd>

        <dt className="text-neutral-500 dark:text-neutral-400">Dias ativos</dt>
        <dd className="tabular-nums text-neutral-900 dark:text-neutral-100">
          {stats.activeDays}/28
        </dd>

        <dt className="text-neutral-500 dark:text-neutral-400">Média diária</dt>
        <dd className="tabular-nums text-neutral-900 dark:text-neutral-100">
          {fmtCompact(stats.avgPerActiveDay)} tokens
          <span className="ml-1 text-xs text-neutral-500 dark:text-neutral-400">
            (dias ativos)
          </span>
        </dd>
      </dl>

      <section className="space-y-2">
        <h4 className="text-xs font-medium uppercase tracking-wide text-neutral-600 dark:text-neutral-400">
          Top 3 dias da semana
        </h4>
        {stats.topDays.length === 0 ? (
          <p className="text-xs text-neutral-500">Sem dados suficientes.</p>
        ) : (
          <ol className="space-y-1 text-sm">
            {stats.topDays.map((d, i) => (
              <li
                key={`day-${d.dow}`}
                className="grid grid-cols-[1.25rem_1fr_auto] items-center gap-x-3"
              >
                <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
                  {i + 1}.
                </span>
                <span className="text-neutral-900 dark:text-neutral-100">
                  {WEEKDAY_LABELS_FULL[d.dow]}
                </span>
                <span className="tabular-nums text-neutral-600 dark:text-neutral-300">
                  {fmtCompact(d.tokens)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="space-y-2">
        <h4 className="text-xs font-medium uppercase tracking-wide text-neutral-600 dark:text-neutral-400">
          Top 3 picos (dia + hora)
        </h4>
        {stats.topPeaks.length === 0 ? (
          <p className="text-xs text-neutral-500">Sem dados suficientes.</p>
        ) : (
          <ol className="space-y-1 text-sm">
            {stats.topPeaks.map((p, i) => (
              <li
                key={`peak-${p.dow}-${p.hour}`}
                className="grid grid-cols-[1.25rem_1fr_auto] items-center gap-x-3"
              >
                <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
                  {i + 1}.
                </span>
                <span className="text-neutral-900 dark:text-neutral-100">
                  {WEEKDAY_LABELS_SHORT[p.dow]} {fmtHour(p.hour)}
                </span>
                <span className="tabular-nums text-neutral-600 dark:text-neutral-300">
                  {fmtCompact(p.tokens)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </section>
  );
}
