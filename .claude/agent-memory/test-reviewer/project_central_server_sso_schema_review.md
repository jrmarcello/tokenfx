---
name: central-server-onboarding-v2-sso.schema-migrations test-plan review
description: 2026-05-11 DONE review of actual test files — TC-I-38..41 missing, TC-I-07 weaker than spec, TC-U-04 label dup, TC-I-40 jwt-warn-pick-first uncovered
type: project
---

Spec: `.specs/central-server-onboarding-v2-sso.schema-migrations.md` — Status DONE

## Key findings (actual test files reviewed 2026-05-11)

**MUST FIX:**
- TC-I-38/39/40/41 (REQ-14/15) — NOT implemented anywhere. auth-session.test.ts covers TC-I-76/77/78 instead (functionally equivalent for TC-I-38/39 fill-sso/allow), but TC-I-40 (jwt warn+pick-first when 2 rows match email) and TC-I-41 (e2e bypass array) have zero coverage.
- TC-I-07 assertion weaker than spec demands: spec says "array equality — exact 10-element new set, no extras, no missing"; test uses per-value `toContain` loop — cannot catch spurious additional enum values.

**SHOULD FIX:**
- TC-U-04 label duplicated (two `// TC-U-04` comments at load-user.test.ts lines 77 and 86). Second case (subject-mismatch) should be TC-U-04b or collapsed into it.each.
- TC-I-03 scope narrowed from spec: spec says "row count + sample hash unchanged"; test only asserts legacy single-col UNIQUE gone via pg_constraint query. No row-data preservation — degraded because container has no pre-existing rows.
- `console.warn` banners for REVOKE skips are at module level (migrate-0004.test.ts lines 40-49), not inside each `it.skip` body — banner fires even under `SKIP_PG_TESTS=1` where the describe.skip elides all tests.

**VERIFIED CORRECT:**
- TC-I-06b (orgA, NULL, 'sub') — present and correct (line 183).
- TC-U-12 `rejects.toThrow(/invariant violation: multiple users/)` — correct (line 341).
- TC-I-25 (180d exact) and TC-I-26 (180d+1ms) — both precise.
- TC-I-32b (RAISE NOTICE SQL grep) — present (line 662).
- TC-U-10/11 boundary — 512-char tests correct (truncate-user-agent.test.ts lines 6-18).
- TC-I-42 (same-org reuse) and TC-I-43 (cross-org isolation, machine→correct user) — fully correct.
- No `.only` anywhere. `it.skip` entries all have loud `console.warn` companions.

**How to apply:** Future SSO specs should explicitly require a TC for jwt() callback multi-row branch (≥2 emails across orgs) and use `toEqual(expect.arrayContaining([...]))` with a length assertion for enum-value checks.
