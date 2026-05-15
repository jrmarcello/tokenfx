---
name: sso-nonce-replay review (2026-05-13)
description: Findings from targeted code review of sso-nonce-replay spec implementation — 6 focused questions answered
type: project
---

Spec: sso-nonce-replay.md, IN_PROGRESS. idp-stub 89/89 (+15), apps/server 1234 (+1). Key findings below.

**Why:** Recorded to capture the security and correctness analysis of the nonce-replay implementation for the team memory.

**How to apply:** Cross-reference when reviewing future OAuth/nonce/IdP-stub changes.

## TC-E2E-04 nonce privacy test structural flaw

SHOULD FIX. TC-E2E-04 captures `generatedNonce` from the FIRST `/api/auth/signin/okta` call (maxRedirects:0), then drives a SECOND fresh signin call with `maxRedirects:10` to trigger the nonce-mismatch rejection. The nonce in the audit row comes from the SECOND signin's nonce, not the first. The privacy assertion uses the first nonce value against the second flow's audit row — they are different nonces. The test passes but does not prove what it claims to prove. The correct approach: do one signin/capture, use that same request context to drive the callback with tampered token (same flow), then check the row.

## TC-E2E-04 cookie context question

The `request` fixture in Playwright is a stateful APIRequestContext that persists cookies across calls within a single test. Both calls to `/api/auth/signin/okta` in TC-E2E-04 share the same cookie jar. The first call (maxRedirects:0) sets NextAuth's nonce cookie; the second call (maxRedirects:10) with `setStubScenario({nonce:'tampered'})` starts a NEW OAuth flow that overwrites the nonce cookie. So the nonce checked by NextAuth in the second flow is NOT the `generatedNonce` captured from the first call.

## `setPendingNonce(null)` empty-nonce security question

VERIFIED CORRECT. An attacker who sends `?nonce=` (empty) after a real `?nonce=X` would call `setPendingNonce(null)`, clearing the slot. This is not exploitable: (a) the stub is loopback-only and admin-endpoint-gated, (b) for the production Auth.js flow, `/authorize` is called once per flow — the empty nonce clears the slot so the next /token mints a token with no nonce claim, which Auth.js would reject (nonce cookie present but id_token.nonce absent). The security outcome is a rejected login, not a bypassed check.

## `??` semantics in resolution order

VERIFIED CORRECT. `scenario.nonce ?? pendingNonce ?? null` — `??` passes through both `null` and `undefined` to the right operand. `scenario.nonce` is typed `string | null` (never undefined), so `null` falls through to `pendingNonce`. `pendingNonce` is `string | null | undefined` (optional in SignInput), so both `null` and `undefined` fall through to the final `null`.

## redirect_uri allow-list guard placement

VERIFIED CORRECT. `isAllowedRedirectUri` runs AFTER `AuthorizeQuerySchema.safeParse` in `/authorize`. Zod ensures `redirect_uri` is a non-empty string before `isAllowedRedirectUri` sees it. The guard was not absorbed into Zod `.refine()` — it remains as a separate post-parse check. Security invariant preserved.

## auth.config.test.ts duck-typed provider check

SHOULD FIX. The test accesses `.options?.checks` OR `.checks` via double cast `(okta as {...}).options?.checks ?? (okta as {...}).checks`. After the `as readonly string[]` cast on line 33, if the property is `undefined` on both shapes, the `expect(checks).toBeDefined()` assertion will fail but the subsequent `expect(arr).toContain('nonce')` will throw a TypeError because `undefined as readonly string[]` is not iterable. The assertion order is correct (toBeDefined before toContain) so the test fails cleanly. No type safety gap in practice.

## sso-replay-audit-row refactor

VERIFIED CORRECT. `waitForReplayRow` is imported from `./helpers/audit-log-probe` in both spec files. The `ReplayRow` type and `queryReplayRowsSince` function are identical to the original inline versions. TC-E2E-09..11 behavior is unchanged.
