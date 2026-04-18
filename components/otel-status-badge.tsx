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
      <InfoTooltip label={active ? 'OTEL ativo' : 'OTEL inativo'}>
        {active ? (
          <>
            Claude Code está exportando métricas Prometheus em{' '}
            <code className="font-mono text-neutral-300">
              localhost:9464/metrics
            </code>
            . Ingerimos sinais extras como accept/reject de Edit/Write,
            linhas alteradas, commits e active_time.
          </>
        ) : (
          <>
            Claude Code não está exportando Prometheus. Para ativar, no
            shell onde você roda o Claude Code:{' '}
            <code className="font-mono text-neutral-300">
              export CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_METRICS_EXPORTER=prometheus
            </code>
            . Os transcripts JSONL cobrem o essencial — OTEL é um bônus.
          </>
        )}
      </InfoTooltip>
    </span>
  );
}
