---
name: SSO threat model — central-server-onboarding-v2-sso
description: Key decisions locked and open questions from the SSO auto-provision threat model, for when the implementation spec is reviewed
type: project
---

Threat model at `.specs/central-server-onboarding-v2-sso.threat-model.md` is APPROVED (commit `3b05b89`).
Schema-migrations spec (a) is DONE (commit `cee4dcc`). Schema is confirmed correct in `apps/server/lib/db/schema.ts` + `0004_sso_auto_provision_schema.sql`.
Backend spec (b) is DRAFT as of 2026-05-11.

## What actually shipped in schema (spec a)

All 9 schema preconditions confirmed present:
- `users` composite UNIQUE `(org_id, email)` + `(org_id, sso_provider, sso_subject)` NULL-tolerant — confirmed in schema.ts lines 63-68
- `onboarding_outcome` enum extended with 10 SSO-decision values — confirmed in 0004 SQL
- `onboarding_redemption_log` gains method, sso_provider, sso_subject_hash, iss, user_agent — confirmed schema.ts + 0004
- `onboarding_invites` gains `allowed_sso_providers text[]` + 180d CHECK + partial index — confirmed
- `user_machines` gains `provisioned_via` column — confirmed schema.ts lines 88-95
- `auth_event_log` table created with 3 indexes + outcome CHECK — confirmed schema.ts lines 642-673

## auth_event_log outcome CHECK constraint

The `auth_event_log_outcome_check` does NOT include `'rate-limited'` as a valid outcome. But spec (b) REQ-12 says rate-limited attempts are logged with `outcome='rate-limited'` — this is a contract conflict. The v1 outcome `'rate-limited'` exists in `onboarding_outcome` enum but NOT in `auth_event_log.outcome CHECK`. The spec (b) audit-log for rate-limit attempts would fail the DB CHECK constraint at runtime.

## Key open finding from spec (b) review

1. **REQ-12 / `auth_event_log` outcome mismatch**: `'rate-limited'` is not in `auth_event_log_outcome_check`. Spec (b) must either add it to the CHECK or log rate-limit events only to `onboarding_redemption_log` (not auth_event_log).
2. **REQ-5 ordering correctness**: spec (b) correctly places pre-existing-binding check AFTER `allowed_sso_providers` check (step 6 before step 7). This is correct per Decisão #2 — cross-IdP guard comes first, then binding refusal. M11.1 still fires on any same-org match regardless.
3. **REQ-8 team_id=NULL**: `users.team_id` is `ON DELETE SET NULL` per schema.ts:43. If invite's team deleted between issuance and redemption → user row silently gets `team_id=NULL`. Spec calls this acceptable (invite.team_id is "non-privileged metadata"). TC-I-12 covers `team_id=NULL` case but not the deleted-team scenario — should add a TC.
4. **TC-I-08 race simulation**: `vi.useFakeTimers` cannot interleave with real DB driver RTT. The test must use two concurrent real DB connections, not fake timers.
5. **REQ-22 timing**: spec says email is invoked "when decision-engine completes" (sync, fire-and-forget via catch-and-log). REQ-22 + Design §audit-log-isolation confirm failure doesn't block. Acceptable.
6. **T11 / M11.2 partial mitigation**: stub email is honest per Decisão #8. Follow-up spec `central-server-email-channel.md` is the real delivery. Risk is documented.
7. **Missing TC for `'rate-limited'` in auth_event_log**: TC-I-20 asserts `'rate-limited'` outcome in audit row but the DB constraint doesn't allow it.

## Why

Prevents downstream spec (c) from assuming audit log shape that doesn't match DB constraints.

## How to apply

When reviewing spec (c) (manager-ui), verify the audit log query uses the actual CHECK-constrained outcome values. When spec (b) executes, the `'rate-limited'` auth_event_log write MUST be resolved before commit.

## Spec (c) manager-ui.md — key findings (2026-05-12)

Status: DRAFT under review.

Critical issues found:
1. **Decisão #15 / banner stacking not implemented**: spec (c) REQ-1/2 model a single ack row per (manager, alert_kind), meaning acking one event dismisses ALL unacked events. Decisão #15 locked "per-event acknowledge" — each event should be independently acked. The DB design (single last_ack_at per manager+kind) directly violates this. TASK-1 migration + queries need rethink.
2. **Decisão #17 conflict**: threat model §Decisão #17 says "≥1 selected for new patterns; legacy empty = any". Spec (c) REQ-8 says "empty array = any for new patterns too." REQ-8 contradicts the lock. TC-U-02 tests empty-array-ok on Zod validation level, but the form UI validation should reject empty. The Zod schema is correct for DB writes; the form-level validation is missing.
3. **TC-I-34 (rate-limit with empty IP) is NOT scoped out**: spec removes the empty-IP guard from rate-limit-sso.ts. There is an existing test (rate-limit-sso.test.ts) that currently tests empty-ip behavior implicitly (the per-IP dimension simply doesn't appear in the dimensions array). After the guard removal, all tests pass an empty string to the IP dimension bucket — but no existing test covers this case. The migration test is in scope but the description says the existing test still covers it; verify.
4. **onAfterSelectForUpdate seam deletion is a breaking refactor**: TASK-14 removes `onAfterSelectForUpdate` from `ProvisionInTxInput` and `AutoProvisionDeps`. The seam is a public exported type used in both production code and tests. Deleting it from the interface while simultaneously removing test cases that use it is a coordinated change across 3 files — high risk of partial application leaving the type broken.
5. **MaxMind test fixture provenance undefined**: "~8 IPs in known cities" mmdb binary needs to be committed to the repo but no instruction for how to generate/obtain it. Ops docs say "MaxMind free download" for the real file, not for the test fixture.
6. **`extractContextFromRequest` error path missing**: ALS wiring (REQ-13) wraps the handler inside `runInRequestContext(extractContextFromRequest(req), ...)` but there is no REQ or TC for what happens if `extractContextFromRequest` throws (malformed headers, etc.).
