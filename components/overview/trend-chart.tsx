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
import type { DailyPoint } from '@/lib/queries/overview';
import { useChartColors } from '@/lib/chart-colors';

export function TrendChart({ data }: { data: DailyPoint[] }) {
  const c = useChartColors();
  return (
    <div className="h-64 w-full bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-4">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={c.grid} strokeDasharray="3 3" />
          <XAxis
            dataKey="date"
            stroke={c.axis}
            fontSize={11}
            tickFormatter={(v: string) => v.slice(5)}
          />
          <YAxis
            stroke={c.axis}
            fontSize={11}
            tickFormatter={(v: number) => `$${v.toFixed(2)}`}
            width={50}
          />
          <Tooltip
            contentStyle={{
              background: c.tooltipBg,
              border: `1px solid ${c.tooltipBorder}`,
              borderRadius: 6,
              color: c.tooltipText,
            }}
            formatter={(v) => [`$${Number(v).toFixed(2)}`, 'Custo']}
          />
          <Line
            type="monotone"
            dataKey="spend"
            stroke={c.lineSecondary}
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
