import type { QuotaHeatmapCell } from '@/lib/queries/quota';

// index = strftime %w (0=Domingo .. 6=Sábado)
const WEEKDAY_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'] as const;

// Ordem de exibição em UI pt-BR: segunda a domingo.
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

const HOURS_PER_DAY = 24;
const HOUR_LABEL_STEP = 6; // exibe rótulo a cada 6h para não poluir

// Returns an inline `background-color` value sourced from a CSS variable so
// the palette responds to `.dark` class changes without needing to re-render
// the component (see globals.css `--quota-heatmap-*`).
const intensityColor = (
  tokens: number,
  thresholds: readonly number[],
): string => {
  if (tokens <= 0) return 'var(--quota-heatmap-empty)';
  if (tokens < thresholds[0]) return 'var(--quota-heatmap-low)';
  if (tokens < thresholds[1]) return 'var(--quota-heatmap-mid-low)';
  if (tokens < thresholds[2]) return 'var(--quota-heatmap-mid-high)';
  return 'var(--quota-heatmap-high)';
};

const computeThresholds = (
  cells: readonly QuotaHeatmapCell[],
): readonly number[] => {
  const tokens = cells
    .map((c) => c.tokens)
    .filter((t) => t > 0)
    .sort((a, b) => a - b);
  if (tokens.length === 0) return [0, 0, 0] as const;
  const last = tokens[tokens.length - 1] ?? 0;
  const q = (p: number): number => {
    const idx = Math.floor(tokens.length * p);
    return tokens[idx] ?? last;
  };
  return [q(0.25), q(0.5), q(0.75)] as const;
};

type Props = { cells: readonly QuotaHeatmapCell[] };

export function QuotaHeatmap({ cells }: Props) {
  if (cells.length === 0) {
    return (
      <section
        aria-label="Padrão de consumo"
        className="space-y-3 rounded-lg border border-neutral-200 bg-white p-6 transition-colors hover:border-neutral-300 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-neutral-700"
      >
        <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
          Padrão de consumo (últimas 4 semanas)
        </h3>
        <p className="text-sm text-neutral-500">
          Sem dados nos últimos 28 dias — rode <code className="font-mono">pnpm ingest</code> pra ver o padrão aqui.
        </p>
      </section>
    );
  }

  const thresholds = computeThresholds(cells);
  const byKey = new Map<string, number>(
    cells.map((c) => [`${c.dow}-${c.hour}`, c.tokens]),
  );

  return (
    <section
      aria-label="Padrão de consumo"
      className="space-y-3 rounded-lg border border-neutral-200 bg-white p-6 transition-colors hover:border-neutral-300 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-neutral-700"
    >
      <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
        Padrão de consumo (últimas 4 semanas)
      </h3>
      {/* Inline-block shrinks the inner grid to its natural width (cells are
          fixed at 12px). The outer <section> card takes the full column
          width via CSS grid; the heatmap grid sits flush-left inside it. */}
      <div className="inline-block rounded border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 p-2">
        {/* Header: horas */}
        <div className="flex gap-0.5 text-[10px] text-neutral-500">
          <span className="w-8" aria-hidden="true" />
          {Array.from({ length: HOURS_PER_DAY }, (_, h) => (
            <span
              key={`hdr-${h}`}
              className="w-3 text-center font-mono"
              aria-hidden="true"
            >
              {h % HOUR_LABEL_STEP === 0 ? h : ''}
            </span>
          ))}
        </div>
        {/* Rows: dias */}
        {DOW_ORDER.map((dow) => (
          <div key={`row-${dow}`} className="mt-0.5 flex items-center gap-0.5">
            <span className="w-8 pr-1 text-right font-mono text-[10px] text-neutral-500">
              {WEEKDAY_LABELS[dow]}
            </span>
            {Array.from({ length: HOURS_PER_DAY }, (_, h) => {
              const tokens = byKey.get(`${dow}-${h}`) ?? 0;
              const title = `${WEEKDAY_LABELS[dow]} ${String(h).padStart(2, '0')}h — ${tokens.toLocaleString('pt-BR')} tokens`;
              return (
                <div
                  key={`cell-${dow}-${h}`}
                  className="h-3 w-3 rounded-sm"
                  style={{ backgroundColor: intensityColor(tokens, thresholds) }}
                  title={title}
                  role="gridcell"
                  aria-label={title}
                />
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}
