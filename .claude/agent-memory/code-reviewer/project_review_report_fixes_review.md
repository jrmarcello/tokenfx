---
name: review-report-2026-05-14-fixes implementation review (2026-05-14)
description: Findings from reviewing implementation of the 22-finding consolidated fix spec (D-1, H1-3, M1/4/5, C-1..7, D-2..6, L1/2/6)
type: project
---

Review covered all 20 tasks across the monorepo. Summary of non-trivial patterns confirmed good:

- TASK-AUTH-HARDENING correctly split extractIssuer/extractEmailVerified/createInvalidCheckHandler into auth-helpers.ts (pure, no NextAuth import) for testability
- D-6 (ROLLUP_ALL_SQL) used two-level aggregation to avoid row-explosion — correct and verified
- C-4 agent found 18 sites vs spec's 11 — all legitimate same-pattern unwraps in manager-v2.ts (which has more queries than the spec counted)
- __getOutcomeSweepPrepareCount returns 0 or 2 (not actual count per-db-prepare) — this is intentional, tests verify ≥1 call = both cached
- getTrustedClientIp reads process.env inline (not injected) — testable only via process.env mutation in tests (vi.stubEnv pattern used correctly)

Residual findings:
1. SHOULD FIX: C-6 left 4 redundant `as number` casts in parser.ts at lines 241, 263, 265, 268 — `typeof === 'number'` already narrows, the casts are no-ops but violate the no-cast convention
2. SHOULD FIX: console.warn in migrate-0004.test.ts (lines 41-47) is at module scope outside any test — fine for test infra but note it fires even on SKIP_PG_TESTS=0 runs
3. NICE TO HAVE: getTrustedClientIp reads process.env directly (not injected as param) — tests must mutate process.env, which works but is less pure than the auth.config.ts buildAuthConfig factory pattern

**Why:** recorded so follow-up reviews in auth/ingest area know which patterns were validated and which minor issues remain.
**How to apply:** reference when reviewing parser.ts or ip-trust.ts in future specs.
