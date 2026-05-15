---
name: review-report-2026-05-14-fixes test review
description: 2026-05-14 DONE review of 21 test files for auth hardening, security fixes, and hygiene. Key gaps: 5 integration TCs missing entirely, TC-U-17 vacuous, TC-U-13 duplicate label, TC-U-29a missing warn assert, exec.test.ts vi.spyOn on module logger.
type: project
---

Review of `.specs/review-report-2026-05-14-fixes.md` test suite (21 files, ~70 TCs).

**Missing integration TCs (not implemented anywhere, no DEFERRED marker):**
- TC-I-14 (REQ-22): XFF ignored when TOKENFX_TRUSTED_PROXY unset — audit row has null IP
- TC-I-15 (REQ-22): XFF trusted when TOKENFX_TRUSTED_PROXY=1 — audit row has correct IP
- TC-I-16 (REQ-23): bearer-auth rotation integration with real DB (not just unit stub)
- TC-I-17 (REQ-10): auth_event_log row written for InvalidCheck (Postgres integration)
- TC-I-18 (REQ-13): 11-site extractExecRows integration (each query runs against seeded DB)
- TC-I-19 (REQ-7): full write path — iss truncated to 512 in auth_event_log (Postgres)

**TC-U-17 vacuous:** auth.config.canary.test.ts:41 — `if (hasCredentials) { expect(ALLOWED_PROVIDER_IDS.has('credentials')).toBe(true) }` always passes since the Set is defined with 'credentials'.

**TC-U-13 duplicate label:** auth.test.ts:57 — second standalone `it()` uses same "TC-U-13" label as the it.each entry; should be TC-U-13e (tests id_token payload path, not boundary).

**TC-U-29a missing warn assert:** ip-trust.test.ts:46 — spec says "retorna null + logger.warn" but test only asserts null return (no warn spy). Production code doesn't actually warn in untrusted path, so spec expected is wrong — test matches implementation, but the gap should be documented.

**exec.test.ts vi.spyOn(log, 'warn'):** vi.spyOn on @root/logger (module export) not a built-in. Project rule says built-ins only. No DI seam exists in exec.ts.

**TC-I-11a..f in single it():** runner.test.ts:365 — 6 sub-TCs packed into one `it()`. Failure in one obscures the others; should be 6 separate `it()` or `it.each`.

**TC-I-13 force variant uncovered:** writer.test.ts:1029 — only calls `forceOutcomes: false`; the force variant code path is never exercised, though the WeakMap logic is identical.

**Well-covered areas:**
- Boundary TCs for extractIssuer (511/512/513) — excellent
- Cookie security (TC-U-32/33) — field-by-field, no snapshot
- CSRF suffix injection (TC-U-08/09/09b) — correct
- Bearer auth rotation unit (TC-U-27/28/28b with fake timers) — excellent
- Cron auth staging guard (TC-U-34 module-load) — thorough
- E2E skip markers all have rationale

**Why:** Production auth/security code; the 6 missing integration TCs are all PG-gated Postgres tests that validate the security properties end-to-end — without them, regressions in the write path for audit rows or IP logging would be invisible at the unit level.

**How to apply:** Flag missing integration TCs as MUST FIX for any spec touching auth_event_log or bearer-auth rotation. TC-U-17 and TC-U-13 duplicate label are recurring patterns (vacuous conditional, duplicate IDs) — check for them in future reviews.
