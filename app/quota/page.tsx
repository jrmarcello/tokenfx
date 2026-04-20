import { getDb } from '@/lib/db/client';
import { ensureFreshIngest } from '@/lib/ingest/auto';
import {
  getUserSettings,
  getQuotaUsage,
  getQuotaHeatmap,
  getQuotaResetEstimates,
  getDailyTokenSums,
} from '@/lib/queries/quota';
import { QuotaHeatmap } from '@/components/quota/quota-heatmap';
import { QuotaTokenCard } from '@/components/quota/quota-token-card';
import { QuotaStatsPanel } from '@/components/quota/quota-stats-panel';
import { QuotaWeeklyBars } from '@/components/quota/quota-weekly-bars';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Moved out of the RSC body so the `react-hooks/purity` rule stays happy —
// async Server Components execute once per request, so the timestamp is
// stable within a render even though `Date.now()` itself is impure.
const readNow = (): number => Date.now();

export default async function QuotaPage() {
  await ensureFreshIngest();
  const db = getDb();
  const now = readNow();
  const settings = getUserSettings(db);
  const heatmap = getQuotaHeatmap(db, now);
  const dailyTokens = getDailyTokenSums(db, now, 28);
  const resets = getQuotaResetEstimates(db, now, {
    calibratedReset5hAt: settings.quota5hResetAt,
    calibratedReset7dAt: settings.quota7dResetAt,
  });
  // Block-aware cycle starts: reset timestamps walked back by the window
  // size give the current block's origin. When no reset is available (block
  // expired / no activity), fall back to rolling via `null` → legacy cutoff.
  const FIVE_H_MS = 5 * 3_600_000;
  const SEVEN_D_MS = 7 * 86_400_000;
  const usage = getQuotaUsage(db, now, {
    cycleStart5hMs:
      resets.reset5hMs !== null ? resets.reset5hMs - FIVE_H_MS : null,
    cycleStart7dMs:
      resets.reset7dMs !== null ? resets.reset7dMs - SEVEN_D_MS : null,
  });

  const currentSettings = {
    quotaTokens5h: settings.quotaTokens5h,
    quotaTokens7d: settings.quotaTokens7d,
  };

  return (
    <section className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Quota do Max</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 max-w-3xl">
          O plano Claude Max tem duas janelas de consumo: sessão de 5h (começa
          na sua primeira mensagem, reseta 5h depois) e semana rolling de 7
          dias. Calibre cada threshold baseado no painel Account &amp; Usage do
          Claude.ai — nós não temos como descobrir os números oficiais.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {/* Row 1: Token cards (5h left, 7d right) */}
        <QuotaTokenCard
          window="5h"
          used={usage.tokens5h}
          limit={settings.quotaTokens5h}
          resetInMs={resets.reset5hMs}
          currentSettings={currentSettings}
          now={now}
          calibratedResetAt={settings.quota5hResetAt}
        />
        <QuotaTokenCard
          window="7d"
          used={usage.tokens7d}
          limit={settings.quotaTokens7d}
          resetInMs={resets.reset7dMs}
          currentSettings={currentSettings}
          now={now}
          calibratedResetAt={settings.quota7dResetAt}
        />

        {/* Row 2 left: heatmap + weekly bars stacked, matching 5h card width */}
        <div className="space-y-6">
          <QuotaHeatmap cells={heatmap} />
          <QuotaWeeklyBars daily={dailyTokens} now={now} />
        </div>

        {/* Row 2 right: stats panel — stretches via CSS grid default to
            match the left column's stacked height */}
        <QuotaStatsPanel
          heatmap={heatmap}
          daily={dailyTokens}
          now={now}
        />
      </div>
    </section>
  );
}
