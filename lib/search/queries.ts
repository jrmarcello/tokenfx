import type { Statement } from 'better-sqlite3';
import type { DB } from '@/lib/db/client';
import {
  normalizeLimit,
  normalizeOffset,
  sanitizeFtsQuery,
  type SearchHit,
} from './query';

const DAY_MS = 86_400_000;

export type SearchOptions = {
  query: string;
  days?: number;
  limit?: number;
  offset?: number;
};

export type SearchResult = {
  items: SearchHit[];
  total: number;
};

type PreparedSet = {
  search: Statement<[string, number, number, number]>;
  count: Statement<[string, number]>;
};

const cache = new WeakMap<DB, PreparedSet>();

function getPrepared(db: DB): PreparedSet {
  const existing = cache.get(db);
  if (existing) return existing;
  const prepared: PreparedSet = {
    // Items query: one FTS5 MATCH, join to turns via rowid (external content
    // semantics), then to sessions for project + window filter. bm25 ASC =
    // best-first. Snippet columns: 0=user_prompt, 1=assistant_text.
    search: db.prepare(
      `SELECT t.id                                         AS turnId,
              t.session_id                                 AS sessionId,
              s.project                                    AS project,
              t.sequence                                   AS sequence,
              t.timestamp                                  AS timestamp,
              t.model                                      AS model,
              bm25(turns_fts)                              AS score,
              snippet(turns_fts, 0, '<mark>', '</mark>', '...', 30) AS promptSnippet,
              snippet(turns_fts, 1, '<mark>', '</mark>', '...', 30) AS responseSnippet
       FROM turns_fts
       JOIN turns t     ON t.rowid = turns_fts.rowid
       JOIN sessions s  ON s.id = t.session_id
       WHERE turns_fts MATCH ?
         AND s.started_at >= ?
       ORDER BY bm25(turns_fts) ASC
       LIMIT ? OFFSET ?`,
    ),
    count: db.prepare(
      `SELECT COUNT(*) AS total
       FROM turns_fts
       JOIN turns t     ON t.rowid = turns_fts.rowid
       JOIN sessions s  ON s.id = t.session_id
       WHERE turns_fts MATCH ?
         AND s.started_at >= ?`,
    ),
  };
  cache.set(db, prepared);
  return prepared;
}

type SearchRow = {
  turnId: string;
  sessionId: string;
  project: string;
  sequence: number;
  timestamp: number;
  model: string;
  score: number;
  promptSnippet: string | null;
  responseSnippet: string | null;
};

/**
 * Full-text search across transcripts. Returns `{ items: [], total: 0 }`
 * for unusable queries (empty, whitespace-only, ≤1 useful char, or >200
 * chars) without touching the DB. When `days` is a positive integer, the
 * filter is `sessions.started_at >= now - days*86400000`. Otherwise the
 * whole history is searched.
 *
 * The sanitized FTS5 expression is built by {@link sanitizeFtsQuery} and
 * bound as a parameter — SQL injection is not a concern at the DB layer.
 * Malicious inputs simply produce no matches.
 */
export function searchTurns(db: DB, opts: SearchOptions): SearchResult {
  const fts = sanitizeFtsQuery(opts.query);
  if (fts === null) return { items: [], total: 0 };

  const limit = normalizeLimit(opts.limit);
  const offset = normalizeOffset(opts.offset);
  const cutoff =
    opts.days !== undefined && opts.days > 0
      ? Date.now() - opts.days * DAY_MS
      : 0;

  const p = getPrepared(db);
  let rows: SearchRow[];
  let total = 0;
  try {
    rows = p.search.all(fts, cutoff, limit, offset) as SearchRow[];
    const totalRow = p.count.get(fts, cutoff) as { total: number } | undefined;
    total = totalRow?.total ?? 0;
  } catch {
    // Defense in depth: if the sanitized expression somehow confuses FTS5,
    // surface an empty result rather than a 500. `sanitizeFtsQuery` should
    // make this unreachable.
    return { items: [], total: 0 };
  }

  const items: SearchHit[] = rows.map((r) => ({
    turnId: r.turnId,
    sessionId: r.sessionId,
    project: r.project,
    sequence: r.sequence,
    timestamp: r.timestamp,
    model: r.model,
    score: r.score,
    promptSnippet: r.promptSnippet ?? '',
    responseSnippet: r.responseSnippet ?? '',
  }));

  return { items, total };
}
