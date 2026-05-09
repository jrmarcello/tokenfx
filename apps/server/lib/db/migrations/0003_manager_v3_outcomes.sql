-- TokenFx central reporter server — manager-dashboard-v3-outcomes migration
-- Spec: .specs/manager-dashboard-v3-outcomes.md (REQ-8, REQ-10)
-- Hand-crafted (matches schema.ts) for idempotency + readability — same
-- pattern as 0001_onboarding.sql and 0002_manager_v2.sql.

-- ============================================================================
-- 1. session_outcomes_agg (REQ-8) — per-session outcome data.
--    ALL metric columns NULLABLE — preserves "not computed" vs "computed=0"
--    distinction (load-bearing for REQ-9 + cron WHERE outcome_status='evaluated'
--    filter in REQ-11).
--    Composite FK to sessions_agg(user_id, session_id) ON DELETE CASCADE
--    added below — same pattern as model_breakdown_agg.
--    No additional index: rollup JOIN drives from
--    sessions_agg.idx_sessions_agg_user_started; PG creates implicit index
--    for the composite FK columns.
-- ============================================================================
CREATE TABLE IF NOT EXISTS session_outcomes_agg (
  user_id              uuid          NOT NULL,
  session_id           text          NOT NULL,
  commit_count         integer,
  loc_added            integer,
  loc_removed          integer,
  files_changed        integer,
  reverts_within_7d    integer,
  merged_pr_count      integer,
  outcome_status       text,
  ingested_at          timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, session_id)
);

--> statement-breakpoint

-- Compound FK to sessions_agg(user_id, session_id) ON DELETE CASCADE.
-- Wrapped in DO block for idempotent re-run (ALTER TABLE ADD CONSTRAINT
-- IF NOT EXISTS doesn't exist in PG; query pg_constraint to check).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'session_outcomes_agg_sessions_agg_fkey'
  ) THEN
    ALTER TABLE session_outcomes_agg
      ADD CONSTRAINT session_outcomes_agg_sessions_agg_fkey
      FOREIGN KEY (user_id, session_id)
      REFERENCES sessions_agg (user_id, session_id)
      ON DELETE CASCADE;
  END IF;
END $$;

--> statement-breakpoint

-- CHECK constraint locking outcome_status to the 4 known values OR NULL.
-- Mirrors local schema.sql `session_outcomes.status` CHECK. If the local
-- enum gains a 5th value, server-side Zod rejects per-item (preferred:
-- explicit failure surfaces in ingestion_log). See spec REQ-3.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'session_outcomes_agg_status_check'
  ) THEN
    ALTER TABLE session_outcomes_agg
      ADD CONSTRAINT session_outcomes_agg_status_check
      CHECK (outcome_status IS NULL OR outcome_status IN (
        'evaluated', 'cwd-missing', 'not-a-git-repo', 'no-user-email'
      ));
  END IF;
END $$;

--> statement-breakpoint

-- ============================================================================
-- 2. team_outcomes_daily (REQ-10) — per (org, team, day) rollup.
--    Computed by `aggregate-team-outcomes` cron (REQ-11) from
--    session_outcomes_agg JOINed via sessions_agg → users → team_id, filtered
--    to outcome_status = 'evaluated'. Non-evaluated sessions excluded.
--    NO org-level aggregate row (PG PK columns can't be NULL; org-level
--    rollups computed in JS at the page component — mirrors Fase 4 pattern).
--    All metric columns NOT NULL DEFAULT 0 (rollup is post-filter, can't
--    be missing data); total_merged_pr_count is the only nullable metric
--    (NULL when ALL contributing sessions had merged_pr_count = NULL).
-- ============================================================================
CREATE TABLE IF NOT EXISTS team_outcomes_daily (
  org_id                    uuid          NOT NULL REFERENCES orgs(id)  ON DELETE CASCADE,
  team_id                   uuid          NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  day                       date          NOT NULL,
  total_commits             integer       NOT NULL DEFAULT 0,
  total_loc_added           integer       NOT NULL DEFAULT 0,
  total_loc_removed         integer       NOT NULL DEFAULT 0,
  total_files_changed       integer       NOT NULL DEFAULT 0,
  total_reverts_within_7d   integer       NOT NULL DEFAULT 0,
  total_merged_pr_count     integer,
  total_input_tokens        bigint        NOT NULL DEFAULT 0,
  total_output_tokens       bigint        NOT NULL DEFAULT 0,
  total_cost_usd            numeric(14,6) NOT NULL DEFAULT 0,
  sessions_with_outcome     integer       NOT NULL DEFAULT 0,
  computed_at               timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, team_id, day)
);
