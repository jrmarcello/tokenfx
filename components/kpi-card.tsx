import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { InfoTooltip } from '@/components/info-tooltip';
import { cn } from '@/lib/cn';

type Props = {
  title: string;
  value: React.ReactNode;
  hint?: string;
  info?: React.ReactNode;
  trend?: { delta: number; label: string };
};

export function KpiCard({ title, value, hint, info, trend }: Props) {
  const deltaColor = trend
    ? trend.delta > 0
      ? 'text-red-600 dark:text-red-400'
      : trend.delta < 0
      ? 'text-emerald-600 dark:text-emerald-400'
      : 'text-neutral-600 dark:text-neutral-400'
    : 'text-neutral-600 dark:text-neutral-400';
  return (
    <Card className="bg-white dark:bg-neutral-900 border-neutral-200 dark:border-neutral-800">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-normal text-neutral-600 dark:text-neutral-400 flex items-center gap-1.5">
          <span>{title}</span>
          {info && <InfoTooltip label={`O que é ${title}?`}>{info}</InfoTooltip>}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-semibold tabular-nums tracking-tight">
          {value}
        </div>
        {hint && <div className="text-xs text-neutral-500 mt-2">{hint}</div>}
        {trend && (
          <div className={cn('text-xs mt-2', deltaColor)}>
            {trend.delta > 0 ? '+' : ''}{trend.delta}% {trend.label}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
