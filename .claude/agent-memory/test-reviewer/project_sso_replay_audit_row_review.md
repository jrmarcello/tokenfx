---
name: sso-replay-audit-row test-plan review
description: 2026-05-13 DONE review — post-implementation gaps after TASK-0 pivot (logger.error hook replaces pages.error Server Component)
type: project
---

TASK-0 pivoted the architecture from URL-layer detection (`isStateReplayError` + `prepareReplayAuditRow`) to `logger.error` hook (`isStateReplayAuthError` + `deriveSsoProviderFromCallbackPath`). The Test Plan was never updated to reflect the pivot — TC-U-01..07 and TC-U-17/18 reference functions that no longer exist. The test file correctly tests the pivoted API but the spec TCs are stale.

MUST FIX (implementation):
- TC-I-03 mislabeled: spec defines it as an infra/failure-mode TC (`writeReplayAuditRow` with connection killed → rejects), but the test file uses the label for the null-fields happy-path TC. The infra failure-mode TC is completely absent — violates SDD "every external dep has ≥ 1 failure-mode TC".
- TC-U-15 (`about:blank` → `'unknown'`) never written. Spec kept it in Test Plan after pivot; `deriveSsoProviderFromCallbackPath` accepts `string | null | undefined` so `about:blank` is a valid test input.
- TC-E2E-11 is largely vacuous: asserts only a constant property (`hexRe.test(REPLAY_EMAIL_HASH_SENTINEL) === false`) without ever visiting `/manager/audit-log` or downloading the CSV export. Spec required Playwright navigation to manager page + absence check in rendered HTML and CSV response.
- Spec Test Plan TCs not updated post-pivot: TC-U-01..07 describe `isStateReplayError({error, refererPath})`, TC-U-08 describes `deriveSsoProviderFromReferer(fullUrl)`, TC-U-17/18 describe `prepareReplayAuditRow` — none of these functions exist in `replay-detector.ts`. Spec is IN_PROGRESS but the Test Plan section was mutated (prohibited by SDD § Spec File Integrity).

SHOULD FIX:
- `replay-detector.integration.test.ts` was never created (TASK-2 listed it as a new file). TC-I-01..03 were relocated to `auth-event-log-writer.test.ts` — a valid workaround but the spec's `files:` metadata and Design section were not updated.
- TC-E2E-09 does not assert the Location header contains `/auth/error` (spec REQ-5 explicit requirement: "response status is 302/307 with Location containing `/auth/error?error=`"). The audit-row probe is present; the redirect-target assertion is absent.
- TC-I-03 (null-fields variant that was written) could stay under a different TC label; the infra TC needs to be added separately.

NICE TO HAVE:
- TC-E2E-09 `ssoProvider` asserts `'unknown'` — correct for the logger-hook path (provider info unavailable at InvalidCheck time) but the old spec TC-E2E-09 description still says `ssoProvider='okta'`. Spec description should be updated for accuracy.

**Why:** Post-pivot spec cleanup was incomplete. SDD requires Test Plan immutability in IN_PROGRESS but the pivot made the original TCs untestable, and they were silently replaced rather than surfaced to the user.
**How to apply:** Always diff spec Test Plan TC function names against production exports when reviewing post-pivot. Missing infra TC is the highest-severity gap (no coverage for DB write failure in production).
