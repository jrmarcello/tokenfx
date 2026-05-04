'use client';

/**
 * Subagent adoption trend — manager-dashboard-v2 REQ-4.
 *
 * Renders a Recharts `LineChart` of daily `% sessions with subagent_usage_ratio > 0`
 * across the 30-day window. Shape matches the `trend` field of
 * `TeamSubagentAdoption` from `lib/queries/manager-v2.ts`. NULL days (no
 * sessions) are rendered as gaps (Recharts treats `null` Y-values as breaks).
 *
 * Client-only because Recharts uses ResizeObserver via `ResponsiveContainer`.
 * Mirrors `<TrendChart>` styling for visual consistency.
 */
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export type SubagentTrendPoint = {
  day: string;
  pct: number | null;
};

type Props = {
  data: ReadonlyArray<SubagentTrendPoint>;
  testId?: string;
};

const formatPct = (n: number): string => `${n.toFixed(0)}%`;

export const SubagentTrendChart = ({ data, testId }: Props) => {
  if (data.length === 0) {
    return (
      <div
        className="flex h-64 w-full items-center justify-center rounded-lg border border-dashed border-neutral-300 bg-white text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400"
        data-testid={testId}
      >
        No subagent adoption data for the last 30 days.
      </div>
    );
  }

  return (
    <div
      role="img"
      aria-label="Subagent adoption (last 30 days)"
      className="h-64 w-full rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
      style={{ minHeight: '16rem' }}
      data-testid={testId}
    >
      <ResponsiveContainer>
        <LineChart
          data={[...data]}
          margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
        >
          <CartesianGrid stroke="#e5e7eb" strokeDasharray="3 3" />
          <XAxis dataKey="day" stroke="#6b7280" fontSize={11} />
          <YAxis
            stroke="#6b7280"
            fontSize={11}
            tickFormatter={formatPct}
            domain={[0, 100]}
            width={50}
          />
          <Tooltip
            formatter={(value) => [
              typeof value === 'number' ? formatPct(value) : String(value),
              'Subagent adoption',
            ]}
            contentStyle={{ fontSize: 12 }}
          />
          <Line
            type="monotone"
            dataKey="pct"
            stroke="#ea580c"
            strokeWidth={2}
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};
