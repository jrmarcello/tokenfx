#!/usr/bin/env node
import { getDb } from '@/lib/db/client';
import { ingestAll } from '@/lib/ingest/writer';
import {
  PRICING_LAST_UPDATED,
  STALE_THRESHOLD_DAYS,
  getPricingAgeDays,
} from '@/lib/analytics/pricing';
import { log } from '@/lib/logger';

const DEFAULT_OTEL_URL = 'http://localhost:9464/metrics';

async function main(): Promise<void> {
  // Auto-detect OTEL: try the default Prometheus endpoint that Claude Code
  // exposes when telemetry is enabled. If it isn't up, the fetch fails fast
  // (1s timeout) and transcript ingestion still succeeds.
  const otelUrl = process.env.OTEL_SCRAPE_URL ?? DEFAULT_OTEL_URL;
  const db = getDb();

  const age = getPricingAgeDays();
  if (age > STALE_THRESHOLD_DAYS) {
    log.warn(
      `[pricing] table last reviewed ${age} days ago (${PRICING_LAST_UPDATED}). ` +
        `Costs may be inaccurate — audit lib/analytics/pricing.ts against ` +
        `https://www.anthropic.com/pricing.`,
    );
  }

  const summary = await ingestAll({
    db,
    otelUrl,
    otelOptional: true,
    otelTimeoutMs: 1000,
  });
  log.info('ingest summary', summary);
  process.exit(summary.errors.length > 0 ? 1 : 0);
}

main().catch((e: unknown) => {
  log.error('ingest failed', e);
  process.exit(1);
});
