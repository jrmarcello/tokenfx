---
name: oauth-idp-stub test review (DONE — IN_PROGRESS implementation review)
description: 2026-05-12 IN_PROGRESS review — TC-I-23 absent, TC-E2E-08 vacuous, TC-E2E-06/07 skeleton, Zod max-255 gaps, TC-E2E-02 guard-identity missing, TC-E2E-01 DB assertion missing
type: project
---

IN_PROGRESS implementation review 2026-05-12.

Previous DRAFT gaps (pre-implementation) mostly closed by the implementation. Remaining issues:

## MUST FIX

1. **TC-I-23 entirely absent** — no test for `POST /authorize` (wrong HTTP method) → 405/404 anywhere in the tree. This TC is explicitly in the spec (server.test.ts is the designated file).
2. **TC-E2E-08 vacuous** — final assertion is `expect(signinRes.status()).toBeGreaterThanOrEqual(200)` which passes even on HTTP 500. Second callback never issued, `/api/auth/error` path never asserted. The spec requires: first callback 302 to non-error path + second callback 302 to `/api/auth/error?error=`.
3. **TC-E2E-06 skeleton** — test only checks `ssoControl.count() >= 1`; form never submitted, persistence never verified. Spec says: submit → navigate to `/manager/invites/<token>` → observe saved value.
4. **TC-E2E-07 skeleton** — no `provisioned_via=sso-auto` filter applied; final assertion `csv.count() >= 0` always passes even when CSV link is absent.

## SHOULD FIX

5. **Zod max-255 boundaries absent** for `sub`, `aud`, `jti`, `nonce`, `forceIssOverride` — coverage rules require max+1 boundary TC per validated field.
6. **`iat` field missing negative/zero rejection tests** — same `.number().int().positive()` schema as `exp`, but TC-U-19/20 only cover `exp`. No `iat=0` or `iat=-1` test.
7. **TC-E2E-02 guard-identity missing** — spec says "Assert response is from csrf-origin-guard.ts (specific error shape)"; test only checks `status === 403`.
8. **TC-E2E-01 DB assertion missing** — spec says "new users row exists"; test only checks session cookie + `meResp.status < 400`.

## NICE TO HAVE

9. TC-E2E-03 uses `getByRole('alert')` not `getByRole('banner')` — spec explicitly says `getByRole('banner')`.
10. TC-E2E-03 dismiss assertion inside `if (await dismissBtn.count())` — silently skips if dismiss button absent.
11. `/token` response `Content-Type: application/json` not asserted in TC-I-07.
12. TC-I-20 tests bare `http.createServer` not `@hono/node-server serve()` directly.

**Why:** TC-I-23 gap and TC-E2E-08/06/07 vacuousness represent load-bearing security and behavioral contracts; their absence/skeletonization gives false confidence.
**How to apply:** Flag TC-I-23 absence and TC-E2E-08 vacuousness as MUST FIX in future reviews. The max-255 Zod boundary gap is a codebase-wide pattern.
