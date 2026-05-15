---
name: fix-e2e-auth-bypass test review
description: 2026-05-11 IN_PROGRESS review — auth Credentials bypass provider. Most prior DRAFT gaps are now FIXED. Remaining: E2E selector too loose, CSRF missing-set-cookie gap, TC-I-04..07 still DEFERRED.
type: project
---

## Status: IN_PROGRESS — reviewed against actual code 2026-05-11

## Prior DRAFT gaps that are NOW FIXED
- TC-U-16 email boundary: 254-char valid + 255-char invalid — BOTH present and correct (lines 184-202 of e2e-bypass-provider.test.ts).
- sign-in-as.ts now has 9 dedicated unit TCs (sign-in-as.test.ts): localhost guard, all 4 CSRF/POST failure modes, happy path (addCookies assertion exact), csrf-cookie forwarding.
- TC-I-08 is a static-read assertion on global-setup.ts source (regex `E2E_AUTH_BYPASS:\s*'1'`) — load-bearing, not vacuous.
- REQ-13 covered by TC-I-08 (dedicated test file) AND TASK-6 wiring.
- assertNotProductionWithBypass extracted as pure function — testable without loading auth.ts module.

## Remaining gaps (reported to user)
- TC-E2E-01 selector `'h1, [data-testid*="manager"]'` uses `*=` substring match — too loose; can pass even if the real heading is absent.
- No TC for GET /csrf returning 200 without a `set-cookie` header (csrf cookie not forwarded). If implementation forwards the csrf cookie from the GET response to the POST, this path has no failure-mode TC.
- TC-I-04..07 (full HTTP round-trip against dev server): still DEFERRED to TASK-SMOKE; TASK-SMOKE is also DEFERRED (Docker daemon down). No runtime coverage for these TCs yet.
- `https://localhost:3232` (HTTPS scheme) correctly rejected by sign-in-as guard but via the same `http://localhost` prefix check that rejects `http://127.0.0.1`. No explicit TC for `http://127.0.0.1` — auto-rejected, but undocumented.
- TC-E2E-03/04 (regression anti-redirect-loop for migrated specs) also DEFERRED.

## Patterns validated
- DI via injected `fetch` + `AddCookiesFn` enables pure unit tests without Playwright runner.
- Hand-written stubs colocated (no vi.mock), typed (no any), beforeEach not needed (stateless stubs).
- isLocalhostHost exported and tested independently with it.each table (8 cases + null/undefined).
