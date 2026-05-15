-- TokenFx central reporter server — local-org seed for AUTH_REQUIRED=false mode
-- Spec: .specs/auth-optional-mode-and-sso-bugfixes.md (REQ-4)
--
-- ============================================================================
-- Seeds the deterministic `local-org` row referenced by the synthetic demo
-- session injected when `AUTH_REQUIRED=false` (localhost-only open-access
-- mode). The id matches the `LOCAL_ORG_ID` constant in
-- `lib/auth/auth-required.ts`.
--
-- Idempotent (`ON CONFLICT (id) DO NOTHING`), so the migration is safe to
-- run in every environment. The row is harmless outside localhost mode —
-- no code path references it unless `AUTH_REQUIRED=false`.
-- ============================================================================

INSERT INTO orgs (id, name)
VALUES ('00000000-0000-0000-0000-000000000001', 'Local Development Org')
ON CONFLICT (id) DO NOTHING;
