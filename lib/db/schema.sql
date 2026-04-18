PRAGMA foreign_keys = ON;

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
  turn_count INTEGER NOT NULL DEFAULT 0,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  source_file TEXT NOT NULL,
  ingested_at INTEGER NOT NULL
);

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
  tool_uses_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, sequence);

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

CREATE TABLE IF NOT EXISTS otel_scrapes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scraped_at INTEGER NOT NULL,
  metric_name TEXT NOT NULL,
  labels_json TEXT NOT NULL,
  value REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otel_scrape_metric_time ON otel_scrapes(metric_name, scraped_at);

CREATE VIEW IF NOT EXISTS session_effectiveness AS
SELECT
  s.id, s.project, s.total_cost_usd, s.turn_count,
  (CAST(s.total_cache_read_tokens AS REAL) /
   NULLIF(s.total_input_tokens + s.total_cache_read_tokens, 0)) AS cache_hit_ratio,
  (CAST(s.total_output_tokens AS REAL) /
   NULLIF(s.total_input_tokens, 0)) AS output_input_ratio,
  (SELECT AVG(rating) FROM ratings r JOIN turns t ON t.id=r.turn_id WHERE t.session_id=s.id) AS avg_rating,
  s.total_cost_usd / NULLIF(s.turn_count, 0) AS cost_per_turn
FROM sessions s;
