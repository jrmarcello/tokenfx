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

export function RatioTrend({ data }: { data: WeeklyRatioPoint[] }) {
  return (
    <div className="h-64 w-full bg-neutral-900 border border-neutral-800 rounded-lg p-4">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#262626" strokeDasharray="3 3" />
          <XAxis dataKey="week" stroke="#737373" fontSize={11} />
          <YAxis
            stroke="#737373"
            fontSize={11}
            tickFormatter={(v: number) => v.toFixed(2)}
            width={50}
          />
          <Tooltip
            contentStyle={{
              background: '#171717',
              border: '1px solid #404040',
              borderRadius: 6,
              color: '#e5e5e5',
            }}
            formatter={(v) => [Number(v).toFixed(2), 'Output/Input']}
          />
          <Line
            type="monotone"
            dataKey="outputInputRatio"
            stroke="#34d399"
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
