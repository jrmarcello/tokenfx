-- TokenFx central reporter server — sso-auto-provision schema migration
-- Spec: .specs/central-server-onboarding-v2-sso.schema-migrations.md (REQ-1..REQ-10, REQ-17)
-- Threat model: .specs/central-server-onboarding-v2-sso.threat-model.md (preconditions #1-9, §Decisão #10/#11/#12)
-- Hand-crafted (matches schema.ts) — drizzle-kit auto-gen does not handle ALTER TYPE ADD VALUE.

-- ============================================================================
-- 1. Enum extension (REQ-3) — 10 new outcome values for SSO-auto + rejection
--    paths. `ALTER TYPE ADD VALUE IF NOT EXISTS` is native PG 12+ and is the
--    canonical idempotent form. Each value is its own statement (PG forbids
--    multiple ADD VALUE in a single ALTER TYPE), and each must commit before
--    the value can be used downstream — `--> statement-breakpoint` separates
--    them from the rest of the migration.
-- ============================================================================
ALTER TYPE onboarding_outcome ADD VALUE IF NOT EXISTS 'accepted-sso-auto';
ALTER TYPE onboarding_outcome ADD VALUE IF NOT EXISTS 'rejected-public-domain';
ALTER TYPE onboarding_outcome ADD VALUE IF NOT EXISTS 'rejected-multiple-matches';
ALTER TYPE onboarding_outcome ADD VALUE IF NOT EXISTS 'rejected-no-match';
ALTER TYPE onboarding_outcome ADD VALUE IF NOT EXISTS 'rejected-race';
ALTER TYPE onboarding_outcome ADD VALUE IF NOT EXISTS 'rejected-csrf';
ALTER TYPE onboarding_outcome ADD VALUE IF NOT EXISTS 'rejected-replay';
ALTER TYPE onboarding_outcome ADD VALUE IF NOT EXISTS 'rejected-cross-idp';
ALTER TYPE onboarding_outcome ADD VALUE IF NOT EXISTS 'rejected-pre-existing-binding';
ALTER TYPE onboarding_outcome ADD VALUE IF NOT EXISTS 'email-not-verified';

--> statement-breakpoint

-- ============================================================================
-- 2. ADD COLUMNs with defaults (REQ-4, REQ-7, REQ-8).
--    `ADD COLUMN IF NOT EXISTS` (PG 9.6+) is idempotent. Defaults populate
--    via the catalog fast path on PG 11+ (no full table rewrite for
--    non-volatile defaults).
--
--    REQ-4: onboarding_redemption_log gains method + 4 nullable forensic
--    columns. Existing rows backfill via the `NOT NULL DEFAULT 'manual-token'`
--    on `method` (preserves the v1 invariant that every legacy row was a
--    manual-token redemption).
--
--    REQ-7: user_machines.provisioned_via — sentinel `'pre-v2-unknown'` lets
--    operators distinguish legacy provenance from new manual/SSO writes.
--
--    REQ-8: onboarding_invites.allowed_sso_providers — array (NOT scalar) so
--    a single invite can authorize multiple IdPs; `'{}'` default preserves
--    v1 semantics (manual-token-only) for pre-existing rows.
-- ============================================================================
ALTER TABLE onboarding_redemption_log
  ADD COLUMN IF NOT EXISTS method text NOT NULL DEFAULT 'manual-token';

ALTER TABLE onboarding_redemption_log
  ADD COLUMN IF NOT EXISTS sso_provider text;

ALTER TABLE onboarding_redemption_log
  ADD COLUMN IF NOT EXISTS sso_subject_hash text;

ALTER TABLE onboarding_redemption_log
  ADD COLUMN IF NOT EXISTS iss text;

ALTER TABLE onboarding_redemption_log
  ADD COLUMN IF NOT EXISTS user_agent text;

ALTER TABLE user_machines
  ADD COLUMN IF NOT EXISTS provisioned_via text NOT NULL DEFAULT 'pre-v2-unknown';

ALTER TABLE onboarding_invites
  ADD COLUMN IF NOT EXISTS allowed_sso_providers text[] NOT NULL DEFAULT '{}'::text[];

--> statement-breakpoint

-- ============================================================================
-- 3. ADD CHECK constraints (REQ-4, REQ-7).
--    ADD CONSTRAINT lacks a native IF NOT EXISTS; we query pg_constraint by
--    `conname` to guard re-runs. Names are explicit (not auto-generated) so
--    the pg_constraint lookup is deterministic.
--
--    The REQ-9 (180d cap) CHECK is added LATER (step 5) so the pre-flight
--    count query (step 4) can RAISE NOTICE before the constraint creation
--    aborts on existing data — clearer operator signal than a raw ADD
--    CONSTRAINT failure.
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'onboarding_redemption_log_method_check'
  ) THEN
    ALTER TABLE onboarding_redemption_log
      ADD CONSTRAINT onboarding_redemption_log_method_check
      CHECK (method IN ('manual-token', 'sso-auto'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_machines_provisioned_via_check'
  ) THEN
    ALTER TABLE user_machines
      ADD CONSTRAINT user_machines_provisioned_via_check
      CHECK (provisioned_via IN ('manual-token', 'sso-auto', 'pre-v2-unknown'));
  END IF;
END $$;

--> statement-breakpoint

-- ============================================================================
-- 4. Pre-flight count query for REQ-9 violators (TC-I-32 + TC-I-32b).
--    Loud RAISE NOTICE for the operator BEFORE the ADD CONSTRAINT below
--    aborts on the same data — turns an opaque "check constraint violated"
--    into an actionable signal ("N invites violate the 180d cap; fix data
--    before re-running"). The RAISE EXCEPTION rolls the entire migration
--    transaction back (no partial state), matching TC-I-32 expectations.
-- ============================================================================
DO $$
DECLARE
  violator_count integer;
BEGIN
  SELECT count(*) INTO violator_count
  FROM onboarding_invites
  WHERE email_pattern IS NOT NULL
    AND expires_at > created_at + INTERVAL '180 days';
  RAISE NOTICE '[migration 0004] pre-flight: % invite(s) violate 180d cap', violator_count;
  IF violator_count > 0 THEN
    RAISE EXCEPTION '[migration 0004] aborting: % invites violate the 180d expires_at cap. Fix the data manually before re-running.', violator_count;
  END IF;
END $$;

--> statement-breakpoint

-- ============================================================================
-- 5. REQ-9 — 180d cap CHECK on onboarding_invites.
--    Only applies to SSO-auto patterns (email_pattern IS NOT NULL); manual-
--    token invites (NULL pattern) remain unconstrained. Bounded acceptance
--    window mitigates Threat 6 (stale-pattern long-tail provisioning).
--    Idempotent via pg_constraint lookup.
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'onboarding_invites_sso_expires_check'
  ) THEN
    ALTER TABLE onboarding_invites
      ADD CONSTRAINT onboarding_invites_sso_expires_check
      CHECK (email_pattern IS NULL OR expires_at <= created_at + INTERVAL '180 days');
  END IF;
END $$;

--> statement-breakpoint

-- ============================================================================
-- 6. REQ-5 — partial index for active SSO-auto patterns.
--    Partial WHERE `revoked_at IS NULL` keeps the index tight (only LIVE
--    patterns are scanned during signIn pattern matching). `email_pattern`
--    is the lookup column; `revoked_at IS NULL` is the predicate.
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_invites_email_pattern_active
  ON onboarding_invites (email_pattern) WHERE revoked_at IS NULL;

--> statement-breakpoint

-- ============================================================================
-- 7. REQ-1 + REQ-2 — composite uniqueness swap on `users`.
--    CRITICAL: steps 7a/7b/7c MUST run in the same transaction with NO
--    statement-breakpoint between them — if 7a or 7b fails, the old global
--    UNIQUE on `users.email` (7c) MUST remain in place. A breakpoint here
--    would commit 7a, then fail 7c, leaving users.email with NO uniqueness
--    constraint at all (catastrophic — allows duplicate-email cross-org
--    bootstrap before the new composite is in place).
--
--    Order:
--      7a) ADD composite `users_org_email_unique` (REQ-1)
--      7b) ADD composite `users_org_sso_unique` (REQ-2)
--      7c) DROP legacy global `users.email` UNIQUE (auto-named, typically
--          `users_email_key`) — resolved via pg_constraint catalog lookup
--          because the historical name is not guaranteed across PG versions.
--
--    Per Decisão #12: drop AFTER both composite uniques are in place so the
--    table never has zero coverage on email.
-- ============================================================================
DO $$
DECLARE
  old_constraint_name text;
BEGIN
  -- 7a: composite (org_id, email) — relaxes the v1 global UNIQUE on email,
  -- enabling the same email to exist across different orgs (REQ-1).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_org_email_unique'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_org_email_unique UNIQUE (org_id, email);
  END IF;

  -- 7b: composite (org_id, sso_provider, sso_subject) — guarantees a single
  -- SSO identity binds to ≤1 user per org. NULL-tolerant per PG semantics
  -- (multiple NULLs allowed in UNIQUE), which is intentional: v1 invite-
  -- provisioned users with NULL SSO fields must coexist (REQ-2 + TC-I-05/06).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_org_sso_unique'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_org_sso_unique UNIQUE (org_id, sso_provider, sso_subject);
  END IF;

  -- 7c: drop legacy global UNIQUE on users.email. Auto-named by PG
  -- (typically `users_email_key`) — resolve dynamically by scanning
  -- pg_constraint for the single-column UNIQUE on `users.email`.
  -- contype='u' filters to UNIQUE; array_length(conkey,1)=1 filters out
  -- multi-column uniques (the two composites just added); the EXISTS
  -- subquery confirms the single column is `email`.
  SELECT c.conname INTO old_constraint_name
  FROM pg_constraint c
  JOIN pg_class r ON r.oid = c.conrelid
  WHERE r.relname = 'users'
    AND c.contype = 'u'
    AND array_length(c.conkey, 1) = 1
    AND EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = r.oid
        AND a.attnum = c.conkey[1]
        AND a.attname = 'email'
    );
  IF old_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', old_constraint_name);
  END IF;
END $$;

--> statement-breakpoint

-- ============================================================================
-- 8. REQ-10 — auth_event_log table + 3 indexes + outcome CHECK.
--    Append-only forensic log for SSO auto-provisioning decisions (Threat 4
--    forensic-query support). `email_hash` + `sso_subject_hash` are SHA-256
--    hex digests — never the raw values (privacy invariant, same pattern
--    as onboarding_redemption_log).
--
--    `outcome` CHECK locks the column to the 10 SSO-decision outcomes.
--    These are inlined here (not the enum) because the enum is reused by
--    onboarding_redemption_log which also accepts manual-token outcomes;
--    auth_event_log only ever records SSO decisions, so the tighter CHECK
--    catches accidental writes of non-SSO outcomes.
--
--    Indexes target the 3 most likely forensic queries: by subject + time
--    (replay correlation), by email + time (account-takeover triage), by
--    issuer + time (IdP outage / mass-rejection correlation).
-- ============================================================================
CREATE TABLE IF NOT EXISTS auth_event_log (
  id                bigserial PRIMARY KEY,
  sso_provider      text         NOT NULL,
  iss               text         NOT NULL,
  email_hash        text         NOT NULL,
  sso_subject_hash  text,
  ip                text,
  city              text,
  user_agent        text,
  outcome           text         NOT NULL,
  occurred_at       timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT auth_event_log_outcome_check CHECK (outcome IN (
    'accepted-sso-auto',
    'rejected-public-domain',
    'rejected-multiple-matches',
    'rejected-no-match',
    'rejected-race',
    'rejected-csrf',
    'rejected-replay',
    'rejected-cross-idp',
    'rejected-pre-existing-binding',
    'email-not-verified'
  ))
);

CREATE INDEX IF NOT EXISTS idx_auth_event_log_subject_occurred
  ON auth_event_log (sso_subject_hash, occurred_at);

CREATE INDEX IF NOT EXISTS idx_auth_event_log_email_occurred
  ON auth_event_log (email_hash, occurred_at);

CREATE INDEX IF NOT EXISTS idx_auth_event_log_iss_occurred
  ON auth_event_log (iss, occurred_at);

--> statement-breakpoint

-- ============================================================================
-- 9. REQ-6 — REVOKE UPDATE/DELETE on append-only audit tables from app_role.
--    Per Decisão #10: `:"app_role"` is a psql variable injected by the
--    migration runner via `--variable=app_role=<role>` (defaults to
--    `app_role` for testcontainers + local dev; production substitutes the
--    real least-privilege role). The double-quoted form `:"app_role"`
--    quotes the identifier safely.
--
--    INSERT + SELECT remain available (audit writers + dashboard readers
--    need them). DDL (TRUNCATE, etc.) is implicitly denied by lack of
--    ownership. This enforces the append-only invariant at the role
--    boundary — the application code CANNOT rewrite history even with a
--    compromised query path.
-- ============================================================================
REVOKE UPDATE, DELETE ON onboarding_redemption_log FROM :"app_role";
REVOKE UPDATE, DELETE ON onboarding_audit_log FROM :"app_role";
REVOKE UPDATE, DELETE ON auth_event_log FROM :"app_role";
