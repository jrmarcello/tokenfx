import type { ScoreBucket } from '@/lib/queries/effectiveness';
import { cn } from '@/lib/cn';

type Props = { buckets: ScoreBucket[] };

// Gradient red → green, left-to-right (low → high scores). Classes literais
// pro Tailwind v4 JIT incluir no build.
const BAR_COLORS = [
  'bg-red-500',
  'bg-orange-500',
  'bg-yellow-500',
  'bg-emerald-400',
  'bg-emerald-600',
] as const;

/**
 * Horizontal bar chart custom (div + flex, sem Recharts) mostrando N
 * sessões por bucket de score (0-20, ..., 80-100). Barras relativas ao
 * bucket com maior contagem (escala local). Cor do bucket reflete a
 * qualidade do score — vermelho (baixo) → verde (alto).
 *
 * Renderiza sempre os 5 buckets (mesmo com count=0) pra deixar o leitor
 * perceber a distribuição completa — ausência de barra num bucket é
 * informação.
 */
export function ScoreDistribution({ buckets }: Props) {
  const max = Math.max(...buckets.map((b) => b.count), 1);
  const total = buckets.reduce((sum, b) => sum + b.count, 0);

  if (total === 0) {
    return (
      <p className="text-sm text-neutral-500">
        Sem sessões pontuadas na janela.
      </p>
    );
  }

  return (
    <div
      className="space-y-2"
      role="img"
      aria-label={`Distribuição de ${total} sessões por faixa de score`}
    >
      {buckets.map((b, i) => {
        const pct = (b.count / max) * 100;
        return (
          <div
            key={b.label}
            className="flex items-center gap-3 text-xs text-neutral-600 dark:text-neutral-400"
          >
            <span className="w-14 tabular-nums font-mono text-right">
              {b.label}
            </span>
            <div className="h-5 flex-1 rounded bg-neutral-100 dark:bg-neutral-800">
              <div
                className={cn(
                  'h-full rounded transition-[width] duration-300',
                  BAR_COLORS[i],
                )}
                style={{ width: `${pct}%` }}
                title={`${b.count} ${b.count === 1 ? 'sessão' : 'sessões'} (${b.label})`}
              />
            </div>
            <span className="w-12 text-right tabular-nums">{b.count}</span>
          </div>
        );
      })}
    </div>
  );
}
