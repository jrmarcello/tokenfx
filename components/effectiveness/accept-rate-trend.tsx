'use client';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
} from 'recharts';
import type { WeeklyAcceptRatePoint } from '@/lib/queries/otel';
import { useChartColors } from '@/lib/chart-colors';

export function AcceptRateTrend({ data }: { data: WeeklyAcceptRatePoint[] }) {
  const c = useChartColors();
  return (
    <div className="h-64 w-full rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
      <ResponsiveContainer>
        <LineChart
          data={data}
          margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
        >
          <CartesianGrid stroke={c.grid} strokeDasharray="3 3" />
          <XAxis
            dataKey="week"
            stroke={c.axis}
            fontSize={11}
            tickFormatter={(v: string) => v}
          />
          <YAxis
            stroke={c.axis}
            fontSize={11}
            domain={[0, 1]}
            tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
            width={40}
          />
          <Tooltip
            contentStyle={{
              background: c.tooltipBg,
              border: `1px solid ${c.tooltipBorder}`,
              borderRadius: 6,
              color: c.tooltipText,
            }}
            formatter={(v) => [`${(Number(v) * 100).toFixed(1)}%`, 'Accept rate']}
          />
          <Line
            type="monotone"
            dataKey="acceptRate"
            stroke={c.positive}
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
