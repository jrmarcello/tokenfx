'use client';
import {
  ComposedChart,
  Scatter,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
} from 'recharts';
import { linearRegression } from '@/lib/analytics/regression';
import { useChartColors } from '@/lib/chart-colors';

type ScatterPoint = {
  sessionId: string;
  cost: number;
  rating: number;
};

type TooltipItem = {
  payload?: ScatterPoint;
};

const truncateSessionId = (id: string): string =>
  id.length > 8 ? id.slice(0, 8) : id;

const formatCost = (v: number): string => `$${v.toFixed(2)}`;

function CustomTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: TooltipItem[];
}) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0]?.payload;
  if (!point) return null;
  return (
    <div className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-xs text-neutral-900 dark:text-neutral-100 shadow-lg tabular-nums">
      <div className="mb-1 font-medium text-neutral-700 dark:text-neutral-300">
        {truncateSessionId(point.sessionId)}
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-neutral-500 dark:text-neutral-400">cost</span>
        <span>{formatCost(point.cost)}</span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-neutral-500 dark:text-neutral-400">rating</span>
        <span>{point.rating.toFixed(1)}</span>
      </div>
    </div>
  );
}

/**
 * Scatter plot of session cost (USD) vs avg rating ([-1, 1]) with an
 * overlaid least-squares regression line. Points fewer than 3 → returns
 * null (regression undefined). When the regression is degenerate (all
 * costs equal → null fit), points are still rendered but the line is
 * skipped.
 *
 * Composition: `ComposedChart` lets us layer a `Scatter` (the points)
 * and a `Line` (the regression segment, expressed as 2 endpoints) on
 * the same numeric x/y axes. `ReferenceLine` would only support a
 * horizontal/vertical line, not the diagonal we need.
 */
export function CostRatingScatter({
  data,
}: {
  data: ScatterPoint[];
}): React.JSX.Element | null {
  const c = useChartColors();

  if (data.length < 3) return null;

  const fit = linearRegression(
    data.map((p) => ({ x: p.cost, y: p.rating })),
  );

  const minX = Math.min(...data.map((p) => p.cost));
  const maxX = Math.max(...data.map((p) => p.cost));

  // Two endpoints span the x-domain so the line crosses the full chart.
  const regressionLine =
    fit !== null
      ? [
          { cost: minX, fitted: fit.slope * minX + fit.intercept },
          { cost: maxX, fitted: fit.slope * maxX + fit.intercept },
        ]
      : [];

  return (
    <div
      role="img"
      aria-label="Cost vs rating scatter chart with regression line"
      className="h-64 w-full rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4"
    >
      <ResponsiveContainer>
        <ComposedChart margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={c.grid} strokeDasharray="3 3" />
          <XAxis
            type="number"
            dataKey="cost"
            stroke={c.axis}
            fontSize={11}
            tickFormatter={formatCost}
            domain={['dataMin', 'dataMax']}
            allowDuplicatedCategory={false}
          />
          <YAxis
            type="number"
            dataKey="rating"
            stroke={c.axis}
            fontSize={11}
            domain={[-1, 1]}
            ticks={[-1, -0.5, 0, 0.5, 1]}
            width={40}
          />
          <Tooltip
            content={<CustomTooltip />}
            cursor={{ stroke: c.tooltipBorder, strokeDasharray: '3 3' }}
          />
          <Scatter
            data={data}
            fill={c.lineSecondary}
            isAnimationActive={false}
          />
          {fit !== null && (
            <Line
              data={regressionLine}
              dataKey="fitted"
              type="linear"
              stroke={c.linePrimary}
              strokeWidth={2}
              dot={false}
              activeDot={false}
              isAnimationActive={false}
              legendType="none"
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
