---
name: sso-e2e-live-execution review (2026-05-14)
description: Findings from reviewing the sso-e2e-live-execution spec implementation — invite-probe helper, schema extraction, orphan-migration port, Playwright tests
type: project
---

Review covered:
- `tests/e2e/helpers/invite-probe.ts` (NEW)
- `app/manager/invites/actions.schemas.ts` (NEW)
- `app/manager/invites/actions.ts` (MODIFIED)
- `tests/e2e/global-setup.ts` (MODIFIED)
- `tests/e2e/manager-ui.spec.ts` (MODIFIED)
- `scripts/seed-manager-v2.ts` (MODIFIED)

Key findings:
- `InviteRow` and `InviteRowMeta` in invite-probe.ts are identical — duplicate type should be merged
- `setup-pg.ts` uses a `Pool` per-orphan-loop (no per-statement pool); `global-setup.ts` correctly uses one `orphanPool` for all orphans — asymmetry is fine, global-setup is actually better
- `setup-pg.ts` still has `console.log` (line 35) — pre-existing, not introduced by this spec
- TC-E2E-06 uses `row!.allowed_sso_providers` (non-null assertion after a `not.toBeNull()` Playwright expect) — in test code this is acceptable but the throw-narrow pattern used for the token match is cleaner
- Orphan-migration filter in global-setup is consistent with setup-pg (same regex, same psql-skip, same comment-only filter)
- Schema extraction cleanly preserves the public API; `allowedSsoProvidersSchema` is now independently testable

**Why:** recorded so future reviews of this spec area don't re-audit already-reviewed patterns.
**How to apply:** reference when reviewing follow-up specs that touch invite actions or E2E probe helpers.
