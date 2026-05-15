---
name: manager-dashboard-v2-followups test-plan review
description: Findings from 2026-05-06 test-reviewer pass on manager-dashboard-v2-followups spec (IN_PROGRESS)
type: project
---

Review performed 2026-05-06. 527 vitest / 22 E2E pass at time of review.

Key findings:

**MAJOR — vi.mock in dismiss-action.test.ts is the only vi.mock in the codebase (no prior vi.mock precedent; cited redeem-route.test.ts:374 is vi.spyOn, not vi.mock). Needs DI seam or accept with explicit comment explaining why.**

**MAJOR — TC-I-17 assertion accepts NEXT_REDIRECT OR module-resolution error. The module-resolution branch means the test can pass even if the lazy import is broken — it does not prove the seam resolved correctly. High false-confidence risk.**

**SHOULD FIX — dismiss-action.test.ts missing null-session TC (stubbedSession = null → forbidden) and missing invalid_input TC (bad FormData). Both branches exist in dismiss-action.ts.**

**MINOR — seed-manager-v2.test.ts TC-I-01 uses seedAlphaShell with gen_random_uuid() instead of stableUuid('org:org-alpha'), creating 2 org rows instead of 1 matching real E2E setup. Idempotency assertion still passes but fixture fidelity is broken.**

**NICE TO HAVE — TC-I-04 in dismiss-action.test.ts not explicitly present (idempotency re-dismiss via Server Action), though TC-I-04 for the helper is covered in manager-dismissed.test.ts.**

**Why:** manager-dashboard-v2-followups is the spec being reviewed IN_PROGRESS.
**How to apply:** Reference these gaps when reviewing the Pause 2 presentation or any follow-up spec that touches dismiss, cron aggregation, or drilldown notification.
