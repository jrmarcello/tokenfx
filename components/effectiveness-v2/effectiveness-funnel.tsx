export type FunnelStage = {
  stage: string;
  count: number;
};

type Props = { data: FunnelStage[] };

// Mapping de nomes técnicos do estágio (vindo da query SQL) pro label
// human-readable em pt-BR. Falta de match cai no nome cru.
const STAGE_LABELS: Record<string, string> = {
  Started: 'Iniciadas',
  WithEdit: 'Com Edit',
  CacheAboveMedian: 'Cache acima da mediana',
  LowToolErrors: 'Baixa taxa de erro',
};

const labelFor = (stage: string): string => STAGE_LABELS[stage] ?? stage;

const fmtPctOfPrevious = (current: number, previous: number): string => {
  if (previous <= 0) return '0%';
  const pct = (current / previous) * 100;
  // Inteiro quando exato; 1 casa decimal caso contrário. 100% e 0% são
  // os extremos óbvios; valores intermediários ganham precisão sem ruído.
  return Number.isInteger(pct) ? `${pct}%` : `${pct.toFixed(1)}%`;
};

/**
 * Funnel horizontal CSS-only (sem Recharts) das etapas inclusivas
 * cumulativas: Started → WithEdit → CacheAboveMedian → LowToolErrors.
 * Cada barra tem width proporcional ao maior count (tipicamente
 * `data[0]`); estágios com `count=0` renderizam como linha fina pro
 * usuário enxergar a queda visualmente (Q4 LOCKED).
 *
 * Server Component — não usa estado nem efeitos. Tooltip nativo via
 * `<title>` (atributo HTML, não componente React).
 */
export function EffectivenessFunnel({ data }: Props) {
  if (data.length === 0) return null;

  const max = Math.max(...data.map((d) => d.count), 1);

  return (
    <div
      className="space-y-2"
      role="img"
      aria-label={`Funnel de efetividade: ${data
        .map((d) => `${labelFor(d.stage)} ${d.count}`)
        .join(' → ')}`}
    >
      {data.map((d, i) => {
        const pct = (d.count / max) * 100;
        const stageLabel = labelFor(d.stage);
        const previous = i === 0 ? null : data[i - 1];
        const pctOfPrev =
          previous === null || previous === undefined
            ? null
            : fmtPctOfPrevious(d.count, previous.count);
        const sessionWord = d.count === 1 ? 'sessão' : 'sessões';
        const tooltip =
          previous === null || previous === undefined || pctOfPrev === null
            ? `${stageLabel}: ${d.count} ${sessionWord}`
            : `${stageLabel}: ${d.count} ${sessionWord} (${pctOfPrev} de ${labelFor(previous.stage)})`;

        return (
          <div
            key={d.stage}
            className="flex items-center gap-3 text-xs text-neutral-600 dark:text-neutral-400"
          >
            <span className="w-44 truncate font-medium text-neutral-800 dark:text-neutral-200">
              {stageLabel}
            </span>
            <div className="h-5 flex-1 rounded bg-neutral-100 dark:bg-neutral-800">
              <div
                className="h-full min-w-px rounded bg-emerald-500 transition-[width] duration-300 dark:bg-emerald-600"
                style={{ width: `${pct}%` }}
                title={tooltip}
              />
            </div>
            <span className="w-28 text-right tabular-nums">
              {d.count}
              {pctOfPrev !== null && (
                <span className="ml-1 text-neutral-500 dark:text-neutral-500">
                  ({pctOfPrev})
                </span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
