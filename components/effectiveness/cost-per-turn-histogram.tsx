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
import { useChartColors } from '@/lib/chart-colors';

type HistogramDatum = {
  bucket: string;
  count: number;
  lower: number;
  upper: number;
};

export function CostPerTurnHistogram({ data }: { data: HistogramDatum[] }) {
  const c = useChartColors();
  return (
    <div className="h-64 w-full bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-4">
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={c.grid} strokeDasharray="3 3" />
          <XAxis dataKey="bucket" stroke={c.axis} fontSize={11} />
          <YAxis
            stroke={c.axis}
            fontSize={11}
            allowDecimals={false}
            width={40}
          />
          <Tooltip
            contentStyle={{
              background: c.tooltipBg,
              border: `1px solid ${c.tooltipBorder}`,
              borderRadius: 6,
              color: c.tooltipText,
            }}
            formatter={(v) => [String(v), 'Sessões']}
          />
          <Bar dataKey="count" fill={c.lineSecondary} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
