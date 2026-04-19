import type { CalibrationEntry } from '@/lib/analytics/cost-calibration';
import { CostSourceBadge } from '@/components/cost-source-badge';

type Props = {
  /** Calibration table contents keyed by family (incl. 'global'). */
  calibration: CalibrationEntry[];
  /** Session count in the 30d window by provenance, to show coverage. */
  coverage: { otel: number; calibrated: number; list: number };
};

const FAMILY_LABEL: Record<CalibrationEntry['family'], string> = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  global: 'Global (fallback)',
};

const fmtRate = (n: number): string => n.toFixed(3);

const fmtTimestamp = (ms: number): string =>
  new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ms));

export function CostSourcesBreakdown({ calibration, coverage }: Props) {
  const total = coverage.otel + coverage.calibrated + coverage.list;

  return (
    <section className="space-y-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-neutral-200">
          Fonte dos custos
        </h2>
        <CostSourceBadge counts={coverage} />
      </header>
      <p className="text-xs text-neutral-500">
        Custos aplicam a cascata <strong>OTEL</strong> (autoridade) →{' '}
        <strong>calibrado</strong> (list × razão aprendida OTEL/local) →{' '}
        <strong>list</strong> (tabela hardcoded). Nos últimos 30 dias:{' '}
        {coverage.otel}/{total} OTEL · {coverage.calibrated}/{total}{' '}
        calibradas · {coverage.list}/{total} via list price.
      </p>

      {calibration.length === 0 ? (
        <p className="text-xs text-neutral-500">
          Nenhuma amostra OTEL ainda — todas as sessões caem pra list
          price. Ative{' '}
          <code className="font-mono">CLAUDE_CODE_ENABLE_TELEMETRY=1</code>
          {' + '}
          <code className="font-mono">OTEL_METRICS_EXPORTER=prometheus</code>{' '}
          em <code className="font-mono">~/.claude/settings.json</code> pra
          começar a calibrar.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-neutral-500">
                <th className="font-normal py-1 pr-4">Família</th>
                <th className="font-normal py-1 pr-4">Rate</th>
                <th className="font-normal py-1 pr-4">Amostras</th>
                <th className="font-normal py-1 pr-4">OTEL total</th>
                <th className="font-normal py-1 pr-4">Local total</th>
                <th className="font-normal py-1">Atualizado</th>
              </tr>
            </thead>
            <tbody className="text-neutral-300">
              {calibration.map((c) => (
                <tr
                  key={c.family}
                  className="border-t border-neutral-800"
                >
                  <td className="py-1 pr-4">{FAMILY_LABEL[c.family]}</td>
                  <td className="py-1 pr-4 tabular-nums">
                    {fmtRate(c.rate)}
                  </td>
                  <td className="py-1 pr-4 tabular-nums">
                    {c.sampleSessionCount}
                  </td>
                  <td className="py-1 pr-4 tabular-nums">
                    ${c.sumOtelCost.toFixed(2)}
                  </td>
                  <td className="py-1 pr-4 tabular-nums">
                    ${c.sumLocalCost.toFixed(2)}
                  </td>
                  <td className="py-1 tabular-nums text-neutral-500">
                    {fmtTimestamp(c.lastUpdatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
