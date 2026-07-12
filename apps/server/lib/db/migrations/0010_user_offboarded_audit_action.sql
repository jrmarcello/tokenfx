-- TokenFx central reporter server — user-offboarded audit action.
-- Spec: .specs/data-retention-policy.md (REQ-7)
--
-- ============================================================================
-- Adds the 'user-offboarded' value to the onboarding_audit_action enum so the
-- admin offboarding flow (/manager/admin/users) can write an audit row when a
-- departing dev's identity is anonymized in place.
--
-- Contains ONLY the ALTER TYPE statement — no DML uses the new value in the
-- same file (a freshly-added enum value cannot be used until the transaction
-- that added it commits). `ADD VALUE IF NOT EXISTS` is idempotent. The Drizzle
-- array `onboardingAuditActionEnum` in lib/db/schema.ts is updated in lockstep
-- so the typed insert accepts the literal (no TS↔Postgres drift).
-- ============================================================================

ALTER TYPE onboarding_audit_action ADD VALUE IF NOT EXISTS 'user-offboarded';
