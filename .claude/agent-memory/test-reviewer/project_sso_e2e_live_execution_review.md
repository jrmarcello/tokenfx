---
name: sso-e2e-live-execution test-plan review
description: 2026-05-14 DONE review of live implementation — all prior MUST FIX gaps closed; 2 SHOULD FIX remain (duplicate types, onConflictDoNothing idempotency risk); TC names contain TC-IDs (SHOULD FIX)
type: project
---

Implementation audit (2026-05-14, spec status DONE).

All prior MUST FIX gaps resolved:
- Seed uses quinn+rita (not alice/bob) — correct platform team members.
- Clock margin is 2000ms — matches team-roster-csv.test.ts convention.
- withClient wrapper handles connect failures with context-bearing Error.
- waitForSelector('[data-testid="team-members-table"]') drains SSR before row-count assertion.
- queryInvitesCreatedSince present in invite-probe.ts.
- downloadPromise registered before click() — correct ordering.
- No .only / .skip in file.
- token regex `[0-9a-f]{64}` is tight and correct.
- TC-E2E-07b is standalone with fresh sign-in.

Remaining gaps:

SHOULD FIX:
- Test titles include TC-IDs as prefixes (TC-E2E-06, TC-E2E-06b, etc.) — convention requires natural English names without TC-IDs in the title string.
- InviteRow and InviteRowMeta in invite-probe.ts have identical shapes — dead alias, misleading to readers.
- userMachines uses onConflictDoNothing for provisionedVia: if a previous seed run wrote the row with the default 'pre-v2-unknown', a re-run silently skips the update and quinn/rita stay non-sso-auto. TC-E2E-07 would fail on second run from a dirty DB.
- invite-probe.ts query leaks client.end() if fn() throws (the finally block only covers after connect succeeds, but the inner try has no finally guard around fn(client) — actually withClient does have finally, so this is fine). Confirmed safe.

NICE TO HAVE:
- No Vitest integration test pins seed output ("platform team has ≥ 2 sso-auto rows") — only runtime E2E guards it.
- TC-E2E-06 does not assert the initial default state (google pre-checked) before unchecking — minor; not a correctness risk.

**How to apply:** When seeding idempotency matters for test fixture correctness, check whether onConflictDoNothing silently preserves stale values vs onConflictDoUpdate refreshing them.
