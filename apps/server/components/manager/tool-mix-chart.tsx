'use client';

/**
 * Tool-mix stacked-bar chart — manager-dashboard-v2 REQ-3.
 *
 * Renders a Recharts `BarChart` with one bar per day across the 30-day window
 * and 5 stacked segments per bar — `Edit / Read / Bash / Agent / Other` —
 * matching the closed enum in `lib/analytics/tool-mix.ts`.
 *
 * Client-only because Recharts uses ResizeObserver via `ResponsiveContainer`.
 * Data shape mirrors `TeamToolMixPoint` from `lib/queries/manager-v2.ts` so
 * the page can pass query rows directly.
 *
 * Empty-data placeholder is rendered the same way as the existing
 * `<TrendChart>` so the page does not collapse to height-0 (REQ-28 safety).
 */
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export type ToolMixPoint = {
  day: string;
  Edit: number;
  Read: number;
  Bash: number;
  Agent: number;
  Other: number;
};

type Props = {
  data: ReadonlyArray<ToolMixPoint>;
  testId?: string;
};

// Stable, tailwind-neutral hex colors so the SSR-rendered SVG matches the
// hydrated client SVG (no flicker). Picked from the same palette as
// `<TrendChart>` (`#2563eb`) for visual consistency with the rest of the
// manager dashboard.
const SEGMENT_COLORS: Record<keyof Omit<ToolMixPoint, 'day'>, string> = {
  Edit: '#2563eb',
  Read: '#16a34a',
  Bash: '#9333ea',
  Agent: '#ea580c',
  Other: '#6b7280',
};

const SEGMENT_KEYS = ['Edit', 'Read', 'Bash', 'Agent', 'Other'] as const;

export const ToolMixChart = ({ data, testId }: Props) => {
  if (data.length === 0) {
    return (
      <div
        className="flex h-64 w-full items-center justify-center rounded-lg border border-dashed border-neutral-300 bg-white text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400"
        data-testid={testId}
      >
        No tool-mix data for the last 30 days.
      </div>
    );
  }

  return (
    <div
      role="img"
      aria-label="Tool mix (last 30 days)"
      className="h-64 w-full rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
      style={{ minHeight: '16rem' }}
      data-testid={testId}
    >
      <ResponsiveContainer>
        <BarChart
          data={[...data]}
          margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
        >
          <CartesianGrid stroke="#e5e7eb" strokeDasharray="3 3" />
          <XAxis dataKey="day" stroke="#6b7280" fontSize={11} />
          <YAxis stroke="#6b7280" fontSize={11} width={40} />
          <Tooltip contentStyle={{ fontSize: 12 }} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {SEGMENT_KEYS.map((key) => (
            <Bar
              key={key}
              dataKey={key}
              stackId="tools"
              fill={SEGMENT_COLORS[key]}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
};
