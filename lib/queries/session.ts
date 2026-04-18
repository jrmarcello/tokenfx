import type { DB } from '@/lib/db/client';

export type SessionDetail = {
  id: string;
  slug: string | null;
  cwd: string;
  project: string;
  gitBranch: string | null;
  ccVersion: string | null;
  startedAt: number;
  endedAt: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUsd: number;
  turnCount: number;
  toolCallCount: number;
  avgRating: number | null;
  cacheHitRatio: number | null;
  outputInputRatio: number | null;
};

export type TurnDetail = {
  id: string;
  sequence: number;
  timestamp: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  stopReason: string | null;
  userPrompt: string | null;
  assistantText: string | null;
  toolCalls: Array<{
    id: string;
    toolName: string;
    inputJson: string;
    resultJson: string | null;
    resultIsError: boolean;
  }>;
  rating: { value: -1 | 0 | 1; note: string | null; ratedAt: number } | null;
};

export type SessionListItem = {
  id: string;
  project: string;
  startedAt: number;
  totalCostUsd: number;
  turnCount: number;
  avgRating: number | null;
};

type PreparedSet = {
  getSession: import('better-sqlite3').Statement<[string]>;
  getTurns: import('better-sqlite3').Statement<[string]>;
  upsertRating: import('better-sqlite3').Statement<[string, number, string | null, number]>;
  listSessions: import('better-sqlite3').Statement<[number]>;
};

const cache = new WeakMap<DB, PreparedSet>();

function getPrepared(db: DB): PreparedSet {
  const existing = cache.get(db);
  if (existing) return existing;
  const prepared: PreparedSet = {
    getSession: db.prepare(
      `SELECT s.*,
              v.cache_hit_ratio AS cache_hit_ratio,
              v.output_input_ratio AS output_input_ratio,
              v.avg_rating AS avg_rating
       FROM sessions s
       LEFT JOIN session_effectiveness v ON v.id = s.id
       WHERE s.id = ?`
    ),
    getTurns: db.prepare(
      `SELECT id, session_id, sequence, timestamp, model,
              input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
              cost_usd, stop_reason, user_prompt, assistant_text
       FROM turns
       WHERE session_id = ?
       ORDER BY sequence ASC`
    ),
    upsertRating: db.prepare(
      `INSERT INTO ratings (turn_id, rating, note, rated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(turn_id) DO UPDATE SET
         rating = excluded.rating,
         note = excluded.note,
         rated_at = excluded.rated_at`
    ),
    listSessions: db.prepare(
      `SELECT s.id AS id,
              s.project AS project,
              s.started_at AS startedAt,
              s.total_cost_usd AS totalCostUsd,
              s.turn_count AS turnCount,
              v.avg_rating AS avgRating
       FROM sessions s
       LEFT JOIN session_effectiveness v ON v.id = s.id
       ORDER BY s.started_at DESC
       LIMIT ?`
    ),
  };
  cache.set(db, prepared);
  return prepared;
}

type SessionRow = {
  id: string;
  slug: string | null;
  cwd: string;
  project: string;
  git_branch: string | null;
  cc_version: string | null;
  started_at: number;
  ended_at: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  total_cost_usd: number;
  turn_count: number;
  tool_call_count: number;
  cache_hit_ratio: number | null;
  output_input_ratio: number | null;
  avg_rating: number | null;
};

export function getSession(db: DB, id: string): SessionDetail | null {
  const p = getPrepared(db);
  const row = p.getSession.get(id) as SessionRow | undefined;
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    cwd: row.cwd,
    project: row.project,
    gitBranch: row.git_branch,
    ccVersion: row.cc_version,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    totalInputTokens: row.total_input_tokens,
    totalOutputTokens: row.total_output_tokens,
    totalCacheReadTokens: row.total_cache_read_tokens,
    totalCacheCreationTokens: row.total_cache_creation_tokens,
    totalCostUsd: row.total_cost_usd,
    turnCount: row.turn_count,
    toolCallCount: row.tool_call_count,
    avgRating: row.avg_rating,
    cacheHitRatio: row.cache_hit_ratio,
    outputInputRatio: row.output_input_ratio,
  };
}

type TurnRow = {
  id: string;
  session_id: string;
  sequence: number;
  timestamp: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  stop_reason: string | null;
  user_prompt: string | null;
  assistant_text: string | null;
};

type ToolCallRow = {
  id: string;
  turn_id: string;
  tool_name: string;
  input_json: string;
  result_json: string | null;
  result_is_error: number;
};

type RatingRow = {
  turn_id: string;
  rating: -1 | 0 | 1;
  note: string | null;
  rated_at: number;
};

export function getTurns(db: DB, sessionId: string): TurnDetail[] {
  const p = getPrepared(db);
  const turnRows = p.getTurns.all(sessionId) as TurnRow[];
  if (turnRows.length === 0) return [];

  const turnIds = turnRows.map((t) => t.id);
  const placeholders = turnIds.map(() => '?').join(',');
  const toolCallRows = db
    .prepare(
      `SELECT id, turn_id, tool_name, input_json, result_json, result_is_error
       FROM tool_calls
       WHERE turn_id IN (${placeholders})`
    )
    .all(...turnIds) as ToolCallRow[];
  const ratingRows = db
    .prepare(
      `SELECT turn_id, rating, note, rated_at
       FROM ratings
       WHERE turn_id IN (${placeholders})`
    )
    .all(...turnIds) as RatingRow[];

  const toolCallsByTurn = new Map<string, TurnDetail['toolCalls']>();
  for (const tc of toolCallRows) {
    const list = toolCallsByTurn.get(tc.turn_id) ?? [];
    list.push({
      id: tc.id,
      toolName: tc.tool_name,
      inputJson: tc.input_json,
      resultJson: tc.result_json,
      resultIsError: tc.result_is_error !== 0,
    });
    toolCallsByTurn.set(tc.turn_id, list);
  }

  const ratingByTurn = new Map<string, RatingRow>();
  for (const r of ratingRows) {
    ratingByTurn.set(r.turn_id, r);
  }

  return turnRows.map((t) => {
    const r = ratingByTurn.get(t.id);
    return {
      id: t.id,
      sequence: t.sequence,
      timestamp: t.timestamp,
      model: t.model,
      inputTokens: t.input_tokens,
      outputTokens: t.output_tokens,
      cacheReadTokens: t.cache_read_tokens,
      cacheCreationTokens: t.cache_creation_tokens,
      costUsd: t.cost_usd,
      stopReason: t.stop_reason,
      userPrompt: t.user_prompt,
      assistantText: t.assistant_text,
      toolCalls: toolCallsByTurn.get(t.id) ?? [],
      rating: r
        ? { value: r.rating, note: r.note, ratedAt: r.rated_at }
        : null,
    };
  });
}

export function upsertRating(
  db: DB,
  turnId: string,
  value: -1 | 0 | 1,
  note: string | null
): void {
  const p = getPrepared(db);
  p.upsertRating.run(turnId, value, note, Date.now());
}

export function listSessions(db: DB, limit: number): SessionListItem[] {
  const p = getPrepared(db);
  return p.listSessions.all(limit) as SessionListItem[];
}
