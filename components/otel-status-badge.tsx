import { InfoTooltip } from '@/components/info-tooltip';
import { isOtelReachable } from '@/lib/otel-status';
import { cn } from '@/lib/cn';

export async function OtelStatusBadge() {
  const active = await isOtelReachable();
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-neutral-500">
      <span
        aria-hidden
        className={cn(
          'size-2 rounded-full',
          active
            ? 'bg-emerald-500 shadow-[0_0_6px] shadow-emerald-500/60'
            : 'bg-neutral-700',
        )}
      />
      <span>OTEL {active ? 'on' : 'off'}</span>
      <InfoTooltip
        label={active ? 'OTEL ativo' : 'OTEL inativo'}
        side="bottom"
        align="end"
      >
        {active ? (
          <>
            Claude Code está exportando métricas Prometheus em{' '}
            <code className="font-mono text-neutral-300">
              localhost:9464/metrics
            </code>
            . Ingerimos sinais extras (accept/reject, linhas, commits,
            cost autoritativo).{' '}
            <strong>Limitação conhecida:</strong> o exporter Prometheus usa
            porta fixa, então se você tiver mais de um processo Claude
            ativo ao mesmo tempo, só o primeiro ganha a porta — os outros
            rodam sem telemetria. Por isso às vezes só uma de N sessões
            ativas aparece com badge OTEL.
          </>
        ) : (
          <>
            Claude Code não está exportando Prometheus agora. O endpoint
            só existe enquanto um processo <code>claude</code> está vivo.
            Para ativar permanentemente, edite{' '}
            <code className="font-mono text-neutral-300">
              ~/.claude/settings.json
            </code>{' '}
            e adicione{' '}
            <code className="font-mono text-neutral-300">
              {'{ "env": { "CLAUDE_CODE_ENABLE_TELEMETRY": "1", "OTEL_METRICS_EXPORTER": "prometheus" } }'}
            </code>
            . Os transcripts JSONL cobrem o essencial — OTEL é um bônus.
          </>
        )}
      </InfoTooltip>
    </span>
  );
}
