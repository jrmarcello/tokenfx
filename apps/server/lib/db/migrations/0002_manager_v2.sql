-- TokenFx central reporter server — manager-dashboard-v2 migration
-- Spec: .specs/manager-dashboard-v2.md (REQ-15..23)
-- Hand-crafted (matches schema.ts) for idempotency + readability — same
-- pattern as 0001_onboarding.sql. Drizzle's migrator runs the entire .sql
-- file as a single transaction (statement-breakpoint splits chunks but the
-- migrator wraps each in a transaction). Idempotency is provided by
-- IF NOT EXISTS / DO $$ guards so re-running this migration is a no-op.

-- ============================================================================
-- 1. users.display_name (REQ-18) — additive column, NULLable.
--    UI/queries fall back to split_part(email, '@', 1) when NULL.
--    auth.ts:signIn populates from OAuth profile.name on next login.
-- ============================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name text;

--> statement-breakpoint

-- ============================================================================
-- 2. team_metrics_daily — flat rollup per (org, team, day). NO metric_set
--    discriminator (B6 lock). 15-min cron writes here from sessions_agg +
--    tool_count_agg via GROUP BY users.team_id, day.
-- ============================================================================
CREATE TABLE IF NOT EXISTS team_metrics_daily (
  org_id                  uuid          NOT NULL REFERENCES orgs(id)  ON DELETE CASCADE,
  team_id                 uuid          NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  day                     date          NOT NULL,
  cache_hit_ratio_avg     numeric(5,4),
  good_session_pct        numeric(5,2),
  subagent_adoption_pct   numeric(5,2),
  composite_avg           numeric(5,2),
  total_sessions          integer       NOT NULL DEFAULT 0,
  total_devs              integer       NOT NULL DEFAULT 0,
  tool_mix_json           jsonb,
  computed_at             timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, team_id, day)
);

CREATE INDEX IF NOT EXISTS idx_tmd_team_day
  ON team_metrics_daily (team_id, day DESC);

--> statement-breakpoint

-- ============================================================================
-- 3. manager_drilldown_audit — append-only audit, idempotent same-day via
--    UNIQUE (manager_user_id, target_user_id, viewed_on, reason).
--    Append-only via column-level GRANT on app_runtime in the postlude.
--    REVOKE DELETE keeps the table immutable at the DB layer; writeAudit()
--    enforces the same at the code layer (defense in depth).
-- ============================================================================
CREATE TABLE IF NOT EXISTS manager_drilldown_audit (
  id                 bigserial     PRIMARY KEY,
  org_id             uuid          NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  manager_user_id    uuid          NOT NULL REFERENCES users(id),
  target_user_id     uuid          NOT NULL REFERENCES users(id),
  reason             text          NOT NULL,
  reason_text        text,
  source_route       text          NOT NULL,
  ip_address_trunc   text,
  viewed_on          date          NOT NULL,
  viewed_at          timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT manager_drilldown_audit_reason_check
    CHECK (reason IN ('training-check','quota-investigation','cost-investigation','other')),
  CONSTRAINT manager_drilldown_audit_unique_day
    UNIQUE (manager_user_id, target_user_id, viewed_on, reason)
);

CREATE INDEX IF NOT EXISTS idx_mda_target_viewed
  ON manager_drilldown_audit (target_user_id, viewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_mda_manager_viewed
  ON manager_drilldown_audit (manager_user_id, viewed_at DESC);

--> statement-breakpoint

-- ============================================================================
-- 4. manager_anomalies — nightly cron output. Idempotent on
--    (org, team, dev, kind, day). 'knowledge-sharing' kind is reserved
--    for forward-compat (currently computed live).
-- ============================================================================
CREATE TABLE IF NOT EXISTS manager_anomalies (
  id                 bigserial     PRIMARY KEY,
  org_id             uuid          NOT NULL REFERENCES orgs(id)  ON DELETE CASCADE,
  team_id            uuid          NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  target_user_id     uuid          NOT NULL REFERENCES users(id),
  kind               text          NOT NULL,
  detected_on        date          NOT NULL,
  context_json       jsonb,
  created_at         timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT manager_anomalies_kind_check
    CHECK (kind IN ('spend-spike-30d','spend-spike-wow','dropoff-wow','knowledge-sharing')),
  CONSTRAINT manager_anomalies_unique_row
    UNIQUE (org_id, team_id, target_user_id, kind, detected_on)
);

--> statement-breakpoint

-- ============================================================================
-- 5. manager_dismissed_anomalies — 7-day per-manager dismissals.
--    UNIQUE (org, manager, target, kind) intentionally per-manager.
-- ============================================================================
CREATE TABLE IF NOT EXISTS manager_dismissed_anomalies (
  id                 bigserial     PRIMARY KEY,
  org_id             uuid          NOT NULL REFERENCES orgs(id)  ON DELETE CASCADE,
  manager_user_id    uuid          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id     uuid          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind               text          NOT NULL,
  dismissed_until    timestamptz   NOT NULL,
  dismissed_at       timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT manager_dismissed_anomalies_unique_row
    UNIQUE (org_id, manager_user_id, target_user_id, kind)
);

--> statement-breakpoint

-- ============================================================================
-- 6. org_settings — org-wide config (does NOT exist in spec 1 / spec 3).
-- ============================================================================
CREATE TABLE IF NOT EXISTS org_settings (
  org_id                          uuid          PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  drilldown_notification_enabled  boolean       NOT NULL DEFAULT true,
  created_at                      timestamptz   NOT NULL DEFAULT now(),
  updated_at                      timestamptz   NOT NULL DEFAULT now()
);

--> statement-breakpoint

-- ============================================================================
-- 7. cron_runs — every cron invocation regardless of outcome.
-- ============================================================================
CREATE TABLE IF NOT EXISTS cron_runs (
  id                 bigserial     PRIMARY KEY,
  job_name           text          NOT NULL,
  started_at         timestamptz   NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  status             text          NOT NULL,
  rows_written       integer,
  error_message      text,
  CONSTRAINT cron_runs_status_check
    CHECK (status IN ('running','ok','failed'))
);

CREATE INDEX IF NOT EXISTS idx_cron_runs_job_started
  ON cron_runs (job_name, started_at DESC);

--> statement-breakpoint

-- ============================================================================
-- 8. manager_notifications — DB-backed notification queue stub.
--    THIS spec writes 'pending' rows; a follow-up spec adds the actual
--    delivery worker (Q9 lock — no mock channels, tests verify rows).
-- ============================================================================
CREATE TABLE IF NOT EXISTS manager_notifications (
  id                 bigserial     PRIMARY KEY,
  org_id             uuid          NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  target_user_id     uuid          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template           text          NOT NULL,
  payload_json       jsonb         NOT NULL,
  enqueued_at        timestamptz   NOT NULL DEFAULT now(),
  status             text          NOT NULL DEFAULT 'pending',
  delivered_at       timestamptz,
  error_message      text,
  CONSTRAINT manager_notifications_status_check
    CHECK (status IN ('pending','sent','failed'))
);

CREATE INDEX IF NOT EXISTS idx_mn_target_enqueued
  ON manager_notifications (target_user_id, enqueued_at DESC);

--> statement-breakpoint

-- ============================================================================
-- Postlude: partial indexes (Drizzle's index().on() doesn't support .where()
-- clauses) + RLS column GRANTs on manager_drilldown_audit (DCL is not
-- modeled by drizzle-kit). This block lives at the end of the .sql file.
-- ============================================================================
-- NOTE: spec called for `WHERE dismissed_until > now()` on this partial
-- index, but Postgres rejects non-IMMUTABLE functions in index predicates
-- (`now()` is STABLE, not IMMUTABLE — error 42P17, "functions in index
-- predicate must be marked IMMUTABLE"). The index is created without the
-- predicate; query-time `WHERE dismissed_until > now()` filters still
-- benefit from the (manager_user_id, dismissed_until) ordering. The
-- index-bloat win from the partial predicate is small here (active
-- dismissals are 7 days; even a busy org adds <1k rows/year).
CREATE INDEX IF NOT EXISTS idx_mda_dismiss_until
  ON manager_dismissed_anomalies (manager_user_id, dismissed_until);

CREATE INDEX IF NOT EXISTS idx_mn_pending
  ON manager_notifications (enqueued_at)
  WHERE status = 'pending';

-- RLS column grants for manager_drilldown_audit (B7 lock).
-- Wrapped in DO blocks with EXCEPTION handlers so the migration succeeds on
-- managed-Postgres deployments where the connection lacks SUPERUSER (cannot
-- create roles or grant). On those deployments, code-level enforcement in
-- writeAudit() is the active defense; TC-I-67 skips via SKIP_RLS_TESTS=1.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'app_runtime role creation skipped: insufficient privilege';
END $$;

DO $$
BEGIN
  GRANT SELECT, INSERT ON manager_drilldown_audit TO app_runtime;
  GRANT UPDATE (viewed_at, ip_address_trunc) ON manager_drilldown_audit TO app_runtime;
  REVOKE DELETE ON manager_drilldown_audit FROM app_runtime;
  GRANT USAGE, SELECT ON SEQUENCE manager_drilldown_audit_id_seq TO app_runtime;
EXCEPTION
  WHEN undefined_object THEN
    RAISE NOTICE 'GRANT block skipped: app_runtime role missing';
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'GRANT block skipped: insufficient privilege';
END $$;
