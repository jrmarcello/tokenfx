#!/usr/bin/env node
import { getDb } from '@/lib/db/client';
import { ingestAll } from '@/lib/ingest/writer';
import {
  PRICING_LAST_UPDATED,
  STALE_THRESHOLD_DAYS,
  getPricingAgeDays,
} from '@/lib/analytics/pricing';
import { log } from '@tokenfx/shared/logger';

const DEFAULT_OTEL_URL = 'http://localhost:9464/metrics';

const HELP_TEXT = `Usage: pnpm ingest [--force-outcomes] [--help]

Options:
  --force-outcomes  Re-evaluate git outcomes for ALL sessions, ignoring the
                    30-day cutoff. Useful for back-filling older sessions
                    after the outcome feature is enabled or after upgrading
                    the evaluator (REQ-13).
  --help, -h        Print this help text and exit.
`;

interface IngestArgs {
  readonly forceOutcomes: boolean;
  readonly help: boolean;
}

const parseArgs = (argv: readonly string[]): IngestArgs => ({
  forceOutcomes: argv.includes('--force-outcomes'),
  help: argv.includes('--help') || argv.includes('-h'),
});

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    log.info(HELP_TEXT);
    process.exit(0);
  }

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
    forceOutcomes: args.forceOutcomes,
  });
  log.info('ingest summary', summary);
  process.exit(summary.errors.length > 0 ? 1 : 0);
}

main().catch((e: unknown) => {
  log.error('ingest failed', e);
  process.exit(1);
});
