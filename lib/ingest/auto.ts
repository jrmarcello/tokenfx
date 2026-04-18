import { statSync } from 'node:fs';
import { getDb } from '@/lib/db/client';
import { listTranscriptFiles } from '@/lib/fs-paths';
import { ingestAll, type IngestSummary } from '@/lib/ingest/writer';
import { log } from '@/lib/logger';

/**
 * Default Prometheus endpoint served by Claude Code when
 * `OTEL_METRICS_EXPORTER=prometheus` is enabled. Override with
 * `OTEL_SCRAPE_URL` if you bind to a different host/port.
 */
const DEFAULT_OTEL_URL = 'http://localhost:9464/metrics';

let inflight: Promise<IngestSummary | null> | null = null;

/**
 * Transparently re-ingest transcripts + OTEL metrics when the on-disk JSONL
 * files have been modified since the last successful ingest. Called at the
 * top of every Server Component page so the dashboard always reflects the
 * most recent Claude Code activity without the user thinking about it.
 *
 * - Coalesces concurrent callers (multiple pages rendering in parallel).
 * - mtime check is cheap (one stat per transcript file).
 * - Ingest itself only runs when there's something new to pick up.
 * - OTEL is auto-detected with a 1s timeout; when the endpoint isn't
 *   reachable the ingest still succeeds (transcripts are the primary source).
 */
export async function ensureFreshIngest(): Promise<void> {
  if (inflight) {
    await inflight;
    return;
  }
  inflight = run();
  try {
    await inflight;
  } finally {
    inflight = null;
  }
}

async function run(): Promise<IngestSummary | null> {
  try {
    const db = getDb();
    const files = await listTranscriptFiles();
    if (files.length === 0) return null;

    let newestJsonl = 0;
    for (const f of files) {
      try {
        const s = statSync(f);
        if (s.mtimeMs > newestJsonl) newestJsonl = s.mtimeMs;
      } catch {
        // missing file between readdir and stat; ignore
      }
    }

    const row = db
      .prepare('SELECT MAX(ingested_at) AS last FROM sessions')
      .get() as { last: number | null } | undefined;
    const lastIngest = row?.last ?? 0;

    if (newestJsonl <= lastIngest) return null;

    const otelUrl = process.env.OTEL_SCRAPE_URL ?? DEFAULT_OTEL_URL;
    return await ingestAll({
      db,
      otelUrl,
      otelOptional: true,
      otelTimeoutMs: 1000,
    });
  } catch (err) {
    log.warn('[auto-ingest] skipped:', err);
    return null;
  }
}
