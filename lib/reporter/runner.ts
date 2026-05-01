import { createHash } from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { log } from '@/lib/logger';
import { sanitizeSession, type SessionWithAggs } from './sanitizer';
import type { SanitizedSessionPayload } from './types';
import { canonicalJSON, sign } from './signer';
import { pushBatch, type SignedEnvelope } from './client';
import { openQueue, type Queue } from './queue';
import { readConfig, defaultConfigPath, type ReporterConfig } from './config';

/**
 * REQ-10 / REQ-11 runner.
 *
 * Pipeline per invocation:
 *   1. **Gate (REQ-11)**: bail out with a clear info-log if
 *      `data/reporter-config.json` is absent — NO network, NO DB writes,
 *      no further imports of the network/signing layer needed at runtime.
 *   2. SELECT candidate sessions joined to `reporter_pushed_sessions`:
 *      either never pushed, OR `ingested_at > pushed_at`, OR
 *      `started_at >= last_pushed_at - 1h` (catches OTEL late updates).
 *   3. For each candidate, aggregate per-session children: turns by model
 *      (`model_breakdown`), tool_calls grouped by tool_name (`tool_counts`),
 *      ratings averaged (`avg_rating`). Reuse the `session_effectiveness`
 *      view for derived ratios when present.
 *   4. Sanitize via `sanitizeSession` (TASK-4). Failures: log + skip.
 *   5. Compute `payload_hash = sha256(canonicalJSON(payload))`. Skip if it
 *      matches the existing `reporter_pushed_sessions.payload_hash`
 *      (idempotency — TC-I-09).
 *   6. Batch ≤50 sanitized payloads, sign envelope, push via TASK-7.
 *   7. On success: UPSERT `reporter_pushed_sessions`. On `transient`:
 *      enqueue (TASK-6). On `permanent`: log + drop (do NOT enqueue).
 *   8. `dryRun`: print canonical JSON of the next batch and return —
 *      no network, no DB write.
 */

const BATCH_SIZE = 50;
const ONE_HOUR_MS = 60 * 60 * 1000;

export type RunReporterOptions = {
  /** Open SQLite path (defaults to `./data/dashboard.db`). Mutually exclusive with `db`. */
  dbPath?: string;
  /** Pre-opened DB handle (test injection). Mutually exclusive with `dbPath`. */
  db?: DatabaseType;
  /** Path to the reporter-config JSON. Defaults to `<cwd>/data/reporter-config.json`. */
  configPath?: string;
  /** Path to the offline-buffer SQLite. Defaults to `<cwd>/data/reporter-queue.db`. */
  queuePath?: string;
  /** Test seam — defaults to global `fetch`. */
  fetchFn?: typeof fetch;
  /** Dry run: print canonical JSON of the next batch and return; no side effects. */
  dryRun?: boolean;
};

export type RunReporterResult = {
  pushed: number;
  skipped: number;
  failed: number;
  queued: number;
};

const ZERO: RunReporterResult = { pushed: 0, skipped: 0, failed: 0, queued: 0 };

// ---------- Helpers ----------

/**
 * Row shape returned by `selectCandidates`. Only fields needed by the
 * sanitizer or for the candidate filter are selected — `user_prompt`,
 * `assistant_text`, etc. are NEVER included in this query for defense in
 * depth.
 */
type SessionRow = {
  id: string;
  cwd: string;
  git_branch: string | null;
  cc_version: string | null;
  started_at: number;
  ended_at: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  total_cost_usd: number;
  total_cost_usd_otel: number | null;
  turn_count: number;
  tool_call_count: number;
  ingested_at: number;
  pushed_hash: string | null;
};

const selectCandidates = (
  db: DatabaseType,
  cutoff: number,
): SessionRow[] => {
  // A session is a candidate if (REQ-10):
  //   (a) it was never pushed, OR
  //   (b) `ingested_at > pushed_at` (re-ingested transcript / OTEL update), OR
  //   (c) `started_at >= cutoff` where cutoff = now - 1h (OTEL late-update
  //       overlap window — the spec's `last_pushed_at - 1h` is approximated
  //       with `now - 1h` because `last_pushed_at` is per-session and we
  //       want a single bounded candidate set), OR
  //   (d) any rating's `rated_at > pushed_at` (a rating added/changed AFTER
  //       the last push must trigger a re-push because `avg_rating` is
  //       part of the payload — TC-I-10).
  // The candidate set is bounded by branches (a)+(c)+(d); branch (b) is a
  // strict refinement when a re-ingest happened.
  const stmt = db.prepare<[number], SessionRow>(
    `SELECT s.id, s.cwd, s.git_branch, s.cc_version,
            s.started_at, s.ended_at,
            s.total_input_tokens, s.total_output_tokens,
            s.total_cache_read_tokens, s.total_cache_creation_tokens,
            s.total_cost_usd, s.total_cost_usd_otel,
            s.turn_count, s.tool_call_count,
            s.ingested_at,
            r.payload_hash AS pushed_hash
       FROM sessions s
       LEFT JOIN reporter_pushed_sessions r ON r.session_id = s.id
      WHERE r.session_id IS NULL
         OR s.ingested_at > r.pushed_at
         OR s.started_at >= ?
         OR EXISTS (
              SELECT 1
                FROM ratings rt
                JOIN turns tn ON tn.id = rt.turn_id
               WHERE tn.session_id = s.id
                 AND rt.rated_at > r.pushed_at
            )
      ORDER BY s.started_at ASC`,
  );
  return stmt.all(cutoff);
};

type ModelBreakdownRow = {
  session_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
};

type ToolCountRow = { session_id: string; tool_name: string; count: number };

type RatingRow = { session_id: string; avg_rating: number };

type SubagentRow = { session_id: string; ratio: number | null };

const selectModelBreakdowns = (
  db: DatabaseType,
  sessionIds: string[],
): Map<string, SessionWithAggs['model_breakdown']> => {
  const out = new Map<string, SessionWithAggs['model_breakdown']>();
  if (sessionIds.length === 0) return out;
  const placeholders = sessionIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT t.session_id           AS session_id,
              t.model                AS model,
              SUM(t.input_tokens)    AS input_tokens,
              SUM(t.output_tokens)   AS output_tokens,
              SUM(t.cache_read_tokens) AS cache_read_tokens,
              SUM(t.cache_creation_tokens) AS cache_creation_tokens,
              SUM(t.cost_usd)        AS cost_usd
         FROM turns t
        WHERE t.session_id IN (${placeholders})
        GROUP BY t.session_id, t.model
        ORDER BY t.session_id, t.model`,
    )
    .all(...sessionIds) as ModelBreakdownRow[];
  for (const r of rows) {
    const list = out.get(r.session_id) ?? [];
    list.push({
      model: r.model,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      cache_read_tokens: r.cache_read_tokens,
      cache_creation_tokens: r.cache_creation_tokens,
      cost_usd: r.cost_usd,
    });
    out.set(r.session_id, list);
  }
  return out;
};

const selectToolCounts = (
  db: DatabaseType,
  sessionIds: string[],
): Map<string, Record<string, number>> => {
  const out = new Map<string, Record<string, number>>();
  if (sessionIds.length === 0) return out;
  const placeholders = sessionIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT t.session_id    AS session_id,
              tc.tool_name    AS tool_name,
              COUNT(*)        AS count
         FROM tool_calls tc
         JOIN turns t ON t.id = tc.turn_id
        WHERE t.session_id IN (${placeholders})
        GROUP BY t.session_id, tc.tool_name`,
    )
    .all(...sessionIds) as ToolCountRow[];
  for (const r of rows) {
    const map = out.get(r.session_id) ?? {};
    map[r.tool_name] = r.count;
    out.set(r.session_id, map);
  }
  return out;
};

const selectAvgRatings = (
  db: DatabaseType,
  sessionIds: string[],
): Map<string, number> => {
  const out = new Map<string, number>();
  if (sessionIds.length === 0) return out;
  const placeholders = sessionIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT t.session_id     AS session_id,
              AVG(r.rating)    AS avg_rating
         FROM ratings r
         JOIN turns t ON t.id = r.turn_id
        WHERE t.session_id IN (${placeholders})
        GROUP BY t.session_id`,
    )
    .all(...sessionIds) as RatingRow[];
  for (const r of rows) {
    out.set(r.session_id, r.avg_rating);
  }
  return out;
};

const selectSubagentRatios = (
  db: DatabaseType,
  sessionIds: string[],
): Map<string, number> => {
  const out = new Map<string, number>();
  if (sessionIds.length === 0) return out;
  const placeholders = sessionIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT session_id,
              CASE WHEN COUNT(*) = 0 THEN NULL
                   ELSE CAST(SUM(CASE WHEN subagent_type IS NOT NULL THEN 1 ELSE 0 END) AS REAL) /
                        CAST(COUNT(*) AS REAL)
              END AS ratio
         FROM turns
        WHERE session_id IN (${placeholders})
        GROUP BY session_id`,
    )
    .all(...sessionIds) as SubagentRow[];
  for (const r of rows) {
    if (r.ratio !== null) out.set(r.session_id, r.ratio);
  }
  return out;
};

/**
 * Cache hit ratio + output/input ratio: derived in JS, mirroring the
 * `session_effectiveness` view formula. Re-deriving in JS instead of
 * SELECTing the view keeps the runner robust to view drift and avoids a
 * cross-version dependency on the view's precision.
 */
const computeCacheHitRatio = (row: SessionRow): number | null => {
  const denom =
    row.total_input_tokens +
    row.total_cache_read_tokens +
    row.total_cache_creation_tokens;
  if (denom <= 0) return null;
  return row.total_cache_read_tokens / denom;
};

const computeOutputInputRatio = (row: SessionRow): number | null => {
  if (row.total_input_tokens <= 0) return null;
  return row.total_output_tokens / row.total_input_tokens;
};

// ---------- Runner ----------

export const runReporter = async (
  opts: RunReporterOptions = {},
): Promise<RunReporterResult> => {
  // 1. REQ-11 — config gate FIRST. Zero side effects when absent.
  const configFile = opts.configPath ?? defaultConfigPath();
  let config: ReporterConfig | null;
  try {
    config = readConfig(configFile);
  } catch (err) {
    log.error('[reporter] config invalid:', (err as Error).message);
    return ZERO;
  }
  if (!config) {
    log.info(
      '[reporter] not configured (run pnpm reporter:setup): missing',
      configFile,
    );
    return ZERO;
  }

  // 2. Open local DB (caller can inject a pre-opened handle for tests).
  const db: DatabaseType =
    opts.db ??
    new Database(opts.dbPath ?? path.join(process.cwd(), 'data/dashboard.db'));
  const ownsDb = opts.db === undefined;

  // Open queue lazily — only when we'll actually need it, but eager is fine
  // because the test path uses `:memory:` and the prod path needs it on
  // failure. The queue is closed unconditionally in the `finally` block.
  let queue: Queue | null = null;
  const queueFile =
    opts.queuePath ?? path.join(process.cwd(), 'data/reporter-queue.db');
  try {
    queue = openQueue(queueFile);
  } catch (err) {
    log.error('[reporter] queue open failed:', (err as Error).message);
    if (ownsDb) db.close();
    return ZERO;
  }

  let pushed = 0;
  let skipped = 0;
  let failed = 0;
  let queued = 0;

  try {
    const cutoff = Date.now() - ONE_HOUR_MS;
    const candidates = selectCandidates(db, cutoff);

    if (candidates.length === 0) {
      return { pushed, skipped, failed, queued };
    }

    const ids = candidates.map((c) => c.id);
    const breakdowns = selectModelBreakdowns(db, ids);
    const toolCounts = selectToolCounts(db, ids);
    const avgRatings = selectAvgRatings(db, ids);
    const subagentRatios = selectSubagentRatios(db, ids);

    type Prepared = {
      payload: SanitizedSessionPayload;
      payloadHash: string;
      previousHash: string | null;
    };
    const prepared: Prepared[] = [];

    for (const row of candidates) {
      const input: SessionWithAggs = {
        id: row.id,
        cwd: row.cwd,
        started_at: row.started_at,
        ended_at: row.ended_at,
        git_branch: row.git_branch,
        cc_version: row.cc_version,
        total_input_tokens: row.total_input_tokens,
        total_output_tokens: row.total_output_tokens,
        total_cache_read_tokens: row.total_cache_read_tokens,
        total_cache_creation_tokens: row.total_cache_creation_tokens,
        total_cost_usd: row.total_cost_usd,
        total_cost_usd_otel: row.total_cost_usd_otel,
        turn_count: row.turn_count,
        tool_call_count: row.tool_call_count,
        model_breakdown: breakdowns.get(row.id) ?? [],
        tool_counts: toolCounts.get(row.id) ?? {},
        avg_rating: avgRatings.get(row.id) ?? null,
        cache_hit_ratio: computeCacheHitRatio(row),
        output_input_ratio: computeOutputInputRatio(row),
        subagent_usage_ratio: subagentRatios.get(row.id) ?? null,
      };

      const result = sanitizeSession(input, {
        projectSecret: config.project_secret,
      });
      if (!result.ok) {
        log.warn('[reporter] sanitize skipped', {
          sessionId: row.id,
          error: result.error,
        });
        failed += 1;
        continue;
      }

      const canon = canonicalJSON(result.value);
      const payloadHash = createHash('sha256').update(canon).digest('hex');

      // Idempotency: skip if hash unchanged from the last pushed snapshot.
      if (row.pushed_hash !== null && row.pushed_hash === payloadHash) {
        skipped += 1;
        continue;
      }

      prepared.push({
        payload: result.value,
        payloadHash,
        previousHash: row.pushed_hash,
      });
    }

    if (prepared.length === 0) {
      return { pushed, skipped, failed, queued };
    }

    // 3. Dry-run: print canonical JSON of the next batch and return.
    if (opts.dryRun) {
      const nextBatch = prepared.slice(0, BATCH_SIZE).map((p) => p.payload);
      process.stdout.write(`${canonicalJSON(nextBatch)}\n`);
      return { pushed, skipped, failed, queued };
    }

    // 4. Batch ≤ BATCH_SIZE; push each batch sequentially.
    const upsertPushed = db.prepare(
      `INSERT INTO reporter_pushed_sessions (session_id, payload_hash, pushed_at)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE
         SET payload_hash = excluded.payload_hash,
             pushed_at    = excluded.pushed_at`,
    );
    const markBatchPushed = db.transaction((entries: Prepared[]) => {
      const now = Date.now();
      for (const e of entries) {
        upsertPushed.run(e.payload.session_id, e.payloadHash, now);
      }
    });

    for (let i = 0; i < prepared.length; i += BATCH_SIZE) {
      const chunk = prepared.slice(i, i + BATCH_SIZE);
      const payloads = chunk.map((p) => p.payload);
      const signature = sign(payloads, config.secret);
      const envelope: SignedEnvelope = {
        version: 1,
        key_id: config.key_id,
        machine_id: config.machine_id,
        signature,
        payload: payloads,
      };
      const result = await pushBatch({
        centralUrl: config.central_url,
        signedEnvelope: envelope,
        fetchFn: opts.fetchFn,
      });

      if (result.ok) {
        markBatchPushed(chunk);
        pushed += chunk.length;
        continue;
      }

      if (result.kind === 'transient') {
        // 5. Transient failure → enqueue for offline drain (REQ-9).
        for (const e of chunk) {
          queue.enqueue(e.payload, e.payloadHash);
          queued += 1;
        }
        log.warn('[reporter] transient push failure — enqueued', {
          attempts: result.attempts,
          lastStatus: result.lastStatus,
          lastError: result.lastError,
          batchSize: chunk.length,
        });
        // Stop pushing further batches — server is unhealthy; let the next
        // scheduled run retry from the queue.
        break;
      }

      // 6. Permanent failure (4xx etc) → log, do NOT enqueue, do NOT mark.
      log.error('[reporter] permanent push failure — dropped', {
        status: result.status,
        body: result.body,
        batchSize: chunk.length,
      });
      failed += chunk.length;
      // 4xx is a contract bug; carrying on with later batches would just
      // produce more 4xx noise, so bail.
      break;
    }

    return { pushed, skipped, failed, queued };
  } finally {
    queue?.close();
    if (ownsDb) db.close();
  }
};
