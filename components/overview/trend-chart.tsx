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

export function TrendChart({ data }: { data: DailyPoint[] }) {
  return (
    <div className="h-64 w-full bg-neutral-900 border border-neutral-800 rounded-lg p-4">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#262626" strokeDasharray="3 3" />
          <XAxis
            dataKey="date"
            stroke="#737373"
            fontSize={11}
            tickFormatter={(v: string) => v.slice(5)}
          />
          <YAxis
            stroke="#737373"
            fontSize={11}
            tickFormatter={(v: number) => `$${v.toFixed(2)}`}
            width={50}
          />
          <Tooltip
            contentStyle={{
              background: '#171717',
              border: '1px solid #404040',
              borderRadius: 6,
              color: '#e5e5e5',
            }}
            formatter={(v) => [`$${Number(v).toFixed(2)}`, 'Spend']}
          />
          <Line
            type="monotone"
            dataKey="spend"
            stroke="#a78bfa"
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
