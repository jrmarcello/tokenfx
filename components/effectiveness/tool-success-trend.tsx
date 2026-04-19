'use client';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import type { ToolTrendResult } from '@/lib/queries/effectiveness';
import {
  colorForTool,
  MIN_CALLS_PER_BUCKET,
} from '@/lib/analytics/tool-trend';
import { useChartColors } from '@/lib/chart-colors';

type TooltipItem = {
  dataKey?: string | number;
  value?: number | string | null;
  name?: string;
  color?: string;
  payload?: {
    week: string;
    rates: Record<string, number | null>;
    counts: Record<string, { calls: number; errors: number }>;
  };
};

function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipItem[];
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0]?.payload;
  if (!point) return null;
  return (
    <div className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-xs text-neutral-900 dark:text-neutral-100 shadow-lg">
      <div className="mb-1 font-medium text-neutral-700 dark:text-neutral-300">{label}</div>
      <ul className="space-y-1">
        {Object.keys(point.counts).map((tool) => {
          const rate = point.rates[tool];
          const c = point.counts[tool];
          return (
            <li
              key={tool}
              className="flex items-center justify-between gap-3 tabular-nums"
            >
              <span
                className="inline-flex items-center gap-1.5"
                style={{ color: colorForTool(tool) }}
              >
                <span
                  aria-hidden
                  className="inline-block size-2 rounded-full"
                  style={{ background: colorForTool(tool) }}
                />
                {tool}
              </span>
              <span className="text-neutral-700 dark:text-neutral-300">
                {rate === null
                  ? `calls insuficientes (${c.calls})`
                  : `${(rate * 100).toFixed(1)}% · ${c.errors}/${c.calls}`}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function ToolSuccessTrend({ data }: { data: ToolTrendResult }) {
  const c = useChartColors();
  if (data.tools.length === 0 || data.points.length === 0) return null;
  return (
    <div
      role="img"
      aria-label={`Tendência semanal de taxa de erro por ferramenta. Dados suprimidos quando a semana tem menos de ${MIN_CALLS_PER_BUCKET} chamadas pra aquela ferramenta.`}
      className="h-64 w-full rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4"
    >
      <ResponsiveContainer>
        <LineChart
          data={data.points}
          margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
        >
          <CartesianGrid stroke={c.grid} strokeDasharray="3 3" />
          <XAxis dataKey="week" stroke={c.axis} fontSize={11} />
          <YAxis
            stroke={c.axis}
            fontSize={11}
            domain={[0, 1]}
            tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
            width={40}
          />
          <Tooltip
            content={<CustomTooltip />}
            cursor={{ stroke: c.tooltipBorder, strokeDasharray: '3 3' }}
          />
          <Legend
            wrapperStyle={{ fontSize: 11, color: c.axis }}
            iconType="plainline"
          />
          {data.tools.map((tool) => (
            <Line
              key={tool}
              name={tool}
              type="monotone"
              dataKey={`rates.${tool}`}
              stroke={colorForTool(tool)}
              strokeWidth={2}
              dot={false}
              connectNulls={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
