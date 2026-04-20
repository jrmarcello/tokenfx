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
import type { DailyPoint } from '@/lib/queries/overview';
import type { DailyAcceptRatePoint } from '@/lib/queries/overview';
import { useChartColors } from '@/lib/chart-colors';

type Datum = {
  date: string;
  spend: number;
  acceptRate: number | null;
};

type Props = {
  daily: DailyPoint[];
  acceptRateDaily: DailyAcceptRatePoint[] | null;
};

/**
 * Daily consumption trend — primary signal is cost/day. When OTEL is on
 * and has decisions in the window, overlays accept rate as a second
 * series on a right Y-axis (0-1). Gracefully degrades to single-axis
 * when `acceptRateDaily` is null or empty.
 */
export function DailyConsumptionTrend({ daily, acceptRateDaily }: Props) {
  const c = useChartColors();
  const hasAccept =
    acceptRateDaily !== null &&
    acceptRateDaily.length > 0 &&
    acceptRateDaily.some((p) => p.acceptRate !== null);

  // Merge by date so Recharts renders both series on the same X axis.
  const byDate = new Map<string, Datum>(
    daily.map((d) => ({ date: d.date, spend: d.spend, acceptRate: null })).map(
      (d) => [d.date, d],
    ),
  );
  if (acceptRateDaily) {
    for (const p of acceptRateDaily) {
      const existing = byDate.get(p.date);
      if (existing) existing.acceptRate = p.acceptRate;
      else
        byDate.set(p.date, {
          date: p.date,
          spend: 0,
          acceptRate: p.acceptRate,
        });
    }
  }
  const merged = Array.from(byDate.values()).sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  return (
    <div className="h-64 w-full rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
      <ResponsiveContainer>
        <LineChart
          data={merged}
          margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
        >
          <CartesianGrid stroke={c.grid} strokeDasharray="3 3" />
          <XAxis
            dataKey="date"
            stroke={c.axis}
            fontSize={11}
            tickFormatter={(v: string) => v.slice(5)}
          />
          <YAxis
            yAxisId="cost"
            stroke={c.axis}
            fontSize={11}
            tickFormatter={(v: number) => `$${v.toFixed(2)}`}
            width={50}
          />
          {hasAccept && (
            <YAxis
              yAxisId="rate"
              orientation="right"
              stroke={c.axis}
              fontSize={11}
              domain={[0, 1]}
              tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
              width={40}
            />
          )}
          <Tooltip
            contentStyle={{
              background: c.tooltipBg,
              border: `1px solid ${c.tooltipBorder}`,
              borderRadius: 6,
              color: c.tooltipText,
            }}
            formatter={(value, name) => {
              if (name === 'Accept rate') {
                const v = Number(value);
                return Number.isFinite(v) ? [`${(v * 100).toFixed(1)}%`, name] : ['—', name];
              }
              return [`$${Number(value).toFixed(2)}`, name];
            }}
          />
          {hasAccept && (
            <Legend
              wrapperStyle={{ fontSize: 11, color: c.tooltipText }}
              iconType="plainline"
            />
          )}
          <Line
            yAxisId="cost"
            name="Custo"
            type="monotone"
            dataKey="spend"
            stroke={c.lineSecondary}
            strokeWidth={2}
            dot={false}
          />
          {hasAccept && (
            <Line
              yAxisId="rate"
              name="Accept rate"
              type="monotone"
              dataKey="acceptRate"
              stroke={c.positive}
              strokeWidth={2}
              strokeDasharray="4 2"
              dot={false}
              connectNulls={false}
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
