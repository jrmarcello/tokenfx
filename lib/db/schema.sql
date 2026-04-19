-- foreign_keys is set per-connection in lib/db/client.ts (PRAGMA inside a
-- transactioned db.exec() is a no-op). Do not re-add here.

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  slug TEXT,
  cwd TEXT NOT NULL,
  project TEXT NOT NULL,
  git_branch TEXT,
  cc_version TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  total_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  total_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  total_cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost_usd REAL NOT NULL DEFAULT 0,
  total_cost_usd_otel REAL,
  turn_count INTEGER NOT NULL DEFAULT 0,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  source_file TEXT NOT NULL,
  ingested_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  parent_uuid TEXT,
  sequence INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_creation_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  stop_reason TEXT,
  user_prompt TEXT,
  assistant_text TEXT,
  tool_uses_json TEXT NOT NULL DEFAULT '[]',
  subagent_type TEXT,
  cache_creation_5m_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_1h_tokens INTEGER NOT NULL DEFAULT 0,
  service_tier TEXT NOT NULL DEFAULT 'standard'
);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, sequence);
-- idx_turns_subagent is created in `backfillTurnsSubagentType` (migrate.ts)
-- AFTER the ALTER TABLE so legacy DBs (no subagent_type column yet at schema
-- replay time) don't fail on "no such column" during CREATE INDEX.

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  input_json TEXT NOT NULL,
  result_json TEXT,
  result_is_error INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_turn ON tool_calls(turn_id);

CREATE TABLE IF NOT EXISTS ratings (
  turn_id TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK(rating IN (-1, 0, 1)),
  note TEXT,
  rated_at INTEGER NOT NULL
);

-- Per-file ingest bookkeeping, independent of `sessions`. A transcript
-- session can span multiple .jsonl files (sub-agent/rotation) and
-- `sessions.source_file` is overwritten by ON CONFLICT updates, so dedup
-- against it is unreliable. This table tracks each file's last-seen mtime
-- so ingestAll can skip files that haven't changed since we last parsed.
CREATE TABLE IF NOT EXISTS ingested_files (
  path TEXT PRIMARY KEY,
  mtime_ms INTEGER NOT NULL,
  ingested_at INTEGER NOT NULL
);

-- Learned multiplier: ratio of OTEL-reported cost to locally-computed list price,
-- aggregated per model family plus a 'global' row. Populated by
-- `recomputeCostCalibration` at the end of every ingest. Rows only exist when
-- the ratio is within `[MIN_RATE, MAX_RATE]` (see lib/analytics/cost-calibration.ts).
CREATE TABLE IF NOT EXISTS cost_calibration (
  family TEXT PRIMARY KEY,
  effective_rate REAL NOT NULL,
  sample_session_count INTEGER NOT NULL,
  sum_otel_cost REAL NOT NULL,
  sum_local_cost REAL NOT NULL,
  last_updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS otel_scrapes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scraped_at INTEGER NOT NULL,
  metric_name TEXT NOT NULL,
  labels_json TEXT NOT NULL,
  value REAL NOT NULL,
  UNIQUE(metric_name, labels_json, scraped_at)
);
CREATE INDEX IF NOT EXISTS idx_otel_scrape_metric_time ON otel_scrapes(metric_name, scraped_at);

-- Full-text search on turns (user_prompt + assistant_text).
-- External content mode: FTS5 references turns.rowid instead of duplicating text.
-- Tokenizer: unicode61 + remove_diacritics 2 so "cafe" matches "café" (PT/EN mixed).
CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
  user_prompt,
  assistant_text,
  content='turns',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

-- Sync triggers keep turns_fts coherent with turns. Must exist before any
-- downstream writes (reconcile, writer) so every mutation is indexed.
CREATE TRIGGER IF NOT EXISTS trg_turns_ai AFTER INSERT ON turns BEGIN
  INSERT INTO turns_fts(rowid, user_prompt, assistant_text)
  VALUES (new.rowid, new.user_prompt, new.assistant_text);
END;

CREATE TRIGGER IF NOT EXISTS trg_turns_ad AFTER DELETE ON turns BEGIN
  INSERT INTO turns_fts(turns_fts, rowid, user_prompt, assistant_text)
  VALUES ('delete', old.rowid, old.user_prompt, old.assistant_text);
END;

CREATE TRIGGER IF NOT EXISTS trg_turns_au AFTER UPDATE ON turns BEGIN
  INSERT INTO turns_fts(turns_fts, rowid, user_prompt, assistant_text)
  VALUES ('delete', old.rowid, old.user_prompt, old.assistant_text);
  INSERT INTO turns_fts(rowid, user_prompt, assistant_text)
  VALUES (new.rowid, new.user_prompt, new.assistant_text);
END;

-- Idempotent backfill. External-content FTS5 tables proxy `SELECT` to their
-- content table (`turns`), so a `WHERE NOT EXISTS (SELECT 1 FROM turns_fts
-- WHERE rowid = turns.rowid)` pattern is always empty and an `INSERT ...
-- SELECT` backfill silently no-ops. The supported primitive is FTS5's built-in
-- `'rebuild'` command, which recomputes the full index from the content table
-- atomically. It is idempotent (same input → same index state) and cheap
-- relative to ingestion on a single-user DB with thousands of turns — the
-- alternative (gated rebuild) requires runtime logic beyond plain SQL.
INSERT INTO turns_fts(turns_fts) VALUES('rebuild');

-- Views are recreated every migrate so formula changes to derived columns
-- propagate without a manual drop step on pre-existing DBs.
DROP VIEW IF EXISTS session_effectiveness;
CREATE VIEW session_effectiveness AS
SELECT
  s.id, s.project, s.total_cost_usd, s.turn_count,
  -- Share of total prompt tokens (including cache-creation writes) that
  -- were served from cache. Including creation in the denominator matches
  -- the "% de tokens reaproveitados" mental model; excluding it (previous
  -- formula) over-reports cache effectiveness on sessions that spend most
  -- tokens priming a new cache.
  (CAST(s.total_cache_read_tokens AS REAL) /
   NULLIF(s.total_input_tokens + s.total_cache_read_tokens + s.total_cache_creation_tokens, 0)) AS cache_hit_ratio,
  (CAST(s.total_output_tokens AS REAL) /
   NULLIF(s.total_input_tokens, 0)) AS output_input_ratio,
  (SELECT AVG(rating) FROM ratings r JOIN turns t ON t.id=r.turn_id WHERE t.session_id=s.id) AS avg_rating,
  -- cost_per_turn prefers OTEL-authoritative cost when available; falls
  -- back to local total_cost_usd (computeCost-derived) otherwise.
  COALESCE(s.total_cost_usd_otel, s.total_cost_usd) / NULLIF(s.turn_count, 0) AS cost_per_turn
FROM sessions s;
