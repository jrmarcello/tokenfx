'use client';
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import {
  MODEL_FAMILY_COLORS,
  type ModelBreakdownItem,
} from '@/lib/analytics/model';
import { fmtUsdFine, fmtPct } from '@/lib/fmt';
import { useChartColors } from '@/lib/chart-colors';

type Props = { items: ModelBreakdownItem[] };

const formatTooltip = (
  value: unknown,
  _name: unknown,
  entry: { payload?: ModelBreakdownItem },
): [string, string] => {
  const cost = typeof value === 'number' ? value : Number(value ?? 0);
  const pct = entry.payload?.pct ?? 0;
  return [`${fmtUsdFine(cost)} (${fmtPct(pct)})`, entry.payload?.family ?? ''];
};

export function ModelBreakdown({ items }: Props) {
  const c = useChartColors();
  if (items.length === 0) return null;

  if (items.length === 1) {
    const only = items[0];
    return (
      <div className="h-64 w-full bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-4 flex items-center justify-center">
        <div className="text-center">
          <div className="text-sm text-neutral-600 dark:text-neutral-400 mb-1">
            {fmtPct(only.pct)} em {only.family}
          </div>
          <div className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">
            {fmtUsdFine(only.cost)}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-64 w-full bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-4">
      <ResponsiveContainer>
        <PieChart margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <Pie
            data={items}
            dataKey="cost"
            nameKey="family"
            innerRadius={40}
            outerRadius={80}
            stroke={c.pieStroke}
            strokeWidth={2}
          >
            {items.map((item) => (
              <Cell
                key={item.family}
                fill={MODEL_FAMILY_COLORS[item.family]}
              />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              background: c.tooltipBg,
              border: `1px solid ${c.tooltipBorder}`,
              borderRadius: 6,
              color: c.tooltipText,
            }}
            formatter={formatTooltip}
          />
          <Legend
            verticalAlign="bottom"
            height={24}
            iconType="circle"
            wrapperStyle={{ color: c.tooltipText, fontSize: 11 }}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
