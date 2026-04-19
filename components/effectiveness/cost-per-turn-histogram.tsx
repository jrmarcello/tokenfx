'use client';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
} from 'recharts';

type HistogramDatum = {
  bucket: string;
  count: number;
  lower: number;
  upper: number;
};

export function CostPerTurnHistogram({ data }: { data: HistogramDatum[] }) {
  return (
    <div className="h-64 w-full bg-neutral-900 border border-neutral-800 rounded-lg p-4">
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#262626" strokeDasharray="3 3" />
          <XAxis dataKey="bucket" stroke="#737373" fontSize={11} />
          <YAxis
            stroke="#737373"
            fontSize={11}
            allowDecimals={false}
            width={40}
          />
          <Tooltip
            contentStyle={{
              background: '#171717',
              border: '1px solid #404040',
              borderRadius: 6,
              color: '#e5e5e5',
            }}
            formatter={(v) => [String(v), 'Sessões']}
          />
          <Bar dataKey="count" fill="#a78bfa" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
