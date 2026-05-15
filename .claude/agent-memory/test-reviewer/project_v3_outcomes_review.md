---
name: manager-dashboard-v3-outcomes test-plan review
description: Coverage gaps found in manager-dashboard-v3-outcomes.md test plan — DRAFT review 2026-05-07
type: project
---

# manager-dashboard-v3-outcomes test-plan review

## Review date: 2026-05-07

Spec status: DRAFT. 14 unit + 12 integration + 3 E2E TCs. 16 REQs.

## MUST FIX gaps

1. **REQ-8 and REQ-10 have zero TCs** — session_outcomes_agg and team_outcomes_daily schema (PK, FK CASCADE, index) never exercised. Need raw SQL schema TCs against real DB.
2. **team_outcomes_daily UPSERT idempotency not tested at table level** — TC-I-07 is HTTP-level only; a missing ON CONFLICT clause would be swallowed. Need direct cron-logic TC.
3. **No infra-failure TC for cron DB write** — SDD §Coverage rules requires ≥1 infra-failure TC per external dep call. All 4 cron TCs are happy/idempotency only.
4. **Boundary TCs missing for loc_removed, files_changed, reverts_within_7d** — TC-U-08 only covers commit_count=-1, TC-U-09 only covers loc_added overflow. 3 of 5 int fields unguarded.
5. **costPerMergedLoc zero-denominator not covered** — TC-U-13 happy-path only; div-by-zero would produce Infinity not null without the guard.
6. **TC-I-08 missing 401 (unauthenticated) status** — TC-I-09 covers 403 (wrong role), but unauthenticated path not tested. Different branch in NextAuth.
7. **TC-I-12 missing 403/401 paths for /me/visibility** — only happy path covered.
8. **TC-I-01 backward-compat TC risks being implemented as 200-status-only** — Expected must explicitly assert SQL NULL column values via SELECT.
9. **No integration TC for null/0 round-trip through /api/ingest → DB** — TC-U-06/07 are sanitizer-unit only; merged_pr_count=null vs 0 DB assertion missing. JSON null→0 coercion bug would pass current TCs.
10. **Privacy regression TC missing for new outcome fields** — no TC asserting commit_sha, file_path, pr_title are stripped. Fase 2 had a fuzz TC for this; v3 extends the allowlist surface.

## SHOULD FIX gaps

- REQ-6 (zero new env vars): no TC. Need static-analysis or process.env-cleared integration TC.
- TC-I-08: KPI card structural presence asserted, not value correctness. Need seed-with-known-values TC.
- TC-I-06: cross-org isolation — Expected says "só pra A" but doesn't mandate SELECT WHERE org_id='org-b' = 0 assertion.
- TC-I-05: "ausente ou zero values" ambiguous. Must pick one and remove the "ou" branch.
- TC-U-07 boundary: merged_pr_count=-1 (invalid-min-1 for nullable int≥0) not covered.
- TC-I-04: "sums corretos" without numeric values — needs seeded commit_count multiplied out.
- TC-U-14b: revertRate(reverts=0, commits=5) → 0.0 missing (TC-U-14 only covers null guard).

## NICE TO HAVE

- TC-U-09 overflow note: if safeIntNonNeg is a shared const, one TC covers all fields; if inlined, need it.each.
- E2E TCs don't name required seed fixture — risk of silent CI skip (same pattern as v2).
- TC-I-08/10 HTML string match is fragile without data-testid contract.

## Overall confidence

**Low** — schema contracts (REQ-8/10), null/0 DB round-trip, infra-failure modes, and 3/5 int field boundaries all unguarded. Happy-path and routing coverage is solid; data-layer and boundary coverage is not.

**Why:** Apply these gaps as blocking comments at Pause-1 before approving this spec.
