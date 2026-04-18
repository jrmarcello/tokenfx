#!/usr/bin/env node
import { getDb } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';
import { ingestAll } from '@/lib/ingest/writer';
import { log } from '@/lib/logger';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const watch = args.includes('--watch');
  const otelUrl = process.env.OTEL_SCRAPE_URL;
  const db = getDb();
  migrate(db);

  if (watch) {
    log.warn('watch mode: not implemented yet; running single pass');
  }

  const summary = await ingestAll({ db, otelUrl });
  log.info('ingest summary', summary);
  process.exit(summary.errors.length > 0 ? 1 : 0);
}

main().catch((e: unknown) => {
  log.error('ingest failed', e);
  process.exit(1);
});
