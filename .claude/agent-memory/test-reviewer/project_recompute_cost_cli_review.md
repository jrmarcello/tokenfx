---
name: recompute-cost-cli test-plan review
description: 2026-05-11 IN_PROGRESS review — all prior DRAFT gaps RESOLVED; residual findings in the actual test files
type: project
---

Prior DRAFT gaps (all resolved in the implementation):
- TC-I-07 vacuous → fixed with `vi.spyOn(pricing, 'computeCost').mockImplementation(() => beforeTurn.cost_usd * 2)`. Reliable: Vitest Vite transform rewrites named ESM imports to live bindings; spy intercepts the call site in scripts/recompute-costs.ts:266.
- REQ-9 log-prefix → covered by TC-I-13 (logger spy on `log.info`, asserts `String(msgArg).match(/^\[dry-run\]/)`).
- Leap-year boundary → covered by TC-U-18/19 in unit test.
- REQ-12 `--since`/`--session` OTEL paths → covered by TC-I-11/TC-I-12 in scope-filters describe block.
- TC-I-20 (PRAGMA integrity_check) → present.

Residual findings from IN_PROGRESS test file review (2026-05-11):
- **TC-I-13 is a self-fulfilling test**: the test manually constructs the `[dry-run]` prefix (`const prefix = summary.dryRun ? '[dry-run] ' : '';`) and then logs it itself — it does NOT call `main()`. The production `main()` log path is untested. The assertion only validates the test's own code.
- **TC-U-17 (sinceMs exact boundary) has no dedicated test**: TC-U-03 also asserts `sinceMs: Date.UTC(2026, 3, 1)` inline; TC-U-17 is silently merged into TC-U-03. Not a defect (value is asserted), but TC-U-17 as a standalone entry is invisible.
- **TC-I-19 `tsx` path fragility**: resolved via `path.resolve(__dirname, '..', '..', 'node_modules', '.bin', 'tsx')`. Acceptable for a project-local test; CI may fail if tsx is hoisted in pnpm workspace. Worth documenting.
- **Test names contain TC-IDs** (SHOULD FIX): violates sdd.md rule "test names use natural English, NOT TC-IDs". Affects TC-I-01 through TC-I-25 in scope-filters describe.
- **TC-I-08 is vacuous** (previously identified in earlier review): after an already-idempotent run, dry-run on unchanged state always reports 0 updated — this is the idempotency property of the real run, not a dry-run-specific guarantee.
- **`seedTurnSimple` timestamp alignment** correctly guards against reconcile shifting `started_at` backward. Safe for all TCs that use it.

**How to apply:** In future reviews on this spec or related scripts, watch for self-fulfilling log-prefix tests (TC-I-13 pattern) and TC-ID-in-name violations.
