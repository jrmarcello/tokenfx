---
name: onboarding-followups-lowsev test-plan review
description: 2026-05-11 DRAFT review — IP truncation, health rate-limiter, flash-cookie boot guard, TC-I-71e refactor
type: project
---

## Status: DRAFT — reviewed 2026-05-11

## Findings summary

### MUST FIX
- TC-I-07 is vacuous: NODE_ENV='production' + both secrets unset hits auth.ts's EXISTING guard at line 23-30 before assertFlashSecretAvailable is ever called. TC proves nothing new about REQ-13. Add TC-I-07b: NODE_ENV='production' + AUTH_SECRET='x' (first guard passes) + NEXTAUTH_SECRET unset → assertFlashSecretAvailable does NOT throw (correct). And TC-I-07c: subprocess that loads flash-cookie.ts DIRECTLY (no auth.ts) with NODE_ENV='production' + both secrets unset → assertFlashSecretAvailable throws. These are the two paths that actually validate REQ-13.
- TC-I-06 / vi.useFakeTimers() scope not explicit in the Test Plan row — the spec says "advance time via fake-timer" but checkRateLimits reads Date.now() internally. The rate-limit module JSDoc confirms vi.useFakeTimers() covers Date.now(). The spec MUST add afterEach vi.useRealTimers() note in the TC or a test-setup note to prevent leakage to other TCs in the suite.
- TC-I-09 "pause main thread for 20ms" description is contradictory with the stated goal. The whole point of the refactor is to REMOVE timing dependency. The TC description should read: "set __hasCachedVerification before second call — no timing assertion needed". Current wording implies fake-timer + sleep, which re-introduces the very flake being fixed.

### SHOULD FIX
- No TC covering the NODE_ENV='production-staging' (or any non-'production' non-'development' non-'test' value) for assertFlashSecretAvailable. The fix-e2e-auth-bypass review flagged the same gap for assertNotProductionWithBypass — the allow-list inversion pattern should be consistent: only NODE_ENV==='production' (exact string) triggers the guard. A TC with NODE_ENV='production-staging' + no secrets → does NOT throw is cheap insurance.
- TC-I-01 is a grep/static assertion ("inspect 3 migrated files"). Static grep is brittle — it passes even if the import is unused or shadowed. Prefer a runtime TC: call truncateIpForAudit via the route handler under test and verify the shared implementation is hit (e.g., via __resetRateLimits as indirect tracer, or just assert no duplicate export names in the final module).
- _drilldown/render.tsx and health/route.ts have NO dedicated integration TCs for the tightening (TC-I-02/03 only cover redeem-invite). TC-I-03 shows 999.999.999.999 now stores NULL — but the health route had the LOOSEST prior behavior. A TC that calls GET /api/health with X-Forwarded-For: 999.999.999.999 and asserts the request is not rate-limited under a null key (i.e., truncateIpForAudit returned null → fallback key is used) would prove the health route migration is correct.

### NICE TO HAVE
- TC-U-15: '2001:db8:abcd' (3 segments, no ::) is listed as null because "precisa ter pelo menos um separador adicional". The Design section shows the implementation checks `ip.includes(':')` first, then `ip.startsWith('::')`, then splits on ':' and checks `head.length < 3`. For '2001:db8:abcd', split gives 3 segments with non-empty heads — the hex check passes. This would incorrectly RETURN '2001:db8:abcd::/48' not null. The TC expectation may be wrong; verify against the implementation.
- IPv6 `fe80::1` (link-local with zone) coverage: the '::' prefix check in Design only catches strings that START with '::'. fe80::1 does not start with '::', passes prefix check, splits to ['fe80', '', '1'] — head[1] is empty so head.some(h => h.length === 0) returns null. TC-U-11 covers mixed-case but not this `::`-in-the-middle case. Worth a NICE TO HAVE TC to document the boundary.

## REQ coverage check
REQ-1: TC-U-01/02/03 ✅
REQ-2: TC-U-04/05/06 ✅
REQ-3: TC-U-07/08/09 ✅
REQ-4: TC-U-10/11 ✅
REQ-5: TC-U-12/13 ✅
REQ-6: TC-U-14/15 ✅ (but TC-U-15 expected value may be wrong — see NICE TO HAVE)
REQ-7: TC-U-16/17/18/19/20 ✅
REQ-8: TC-I-01/02/03 ⚠️ health+drilldown callsites lack runtime regression TC
REQ-9: TC-I-04 ✅
REQ-10: TC-I-05/06 ✅ (fake-timer leak risk — MUST FIX)
REQ-11: TC-U-21/22 ✅; TC-I-07 ❌ vacuous
REQ-12: TC-U-23/24/25/26 ✅; production-staging gap ⚠️
REQ-13: TC-I-07/08 ❌ TC-I-07 vacuous; TC-I-08 tests no-throw but doesn't prove assertFlashSecretAvailable is called in auth.ts module scope
REQ-14: TC-I-09 ✅ (description wording contradictory — MUST FIX)
