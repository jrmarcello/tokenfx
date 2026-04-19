import { cn } from '@/lib/cn';
import type { CostSource } from '@/lib/analytics/cost-calibration';

type PerItemProps = { source: CostSource };
type AggregateProps = {
  counts: { otel: number; calibrated: number; list: number };
};
type Props = PerItemProps | AggregateProps;

const isPerItem = (props: Props): props is PerItemProps =>
  'source' in props;

const DOT_BASE = 'inline-block size-2 rounded-full align-middle';

const TITLES: Record<CostSource, string> = {
  otel: 'Custo via OTEL (fonte: Claude Code telemetry)',
  calibrated:
    'Custo calibrado — list price multiplicado pela razão OTEL/local aprendida das suas sessões. Mais sessões com OTEL ativo refinam a estimativa.',
  list: 'Custo estimado via tabela local (lib/analytics/pricing.ts). Ative OTEL no Claude Code pra custos autoritativos.',
};

const COLORS: Record<CostSource, string> = {
  otel: 'bg-emerald-500',
  calibrated: 'bg-amber-500',
  list: 'bg-neutral-500',
};

const ARIA: Record<CostSource, string> = {
  otel: 'Custo via OTEL',
  calibrated: 'Custo calibrado',
  list: 'Custo via tabela local',
};

export function CostSourceBadge(props: Props): React.JSX.Element | null {
  if (isPerItem(props)) {
    return (
      <span
        role="img"
        aria-label={ARIA[props.source]}
        title={TITLES[props.source]}
        className={cn(DOT_BASE, COLORS[props.source])}
      />
    );
  }

  const { otel, calibrated, list } = props.counts;
  const total = otel + calibrated + list;
  if (total === 0) return null;

  // Single-source aggregate: show one dot in that color.
  if (otel === total) {
    const label = `${otel} sessões via OTEL`;
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        className={cn(DOT_BASE, 'bg-emerald-500')}
      />
    );
  }
  if (calibrated === total) {
    const label = `${calibrated} sessões via calibração`;
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        className={cn(DOT_BASE, 'bg-amber-500')}
      />
    );
  }
  if (list === total) {
    const label = `${list} sessões via tabela local`;
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        className={cn(DOT_BASE, 'bg-neutral-500')}
      />
    );
  }

  // Mixed — build a striped dot showing the dominant source up front and
  // a tooltip that itemizes all three counts.
  const parts: string[] = [];
  if (otel > 0) parts.push(`${otel} OTEL`);
  if (calibrated > 0) parts.push(`${calibrated} calibradas`);
  if (list > 0) parts.push(`${list} list price`);
  const mixedLabel = `Mix de fontes: ${parts.join(' · ')} (total ${total})`;

  return (
    <span
      role="img"
      aria-label={mixedLabel}
      title={mixedLabel}
      className="inline-block size-2 overflow-hidden rounded-full align-middle"
    >
      <svg
        viewBox="0 0 9 8"
        width="9"
        height="8"
        aria-hidden
        className="block"
      >
        {otel > 0 && (
          <rect
            x="0"
            y="0"
            width={(otel / total) * 9}
            height="8"
            className="fill-emerald-500"
          />
        )}
        {calibrated > 0 && (
          <rect
            x={(otel / total) * 9}
            y="0"
            width={(calibrated / total) * 9}
            height="8"
            className="fill-amber-500"
          />
        )}
        {list > 0 && (
          <rect
            x={((otel + calibrated) / total) * 9}
            y="0"
            width={(list / total) * 9}
            height="8"
            className="fill-neutral-500"
          />
        )}
      </svg>
    </span>
  );
}
