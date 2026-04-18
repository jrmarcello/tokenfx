import type { Statement } from 'better-sqlite3';
import type { DB } from '@/lib/db/client';

/**
 * After any write to `turns` / `tool_calls`, a session's stored rollups
 * (turn_count, token sums, cost, started/ended_at) and per-turn `sequence`
 * values can disagree with the authoritative row data. That happens whenever
 * a Claude Code session is split across multiple `.jsonl` files (sub-agents,
 * transcript rotation): the parser numbers turns within ONE file starting at
 * 0, and the writer's `INSERT ... ON CONFLICT(id)` deduplicates by turn UUID
 * but each file's turns have distinct UUIDs — so all coexist with colliding
 * sequence values, and the session's `turn_count` reflects only the latest
 * ingested file.
 *
 * `reconcileSession` (and `reconcileAllSessions`) restore consistency by
 * deriving sequences + rollups from the actual stored rows.
 */

const RENUMBER_ONE_SQL = `
  UPDATE turns
  SET sequence = ranked.rn
  FROM (
    SELECT id, ROW_NUMBER() OVER (ORDER BY timestamp, id) AS rn
    FROM turns
    WHERE session_id = ?
  ) AS ranked
  WHERE turns.id = ranked.id
`;

const ROLLUP_ONE_SQL = `
  UPDATE sessions SET
    started_at = COALESCE(
      (SELECT MIN(timestamp) FROM turns WHERE session_id = sessions.id),
      started_at
    ),
    ended_at = COALESCE(
      (SELECT MAX(timestamp) FROM turns WHERE session_id = sessions.id),
      ended_at
    ),
    total_input_tokens = COALESCE(
      (SELECT SUM(input_tokens) FROM turns WHERE session_id = sessions.id), 0
    ),
    total_output_tokens = COALESCE(
      (SELECT SUM(output_tokens) FROM turns WHERE session_id = sessions.id), 0
    ),
    total_cache_read_tokens = COALESCE(
      (SELECT SUM(cache_read_tokens) FROM turns WHERE session_id = sessions.id), 0
    ),
    total_cache_creation_tokens = COALESCE(
      (SELECT SUM(cache_creation_tokens) FROM turns WHERE session_id = sessions.id), 0
    ),
    total_cost_usd = COALESCE(
      (SELECT SUM(cost_usd) FROM turns WHERE session_id = sessions.id), 0
    ),
    turn_count = (SELECT COUNT(*) FROM turns WHERE session_id = sessions.id),
    tool_call_count = (
      SELECT COUNT(*)
      FROM tool_calls tc JOIN turns t ON t.id = tc.turn_id
      WHERE t.session_id = sessions.id
    )
  WHERE id = ?
`;

const RENUMBER_ALL_SQL = `
  UPDATE turns
  SET sequence = ranked.rn
  FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY timestamp, id) AS rn
    FROM turns
  ) AS ranked
  WHERE turns.id = ranked.id
`;

// Single-pass rollup across every session. Uses UPDATE ... FROM with grouped
// subqueries so the work is O(turns + tool_calls) instead of O(sessions ×
// turns × 8 correlated subqueries). Sessions without any turns are left as-is
// — the ingestion pipeline never produces a session row without turns, so
// the semantic divergence from the per-session version is inert in practice.
const ROLLUP_ALL_SQL = `
  UPDATE sessions
  SET started_at = COALESCE(agg.min_ts, sessions.started_at),
      ended_at = COALESCE(agg.max_ts, sessions.ended_at),
      total_input_tokens = COALESCE(agg.ti, 0),
      total_output_tokens = COALESCE(agg.to_, 0),
      total_cache_read_tokens = COALESCE(agg.tcr, 0),
      total_cache_creation_tokens = COALESCE(agg.tcc, 0),
      total_cost_usd = COALESCE(agg.tc, 0),
      turn_count = COALESCE(agg.cnt, 0),
      tool_call_count = COALESCE(agg.tool_cnt, 0)
  FROM (
    SELECT turns.session_id AS session_id,
           MIN(turns.timestamp) AS min_ts,
           MAX(turns.timestamp) AS max_ts,
           SUM(turns.input_tokens) AS ti,
           SUM(turns.output_tokens) AS to_,
           SUM(turns.cache_read_tokens) AS tcr,
           SUM(turns.cache_creation_tokens) AS tcc,
           SUM(turns.cost_usd) AS tc,
           COUNT(*) AS cnt,
           (SELECT COUNT(*)
              FROM tool_calls tc JOIN turns tt ON tt.id = tc.turn_id
              WHERE tt.session_id = turns.session_id) AS tool_cnt
    FROM turns
    GROUP BY turns.session_id
  ) AS agg
  WHERE sessions.id = agg.session_id
`;

type ReconcileStatements = {
  renumberOne: Statement<[string]>;
  rollupOne: Statement<[string]>;
};

const cache = new WeakMap<DB, ReconcileStatements>();

function getPrepared(db: DB): ReconcileStatements {
  const existing = cache.get(db);
  if (existing) return existing;
  const prepared: ReconcileStatements = {
    renumberOne: db.prepare(RENUMBER_ONE_SQL),
    rollupOne: db.prepare(ROLLUP_ONE_SQL),
  };
  cache.set(db, prepared);
  return prepared;
}

/**
 * Renumber `turns.sequence` for a single session (1..N, chronological) and
 * recompute the session's rollup columns (turn_count, totals, started_at,
 * ended_at) from the actual rows. Idempotent. Safe to call after every write.
 */
export function reconcileSession(db: DB, sessionId: string): void {
  const p = getPrepared(db);
  const tx = db.transaction(() => {
    p.renumberOne.run(sessionId);
    p.rollupOne.run(sessionId);
  });
  tx();
}

/**
 * Reconcile every session in one pass. Used by `migrate()` at startup to heal
 * pre-existing inconsistent data (e.g. sessions previously ingested with the
 * broken per-file sequence numbering).
 */
export function reconcileAllSessions(db: DB): void {
  const tx = db.transaction(() => {
    db.exec(RENUMBER_ALL_SQL);
    db.exec(ROLLUP_ALL_SQL);
  });
  tx();
}
