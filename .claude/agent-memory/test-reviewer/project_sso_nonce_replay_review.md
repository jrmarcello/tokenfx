---
name: sso-nonce-replay test review
description: 2026-05-13 IN_PROGRESS implementation review — TC-E2E-04 wrong nonce for privacy assertion, TC-I-02 dead-code as-never cast, TC-E2E-02 missing session cookie, TC-E2E-03 >=1 not exactly-1
type: project
---

Review of implemented tests for `.specs/sso-nonce-replay.md` (89/89 passing).

## MUST FIX

1. **TC-E2E-04 asserts the WRONG nonce** (`sso-nonce-replay.spec.ts:99`): test does TWO separate `/api/auth/signin/okta` calls. First call (maxRedirects:0) captures `generatedNonce` (NONCE_A). Second call (maxRedirects:10) with tampered scenario generates NONCE_B. The audit row, if it erroneously stored a nonce, would contain NONCE_B. The assertion checks for absence of NONCE_A. Privacy check is a false negative — wrong nonce, wrong flow.

2. **TC-I-02 second phase is dead code** (`server.test.ts:475`): `store.set({ nonce: undefined as never })` is immediately followed by `store.reset()` which overwrites it. The `as never` cast is dead code. Spec says "reset only scenario.nonce to null and re-call /token — slot was set despite pin". Test uses full `reset()` (which clears BOTH slot AND scenario) then manually re-sets pending. Tests a different scenario than specified.

## SHOULD FIX

3. **TC-E2E-02 missing session-token cookie assertion** (`sso-nonce-replay.spec.ts:62`): spec says "a `authjs.session-token` cookie is present (positive session-established)". Test only checks `res.url()` doesn't contain `/auth/error`. Missing cookie assertion.

4. **TC-E2E-03 uses `>=1` instead of exactly 1** (`sso-nonce-replay.spec.ts:92`): spec says "EXACTLY one new auth_event_log row". `expect(rows.length).toBeGreaterThanOrEqual(1)` would pass if the hook fired multiple times.

5. **TC-I-06 inconsistent property-absence assertion** (`server.test.ts:226`): uses `toBeUndefined()` while TC-I-03/04/08 all use `expect('nonce' in decoded).toBe(false)`. Not a correctness bug (JWT payloads can't have undefined values) but inconsistent with the standard pattern in this file.

## NICE TO HAVE

6. **TC-E2E-03 email_hash sentinel assertion is vacuous** (`sso-nonce-replay.spec.ts:95`): `queryReplayRowsSince` already filters on `email_hash = REPLAY_EMAIL_HASH_SENTINEL`, so `expect(row.email_hash).toBe(REPLAY_EMAIL_HASH_SENTINEL)` always passes.

7. **TC-I-05b error body assertion too weak** (`server.test.ts:533`): asserts `typeof errBody.error.message === 'string'` but doesn't verify the raw 256-char nonce is NOT included. Security.md says "HTTP 400 responses never include the raw user-supplied query value".

8. **TC-E2E-02 redundant sleep** (`sso-nonce-replay.spec.ts:71`): `await new Promise(r => setTimeout(r, 300))` before `waitForReplayRow(..., 500)`. The helper already polls; the external sleep is unnecessary.

9. **ScenarioOverrideSchema nonce valid-min/valid-max acceptance TCs missing** (pre-existing gap): `scenario.test.ts` only has rejection tests for nonce (empty=rejected, 256=rejected). Missing 1-char (valid-min) and 255-char (valid-max) acceptance tests. Pre-existing, but spec added nonce TCs to the same describe block.

**Why:** Written to preserve gap context for future reviews of this spec.
**How to apply:** Flag TC-E2E-04 and TC-I-02 as highest priority — they are correctness/privacy regressions.
