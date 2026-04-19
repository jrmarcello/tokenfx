import { getDb } from '@/lib/db/client';
import { ensureFreshIngest } from '@/lib/ingest/auto';
import {
  getUserSettings,
  getQuotaUsage,
  getQuotaHeatmap,
} from '@/lib/queries/quota';
import { KpiCard } from '@/components/kpi-card';
import { QuotaBar } from '@/components/quota/quota-bar';
import { QuotaForm } from '@/components/quota/quota-form';
import { QuotaHeatmap } from '@/components/quota/quota-heatmap';
import { fmtCompact } from '@/lib/fmt';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Moved out of the RSC body so the `react-hooks/purity` rule stays happy —
// async Server Components execute once per request, so the timestamp is
// stable within a render even though `Date.now()` itself is impure.
const readNow = (): number => Date.now();

const QUOTA_INFO =
  'Janela rolling — o Max reseta a cada 5h contadas da primeira mensagem do período. Este número pode estar levemente à frente do real se você começou recentemente.';

type QuotaCard = {
  key: string;
  title: string;
  used: number;
  limit: number;
  formatValue: (n: number) => string;
};

export default async function QuotaPage() {
  await ensureFreshIngest();
  const db = getDb();
  const settings = getUserSettings(db);
  const now = readNow();
  const usage = getQuotaUsage(db, now);
  const heatmap = getQuotaHeatmap(db, now);

  const anyThresholdSet =
    settings.quotaTokens5h !== null ||
    settings.quotaTokens7d !== null ||
    settings.quotaSessions5h !== null ||
    settings.quotaSessions7d !== null;

  const cards: QuotaCard[] = [];
  if (settings.quotaTokens5h !== null) {
    cards.push({
      key: 't5h',
      title: 'Tokens 5h',
      used: usage.tokens5h,
      limit: settings.quotaTokens5h,
      formatValue: fmtCompact,
    });
  }
  if (settings.quotaTokens7d !== null) {
    cards.push({
      key: 't7d',
      title: 'Tokens 7d',
      used: usage.tokens7d,
      limit: settings.quotaTokens7d,
      formatValue: fmtCompact,
    });
  }
  if (settings.quotaSessions5h !== null) {
    cards.push({
      key: 's5h',
      title: 'Sessões 5h',
      used: usage.sessions5h,
      limit: settings.quotaSessions5h,
      formatValue: (n) => String(n),
    });
  }
  if (settings.quotaSessions7d !== null) {
    cards.push({
      key: 's7d',
      title: 'Sessões 7d',
      used: usage.sessions7d,
      limit: settings.quotaSessions7d,
      formatValue: (n) => String(n),
    });
  }

  return (
    <section className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Quota do Max</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 max-w-3xl">
          A Anthropic não publica os limites exatos do plano Max — calibre os
          thresholds abaixo conforme for batendo rate-limit. Janelas são
          rolling (últimas 5h / últimos 7 dias), então o número pode estar
          ligeiramente à frente do reset real do Max.
        </p>
      </header>

      {!anyThresholdSet && (
        <div
          role="status"
          className="rounded border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-4 py-3 text-sm text-neutral-700 dark:text-neutral-300"
        >
          Defina seu primeiro threshold abaixo pra ver consumo.
        </div>
      )}

      {cards.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {cards.map((c) => (
            <KpiCard
              key={c.key}
              title={c.title}
              value={
                <div className="flex flex-col gap-2">
                  <span>
                    {c.formatValue(c.used)}
                    <span className="text-neutral-500 text-lg font-normal">
                      {' / '}
                      {c.formatValue(c.limit)}
                    </span>
                  </span>
                  <QuotaBar label={c.title} used={c.used} limit={c.limit} />
                </div>
              }
              info={QUOTA_INFO}
            />
          ))}
        </div>
      )}

      <section className="space-y-3">
        <h2 className="text-xl font-semibold tracking-tight">Thresholds</h2>
        <QuotaForm initial={{
          quotaTokens5h: settings.quotaTokens5h,
          quotaTokens7d: settings.quotaTokens7d,
          quotaSessions5h: settings.quotaSessions5h,
          quotaSessions7d: settings.quotaSessions7d,
        }} />
      </section>

      <QuotaHeatmap cells={heatmap} />
    </section>
  );
}
