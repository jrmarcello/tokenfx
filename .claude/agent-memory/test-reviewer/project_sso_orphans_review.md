---
name: sso-test-coverage-orphans test review
description: 2026-05-12 DONE review — spec-vs-test label mismatch (TC-U-01d code name), duplicate it() TC-ID labels (TC-I-20/21), TC-AO-23b row count correct at 7
type: project
---

Spec `sso-test-coverage-orphans.md` (DONE, commit pending). Key findings:

**MUST FIX — TC-U-01d error code name mismatch in spec only**
- Spec says assert `'invalid_enum_value'` (Zod 3 name); actual test at `actions.test.ts:743` correctly asserts `'invalid_value'` (Zod 4 name). Test is correct. Spec text is stale. Fix the spec description.

**SHOULD FIX — duplicate TC-ID labels in `actions.test.ts`**
- Two `it()` calls labeled `TC-I-20` (line 345 and 432). Two labeled `TC-I-21` (line 500 and 588). Pre-existing TCs (`.strict()` rejection, cache-hit path) retained their original labels; new provider TCs reused them.
- Fix: relabel pre-existing TCs back to original numbers or add suffix (TC-I-20a/20b). Choosing wrong names doesn't affect correctness but breaks TC traceability.

**CONFIRMED CORRECT — TC-AO-23b row count = 7**
- Seed inserts 5 fixture members + managerA + memberA = 7 rows total. `?provisioned_via=all` returns the whole team set. Row count assertion of 7 is correct.

**CONFIRMED CORRECT — TC-AO-23c is independent**
- Uses its own session + request + CSV parse; does not read from TC-AO-23b result. No coupling.

**CONFIRMED CORRECT — Zod 4 code `'invalid_value'`**
- Runtime probe confirms Zod 4 uses `'invalid_value'` for enum violations. Test at line 743 already asserts this correctly.

**CONFIRMED OK — no vi.mock, no .only, no hard .skip**
- `describe.skip` in team-roster-csv.test.ts is behind `SKIP_PG_TESTS` env guard, not a static skip.

**How to apply:** When reviewing future specs that mention Zod enum error codes, always probe the installed Zod version. Zod 3 → `invalid_enum_value`; Zod 4 → `invalid_value`. When adding TCs to an existing test file that already uses TC-IDs, audit for label collisions before reusing numbers.
