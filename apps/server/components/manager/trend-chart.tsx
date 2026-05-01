'use client';

/**
 * Trend chart — Recharts `LineChart` wrapper used by the manager overview
 * (REQ-18 spend trend, REQ-20 DAU trend) and the team detail page (REQ-21
 * spend trend + DAU 30d).
 *
 * Client-only because Recharts uses ResizeObserver / DOM measurement in
 * `ResponsiveContainer`. Keep the component a pure leaf so the parent
 * server pages remain server-rendered and only the chart hydrates.
 *
 * Renders a placeholder when `data` is empty so the page does not collapse
 * to height-0 (REQ-28 empty-state safety; the orchestrating page also
 * guards with `<OnboardingCard />` when the org has zero data overall).
 */
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export type TrendPoint = {
  date: string;
  value: number;
};

/**
 * Serializable formatting hint. A function would be cleaner ergonomically but
 * Next.js 15 forbids passing functions across the Server→Client Component
 * boundary unless they're marked `'use server'`. We accept a string discriminator
 * and resolve to a real formatter inside this client module.
 */
export type TrendValueFormat = 'currency-usd' | 'count';

type Props = {
  data: ReadonlyArray<TrendPoint>;
  label: string;
  /** How to format Y-axis ticks + tooltip values. Defaults to `'count'`. */
  valueFormat?: TrendValueFormat;
  /** Optional `data-testid` for E2E targeting. */
  testId?: string;
};

const formatCurrencyUsd = (n: number): string =>
  n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const formatCount = (n: number): string => n.toLocaleString();

const resolveFormatter = (format: TrendValueFormat): ((n: number) => string) => {
  switch (format) {
    case 'currency-usd':
      return formatCurrencyUsd;
    case 'count':
      return formatCount;
  }
};

export const TrendChart = ({ data, label, valueFormat, testId }: Props) => {
  const fmt = resolveFormatter(valueFormat ?? 'count');

  if (data.length === 0) {
    return (
      <div
        className="flex h-64 w-full items-center justify-center rounded-lg border border-dashed border-neutral-300 bg-white text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400"
        data-testid={testId}
      >
        No data for {label.toLowerCase()} yet.
      </div>
    );
  }

  return (
    <div
      role="img"
      aria-label={label}
      className="h-64 w-full rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
      // Inline min-height belt-and-suspenders for Recharts' ResponsiveContainer.
      // Tailwind's `h-64` applies 16rem, but the inner ResponsiveContainer
      // measures via ResizeObserver and occasionally reports negative dimensions
      // during initial render (visible as the dev-server warning
      // `width(-1) and height(-1) of chart should be greater than 0`). When
      // that happens the SVG can collapse and Playwright's `toBeVisible()`
      // sees a hidden box. Pinning min-height keeps the wrapper measurable
      // even if Recharts is mid-mount.
      style={{ minHeight: '16rem' }}
      data-testid={testId}
    >
      <ResponsiveContainer>
        <LineChart
          data={[...data]}
          margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
        >
          <CartesianGrid stroke="#e5e7eb" strokeDasharray="3 3" />
          <XAxis dataKey="date" stroke="#6b7280" fontSize={11} />
          <YAxis
            stroke="#6b7280"
            fontSize={11}
            tickFormatter={fmt}
            width={60}
          />
          <Tooltip
            formatter={(value) => [
              typeof value === 'number' ? fmt(value) : String(value),
              label,
            ]}
            contentStyle={{ fontSize: 12 }}
          />
          <Line
            type="monotone"
            dataKey="value"
            stroke="#2563eb"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};
