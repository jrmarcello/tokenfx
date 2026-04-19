import { cn } from '@/lib/cn';

type PerItemProps = { source: 'otel' | 'local' };
type AggregateProps = { counts: { otel: number; local: number } };
type Props = PerItemProps | AggregateProps;

const isPerItem = (props: Props): props is PerItemProps =>
  'source' in props;

const DOT_BASE = 'inline-block size-2 rounded-full align-middle';

export function CostSourceBadge(props: Props): React.JSX.Element | null {
  if (isPerItem(props)) {
    if (props.source === 'otel') {
      return (
        <span
          role="img"
          aria-label="Custo via OTEL"
          title="Custo via OTEL (fonte: Claude Code telemetry)"
          className={cn(DOT_BASE, 'bg-emerald-500')}
        />
      );
    }
    return (
      <span
        role="img"
        aria-label="Custo via tabela local"
        title="Custo estimado via tabela local (lib/analytics/pricing.ts). Ative OTEL no Claude Code pra custos autoritativos."
        className={cn(DOT_BASE, 'bg-neutral-500')}
      />
    );
  }

  const { otel, local } = props.counts;

  if (otel === 0 && local === 0) {
    return null;
  }

  if (otel > 0 && local === 0) {
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

  if (otel === 0 && local > 0) {
    const label = `${local} sessões via tabela local`;
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        className={cn(DOT_BASE, 'bg-neutral-500')}
      />
    );
  }

  const mixedLabel = `${otel} de ${otel + local} sessões via OTEL; resto via tabela local`;
  return (
    <span
      role="img"
      aria-label={mixedLabel}
      title={mixedLabel}
      className="inline-block size-2 overflow-hidden rounded-full align-middle"
    >
      <svg
        viewBox="0 0 8 8"
        width="8"
        height="8"
        aria-hidden
        className="block"
      >
        <rect x="0" y="0" width="4" height="8" className="fill-emerald-500" />
        <rect x="4" y="0" width="4" height="8" className="fill-neutral-500" />
      </svg>
    </span>
  );
}
