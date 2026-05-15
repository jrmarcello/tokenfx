---
name: central-server-onboarding-v2-sso.backend implementation test review
description: 2026-05-12 IN_PROGRESS review of 16 new test files — rejected-replay dead code arm (zero TCs + no production path), TC-I-08/09/10 provisionInTx stub bypass gap, fake-timer absence in auth-event-log-writer
type: project
---

Spec: `.specs/central-server-onboarding-v2-sso.backend.md` — Status IN_PROGRESS; reviewed 2026-05-12.

Previous DRAFT review gaps resolved by implementation:
- TC-U-39/40 cover `email-not-verified` — both unit tests present and correct.
- TC-I-44 covers `Origin: null` in csrf suite — test written and passing.
- TC-U-43 covers `sendEmail` returning `{ ok: false }` Result — present in unit suite.
- Fake-timer methodology corrected: `rate-limit-sso.test.ts` uses `vi.useFakeTimers` + `vi.useRealTimers` cleanly in beforeEach/afterEach.

**Remaining MUST FIX gaps:**

1. `rejected-replay` is in `AutoProvisionDecision` union (`sso-auto-provision.ts:133`) but the orchestrator contains zero code paths that return it — `git grep "return.*rejected-replay"` yields nothing. The type is a dead arm. Consequently TC-I-34/45 (DEFERRED, replay) and TC-E2E-01/02 reference a flow that is not yet implemented. The TDD convention says the RED phase must fail because the production path is absent — but here the type declaration compiles without the implementation, so tests for the happy path silently pass. Needs: implement the replay check in the orchestrator OR add an explicit "not-yet-implemented" guard that forces the unit test to catch the dead branch.

2. TC-I-08/09/10 use a `provisionInTx` stub override that returns `rejected-race` directly. The actual Drizzle SELECT FOR UPDATE re-validation logic inside the real `provisionInTx` is **never exercised at any level** — neither unit (stubs bypass it) nor integration (override bypasses it). The long explanatory comment acknowledges the deadlock reasoning, but it does not prove the race logic is correct; it proves only that the orchestrator correctly propagates a `rejected-race` result it is handed. SHOULD escalate to MUST FIX if `provisionInTx` has non-trivial re-validation logic.

**Remaining SHOULD FIX gaps:**

3. `auth-event-log-writer.test.ts` lines 134/208–214 use `Date.now()` comparisons against real wall-clock with a 5s tolerance — no `vi.useFakeTimers`. Under heavy CI load this can flake if the write takes > 5s. Prefer fake timers or a wider sentinel window (30s, like TC-I-14 in the flow suite which uses 30_000ms).

4. TC-I-17 privacy assertion in `auth-event-log-writer.test.ts` is labelled "partial" — it correctly asserts the **writer** logs nothing, but there is no test that runs the full `evaluateAutoProvision` orchestrator and asserts `lib/logger`'s output contains no raw email or sso_subject. The orchestrator does log `email_domain` (safe) in several warn paths — a future regression that accidentally logs `normalizedEmail` instead would not be caught.

5. `sso-auto-provision-rate-limit.test.ts` `afterEach` deletes rows via a chain of `db.delete()` calls in FK order instead of a single `TRUNCATE ... CASCADE`. If a future schema adds a new FK-dependent table, the cleanup silently leaves rows. Use `TRUNCATE TABLE ... RESTART IDENTITY CASCADE` (same pattern as the flow suite).

**Well-covered areas:**
- All 10 `AutoProvisionDecision` branches have at least 1 unit TC (`evaluateAutoProvision` decision tree).
- Rate-limit dimensions (ip/email_hash/sso_subject_hash), sliding-window expiry, and short-circuit ordering are exhaustively unit-tested with fake timers.
- CSRF Origin guard (cross-origin, missing, null, same-origin) fully covered in `sso-auto-provision-csrf.test.ts` including `Origin: null`.
- Deferred tests (TC-I-34/45, TC-E2E-01/02) use the correct loud `console.warn` + `it.skip`/`test.describe.skip` pattern — no silent skips.
- Zero `vi.mock()` calls across all 16 new files. Zero `.only()` calls.
- `SKIP_PG_TESTS=1` guard applied consistently to all Postgres-backed suites.
- Error/edge TCs outnumber happy-path TCs ~3:1 across the suite.

**Why:** `rejected-replay` dead arm is the highest-priority finding — a union variant that is advertised but never produced means the type system gives false confidence about replay protection.
**How to apply:** When reviewing SDD specs with union return types, always `grep` the production file for `return { kind: '<variant>' }` before declaring a TC covered. Stub-override-only integration tests for multi-phase transactional logic (like provisionInTx) should be flagged as partial coverage.
