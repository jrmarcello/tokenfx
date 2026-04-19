import type { Statement } from 'better-sqlite3';
import { statSync } from 'node:fs';
import { getDb, type DB } from '@/lib/db/client';
import { listTranscriptFiles } from '@/lib/fs-paths';
import { ingestAll, type IngestSummary } from '@/lib/ingest/writer';
import { isWatcherRunning } from '@/lib/ingest/watcher';
import { log } from '@/lib/logger';

/**
 * Default Prometheus endpoint served by Claude Code when
 * `OTEL_METRICS_EXPORTER=prometheus` is enabled. Override with
 * `OTEL_SCRAPE_URL` if you bind to a different host/port.
 */
const DEFAULT_OTEL_URL = 'http://localhost:9464/metrics';

let inflight: Promise<IngestSummary | null> | null = null;

type Prepared = { lastIngest: Statement };
const preparedCache = new WeakMap<DB, Prepared>();

function getPrepared(db: DB): Prepared {
  const existing = preparedCache.get(db);
  if (existing) return existing;
  const prepared: Prepared = {
    lastIngest: db.prepare('SELECT MAX(ingested_at) AS last FROM sessions'),
  };
  preparedCache.set(db, prepared);
  return prepared;
}

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
  // E2E / test harnesses set this to keep page renders fast and deterministic
  // (otherwise every SSR pulls ~/.claude/projects/ into the test DB).
  if (process.env.TOKENFX_DISABLE_AUTO_INGEST === '1') return;
  // When the chokidar watcher is running it is the authoritative source for
  // keeping the DB fresh (push-based). Skip the redundant pull-based ingest
  // to avoid duplicate filesystem scans per page render.
  if (isWatcherRunning()) return;
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

    const p = getPrepared(db);
    const row = p.lastIngest.get() as { last: number | null } | undefined;
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
