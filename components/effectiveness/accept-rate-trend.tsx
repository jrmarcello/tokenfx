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

export function AcceptRateTrend({ data }: { data: WeeklyAcceptRatePoint[] }) {
  return (
    <div className="h-64 w-full rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <ResponsiveContainer>
        <LineChart
          data={data}
          margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
        >
          <CartesianGrid stroke="#262626" strokeDasharray="3 3" />
          <XAxis
            dataKey="week"
            stroke="#737373"
            fontSize={11}
            tickFormatter={(v: string) => v}
          />
          <YAxis
            stroke="#737373"
            fontSize={11}
            domain={[0, 1]}
            tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
            width={40}
          />
          <Tooltip
            contentStyle={{
              background: '#171717',
              border: '1px solid #404040',
              borderRadius: 6,
              color: '#e5e5e5',
            }}
            formatter={(v) => [`${(Number(v) * 100).toFixed(1)}%`, 'Accept rate']}
          />
          <Line
            type="monotone"
            dataKey="acceptRate"
            stroke="#34d399"
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
