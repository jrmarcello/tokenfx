---
name: central-server-onboarding test-plan review
description: Gaps found in the onboarding spec test plan — v2 review on 2026-04-30 (v2 has ~75 unit/integration + 10 fuzz + 7 E2E covering 39 REQs)
type: project
---

# central-server-onboarding test-plan review (v2)

Reviewed `central-server-onboarding.md` v2 DRAFT on 2026-04-30. ~75 unit/integration TCs + 10 fuzz + 7 E2E.

All 12 gaps from v1 review are addressed in v2 (Zod boundaries, 401 uniformity, team_id branch, concurrency TC-I-62+63, DB failure TC-I-64, etc.).

## CRITICAL gaps remaining (must fix before APPROVED)

1. **REQ-11, REQ-12 — zero TCs for Session.user.id / JWT wiring.** TASK-5 maps only to TC-I-13 (member-role guard), not to the JWT chain. A regression silently writes null `actor_user_id` to every audit log row (FK fails at runtime). Need TC-I-74 (session.user.id == DB users.id) and TC-I-75 (auth.config.ts Edge path propagates userId).
2. **REQ-13 — signIn callback: four branches, zero TCs.** The SSO-conflict branch (invited user → OAuth attempt with different provider/subject) is the primary guard against email-account hijacking. Need TC-I-76..79 for all four branches.
3. **TC-F-05 — wrong expected outcome.** Forged machine_id to an EXISTING `user_machines` row expects "200 (different user)" but the UNIQUE constraint on `machine_id` causes a 500 (or 409 if caught). If machine_id is globally unique, expected = 500/409. Must resolve schema intent first.

## WARNING gaps

4. **REQ-7 — no client-side Bearer TC.** TASK-4b modifies `lib/reporter/client.test.ts` but assigns no TC-IDs to it. Need TC-U-29 (header value exact), TC-U-30 (no X-Signature), TC-U-31 (import resolves from canonical-json.ts).
5. **bcrypt injection — TC-I-65 requires vi.mock unless Design adds DI.** `redeemInvite()` calls `bcrypt.compare` directly. Need `bcryptCompare` injectable parameter (same pattern as reporter client). Same for route.ts auth logic.
6. **Idempotency key isolation — TC-I-88 missing.** User A and User B with same `idempotency_key` value must get separate tokens (keyed on `actor_user_id:idempotency_key`). Without TC-I-88 an impl that drops the user prefix leaks tokens between users.
7. **TC-I-33 contradicts REQ-27 rate-limit bounds.** TC says "10 attempts same token, 11th 429" but REQ-27 says per-token limit is 3/min. Fix: rewrite TC-I-33 to test the actual 3/min per-token boundary.
8. **Bearer edge cases (TC-I-83..86):** case-insensitive scheme (RFC 7235), empty bearer, 64KB bearer (bcrypt DoS), old signature field in body (migration proof). TC-I-85 is a DoS vector — bcrypt.compare on huge strings is expensive at cost=12.
9. **REQ-5 one-sided — TC-I-03b missing.** Only production throw tested. Dev fallback (NODE_ENV=development → uses 'tokenfx-dev-pepper') has no TC.
10. **REQ-15 retry loop — TC-U-32, 33 missing.** Happy path only (TC-U-03). Collision retry (2× fail then succeed) and exhaustion (3× fail → 500) uncovered.
11. **claimed_email max boundary — TC-I-43b, 43c missing.** Schema has `.max(254)`. Valid max (254 chars) and invalid max+1 (255 chars) not tested.
12. **REQ-37 revoked machine Bearer — TC-I-71b missing.** TC-I-71 tests wrong/unknown secret but not a revoked machine's secret.
13. **REQ-32 network failure pre-flight — TC-I-67b missing.** The "network fail → exit 1" branch of pre-flight check has zero TC coverage.

## NIT gaps

14. TC-E2E-06: assert Authorization header is Bearer (not HMAC) at server level — currently only proves HTTP 200.
15. REQ-20: null team_id → team_name null join not tested.
16. REQ-22: show-once flash cookie invalidation not tested (second load should NOT show token).
17. REQ-34: fsync failure and rename-across-filesystems (EXDEV) not tested.
18. REQ-36: 400 Zod message passthrough not tested (TC-U-34).
19. TRUNCATE list in integration test files needs `onboarding_invites`, `onboarding_redemption_log`, `onboarding_audit_log` (9 + 3 = 12 tables now).

**Why:** v2 is solid on Zod boundaries and happy/error paths. The unaddressed CRITICALs are all in the auth-augmentation layer (REQs 11-13) and the bcrypt-injection design gap — exactly the attack surface this spec introduces.

**How to apply:** add TC-I-74..82 + TC-I-87..88 + TC-U-29..34 + TC-I-03b, 43b, 43c, 67b, 71b, 83..86 before marking APPROVED. Fix TC-F-05 expected outcome after resolving machine_id uniqueness intent.
