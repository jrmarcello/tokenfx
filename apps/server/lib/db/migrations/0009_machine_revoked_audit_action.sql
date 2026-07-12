-- TokenFx central reporter server — machine-revoked audit action.
-- Spec: .specs/machine-revocation-ui.md (REQ-6)
--
-- ============================================================================
-- Adds the 'machine-revoked' value to the onboarding_audit_action enum so the
-- admin machine-revocation UI (/manager/admin/machines) can write an audit row
-- with parity to invite-created / invite-revoked.
--
-- This migration contains ONLY the ALTER TYPE statement — no DML uses the new
-- value in the same file, because a freshly-added enum value cannot be used
-- until the transaction that added it commits (Postgres). The value is first
-- used by writeAuditMachineRevoked at runtime, well after migrate() commits.
--
-- `ADD VALUE IF NOT EXISTS` makes the migration idempotent (safe re-apply).
-- The Drizzle-side array `onboardingAuditActionEnum` in lib/db/schema.ts is
-- updated in lockstep so the typed query builder knows the literal is valid
-- (no TS↔Postgres enum drift).
-- ============================================================================

ALTER TYPE onboarding_audit_action ADD VALUE IF NOT EXISTS 'machine-revoked';
