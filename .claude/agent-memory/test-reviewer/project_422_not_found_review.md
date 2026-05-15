---
name: outcome-integration-git-v3-422-as-not-found test review
description: 2026-05-07 IN_PROGRESS review — all 11 TCs implemented and passing; key findings on TC-U-05 precedence fixture weakness and makeRunImplLookup unused-fixture gap.
type: project
---

Reviewed implementation of `.specs/outcome-integration-git-v3-422-as-not-found.md` (IN_PROGRESS, 2026-05-07). All 11 TCs implemented and green (72 tests total across both files).

**Why:** v3 extends `classifyGhResult` with a new arm for HTTP 422 SHA-not-found stderr.

**How to apply:** In future reviews of this area, trust the v3 TCs as load-bearing; the `makeRunImplLookup` helper's fresh-per-call options pattern is intentional (tests evaluator's anyFailure accumulator, not lookupMergedPrCount's caching layer).

## Findings

### SHOULD FIX
- TC-U-05 fixture has rate-limit phrase FIRST in the stderr string. Code-order precedence (not string-order) is what matters. A fixture with not-found phrase FIRST in the string would be the stronger test and would catch a hypothetical bug that incorrectly dispatches based on string-order.
- `makeRunImplLookup` has no assertion for unused fixtures (fewer calls than fixtures.length). Only over-exhaustion throws. Silent unused fixtures could hide off-by-one bugs in `setupSessionWithCommits`.

### NICE TO HAVE
- TC-IDs in `it()` strings (e.g., `'TC-U-01 (v3): ...'`) is a file-level convention from v2, not a project rule violation.
- `vi.spyOn` usages in both files are pre-existing from v2 spec — not introduced by v3.

### No blocking issues
- All 9 unit TCs + 2 integration TCs present; no `.only`/`.skip`; no `vi.mock` introduced.
- TC-U-08 defensive check passes through status-0 JSON-parse path correctly.
- TC-U-03b (6-char, below min) and TC-U-03c (41-char, unanchored match) are both present — DRAFT gaps fixed in implementation.
- TC-I-02 v3 is meaningfully distinct from v2 TC-I-15 (rate-limited at evaluator vs at classifier level).
