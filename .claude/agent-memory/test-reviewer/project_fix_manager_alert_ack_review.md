---
name: fix-manager-alert-ack-org-scoping test-plan review
description: 2026-05-12 DONE review — setTimeout flakiness in idempotency TCs, vi.spyOn leak in TC-I-09, vacuous TC-I-08 first-half
type: project
---

Review of `.specs/fix-manager-alert-ack-org-scoping.md` implementation (status DONE).
Test files: `apps/server/app/manager/actions.test.ts`, `apps/server/tests/integration/manager-alerts-banner.test.ts`.

## MUST FIX

- **TC-I-03 (line 491) + TC-I-07 (line 317): setTimeout(25ms) for timestamp-delta assertion is flaky.** Both use real wall-clock sleep to detect ON CONFLICT DO NOTHING by comparing ackedAt timestamps. Postgres clock resolution + CI load can collapse the gap. Fix: vi.useFakeTimers() + advance clock 1s + vi.useRealTimers() in afterEach.

## SHOULD FIX

- **TC-I-09 (line 598): vi.spyOn on logger not reset in afterEach — only in finally.** If test runner is interrupted before finally, spy leaks into subsequent tests and silently suppresses real logger calls. Fix: move mockRestore() to a beforeEach/afterEach pair or a nested describe scope.
- **TC-I-08 first half (line 382, existing): vacuous no-event sub-case.** Proves only "no crash on empty DB", not "no role gate". The meaningful assertion is in the second half (with seeded event). Remove or collapse.

## NICE TO HAVE

- New TC-I-01..09 block has no nested describe wrapper; grep-ability suffers.
- TC-U-02 uses `as never` without an explanatory comment — future readers may "fix" it and make the test vacuous.

## TC Coverage (DONE)

All 11 TC-IDs (TC-U-01, TC-U-02, TC-I-01..09) have matching it() entries. No .only/.skip. No vi.mock (vi.spyOn only, acceptable for instantiated object). TC-I-09 spies on all three log levels (warn, error, info). TC-U-02 asserts both ack.calls.length===0 and revalidate.calls.length===0.

## Coverage ratio

9 integration TCs: 5 security/edge vs 4 happy/idempotency/business — marginally meets "error/edge outnumber happy" rule.

## Overall confidence: medium-high

Security invariant tested end-to-end at DB layer. Timer-dependent idempotency assertions are not deterministic without fake timers.

**Why:** Recurring pattern — setTimeout-based timestamp delta tests are the most common source of flakes in this integration suite.
**How to apply:** Any TC asserting "second write did not update a DB timestamp" must use vi.useFakeTimers(), not setTimeout.
