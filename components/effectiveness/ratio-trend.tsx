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
import type { WeeklyRatioPoint } from '@/lib/queries/effectiveness';
import { useChartColors } from '@/lib/chart-colors';

export function RatioTrend({ data }: { data: WeeklyRatioPoint[] }) {
  const c = useChartColors();
  return (
    <div className="h-64 w-full bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-4">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={c.grid} strokeDasharray="3 3" />
          <XAxis dataKey="week" stroke={c.axis} fontSize={11} />
          <YAxis
            stroke={c.axis}
            fontSize={11}
            tickFormatter={(v: number) => v.toFixed(2)}
            width={50}
          />
          <Tooltip
            contentStyle={{
              background: c.tooltipBg,
              border: `1px solid ${c.tooltipBorder}`,
              borderRadius: 6,
              color: c.tooltipText,
            }}
            formatter={(v) => [Number(v).toFixed(2), 'Output/Input']}
          />
          <Line
            type="monotone"
            dataKey="outputInputRatio"
            stroke={c.positive}
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
