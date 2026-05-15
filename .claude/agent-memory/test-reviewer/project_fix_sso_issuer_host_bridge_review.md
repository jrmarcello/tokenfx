---
name: fix-sso-issuer-host-bridge test-plan review
description: 2026-05-15 DRAFT review — REQ-6 zero TCs, TC-E2E-02 vacuous @smoke reference, TC-I-05 manual posing as automated, dual-URL issuer-mismatch TC absent, HOST-injection TC misframed, no nonce/state-replay regression TC
type: project
---

2026-05-15 DRAFT review of `.specs/fix-sso-issuer-host-bridge.md` Test Plan.

**Why:** Spec fixes compose topology so browser can reach idp-stub and AUTH_TRUST_HOST=1 is added.

**How to apply:** Reference when reviewing implementation or future compose-topology specs.

## Gaps found

- **REQ-6 zero TCs** (MUST FIX) — No TC asserts that the production image ships without AUTH_TRUST_HOST. Add a static grep/env-inspect TC.
- **TC-E2E-02 vacuous @smoke reference** (MUST FIX) — Describes "existing @smoke bypass-cookie test" but auth-bypass.spec.ts has no @smoke tag. The actual bypass-cookie @smoke test is `review-fixes-smoke.spec.ts:TC-E2E-03`. Description must name the concrete test file/TC.
- **TC-I-05 manual posing as automated** (MUST FIX) — Classified TC-I (integration) but is a hand-rolled curl walkthrough in smoke-runbook.md. Should be marked Manual or moved to the runbook exclusively without a TC-I label.
- **HOST-injection TC-I-02 misframed** (SHOULD FIX) — Expected: HTTP 200 (accepting the spoofed host). This is documenting the intended lax behavior, not asserting a guard. There is no TC for the complementary case: without AUTH_TRUST_HOST the server rejects the request. The negative case is what proves the guard actually gates production.
- **Dual-URL issuer-mismatch fallback zero TCs** (SHOULD FIX) — Design §3 mentions that if TC-I-03 fails, TASK-2 may fall back to dual-URL (host.docker.internal vs localhost), but NextAuth's `iss` claim strict-match would then break. No TC covers this failure path.
- **No nonce/state-replay regression TC** (SHOULD FIX) — Threat Model item 4 says the H2 nonce-replay defense remains in effect, but no TC verifies that sso-nonce-replay.spec.ts / sso-flow.spec.ts:TC-E2E-08 still pass against the new compose topology.
- **Stub-crash and network-partition infra-failure TCs absent** (SHOULD FIX) — No TC for: stub container stopped mid-flow; container can't reach stub (connection refused from tokenfx-server). REQ-4 has two healthy-path infra TCs but zero failure-mode TCs.
- **TC-E2E-01 TC-ID collision with review-fixes-smoke.spec.ts** (NICE TO HAVE) — The new smoke-sso-live.spec.ts will introduce a TC named TC-E2E-01 that duplicates the TC-E2E-01 label already used in review-fixes-smoke.spec.ts for the same scenario. Consider renaming to TC-E2E-S1 or prefixing with the spec slug.

## Totals
- 8 TCs: 3 happy, 5 non-happy (ratio acceptable on the surface but 2 of the 5 are healthy-path infra probes, not failure-mode)
- REQ coverage: REQ-1, REQ-2, REQ-3, REQ-4, REQ-5 covered; **REQ-6 zero TCs**
