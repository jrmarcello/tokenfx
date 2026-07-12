-- TokenFx central reporter server — local-user seed for AUTH_REQUIRED=false mode
-- Spec: .specs/fix-local-mode-synthetic-user-uuid.md (REQ-2)
--
-- ============================================================================
-- Seeds the deterministic synthetic `users` row referenced by the demo
-- session injected when `AUTH_REQUIRED=false` (localhost-only open-access
-- mode). The id matches the `LOCAL_USER_ID` constant in
-- `lib/auth/auth-required.ts`; `org_id` matches `LOCAL_ORG_ID` (seeded by
-- 0006_local_org_seed.sql — this migration depends on that row existing, via
-- the users.org_id FK).
--
-- Without this row, `buildLocalDevSession()` would still hand a valid UUID to
-- the query layer, but FK-dependent writes (manager_alert_acks.manager_user_id,
-- manager_drilldown_audit.manager_user_id) would violate their FK to users.id.
-- Seeding the row lets the single local admin use every dashboard feature.
--
-- Idempotent (`ON CONFLICT (id) DO NOTHING`), so the migration is safe to run
-- in every environment. The row is harmless outside localhost mode: no code
-- path references it unless `AUTH_REQUIRED=false`, and `LOCAL_ORG_ID` is
-- unreachable by SSO auto-provision, so `users_org_email_unique` /
-- `users_org_sso_unique` can never collide with a real provisioned user.
-- ============================================================================

-- team_id / sso_provider / sso_subject intentionally omitted (NULL by default):
-- the synthetic local user belongs to no team and has no SSO identity.
INSERT INTO users (id, org_id, email, role, display_name)
VALUES (
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000001',
  'dev@localhost',
  'admin',
  'Local Dev'
)
ON CONFLICT (id) DO NOTHING;
