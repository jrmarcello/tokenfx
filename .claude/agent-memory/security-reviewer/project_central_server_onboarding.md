---
name: central-server-onboarding security posture
description: Audit findings on the manager-issued invite-token onboarding flow + Bearer/bcrypt auth refactor (.specs/central-server-onboarding.md)
type: project
---

The central-server-onboarding spec was reviewed against its own 8-mitigation threat model + 13 additional checks.

**Why:** v0 of the central server stored `secret_hash` as plaintext (HMAC mode), and provisioning was via manual `seed-server.ts`. This spec ships invite-token onboarding + Bearer/bcrypt-at-rest in one entangled refactor — security review is load-bearing because every threat-model item lives in code, not docs.

**How to apply:**
- Treat `redeem-invite/route.ts` GENERIC_401_BODY/GENERIC_400_BODY/GENERIC_500_BODY as load-bearing constants — TC-I-49 byte-equality contract relies on JSON.stringify producing identical bytes for every rejection. Don't refactor those Object.freeze sites without re-running TC-I-49.
- `redeemInvite()` in `lib/queries/redeem.ts` writes the redemption-log row OUTSIDE the transaction on rejection paths, INSIDE on accepted — durability under rollback is intentional.
- The 60s bcrypt verification cache in `lib/auth/bearer-auth.ts` keeps PLAINTEXT in process memory by design. Trust boundary = process memory; this is documented.
- **Invite tokens are SHA-256 hashed at rest since `.specs/security-hardening-lowsev.md` (2026-07).** `onboarding_invites` PK is `token_hash` (sha256, NOT bcrypt — the token has 256-bit entropy and lookup needs indexed equality); a physical `token_prefix` column (first 8 of PLAINTEXT) is what UI/audit/JOINs correlate on. `redeem.ts` hashes the submitted token before `WHERE token_hash = ?`, so a DB dump is not replayable (submitting the stored hash re-hashes → miss → uniform 401). Do NOT re-flag "invite plaintext at rest" as open — it's closed. `left(token,8)` is gone; JOINs use `token_prefix = token_prefix` (`manager-alerts.ts`). Some doc-comments still say `left(token,8)` — stale, harmless.
- **`/api/manager/*` gate lives in `auth.config.ts` `authorized()`, not just the middleware matcher.** The matcher (`middleware.ts`) alone is a no-op: `authorized()` returns `true` for anything not starting with `/manager`, so `/api/*` (incl. `/api/manager`) needs its own branch (401 no-session / 403 wrong-role) placed BEFORE that permissive fallthrough. When reviewing a NEW `/api/manager` route, verify the branch still precedes the `return true`. `apps/server` runs Next 15.5.18 (past the CVE-2025-29927 `x-middleware-subrequest` bypass fix); root app is on a different major — check the server's own `node_modules/next` when the header-bypass matters.
- BCRYPT_COST=10 (not 12) is shared between seed-server.ts and redeem.ts via `lib/auth/bearer-auth.ts:BCRYPT_COST`. Cost choice was deliberate (saturate ingest hot path with cost 12 ~100ms).
- `/api/health` rejects "Authorization without key_id" with 400 (not 401) to prevent O(n) bcrypt-scan DoS.
- `/api/onboarding/clear-flash` is intentionally unauthenticated — the cookie is HMAC-signed + path-scoped so clearing it is harmless.
- Idempotency cache for createInvite is in-memory single-instance; spec calls this out as v1 limitation. If multi-replica ever happens, persistence is required.

Surprising/non-obvious findings worth carrying forward:
- The 401 byte-uniformity test (TC-I-49) does NOT explicitly assert Content-Length header equality, only response body bytes — relies implicitly on Next's auto-Content-Length being a function of body bytes.
- TC-U-21 byte-scans `formatSuccessMessage()` only — does not scan the orchestrator's stderr/stdout across error paths. The error-path scan is implicit (mapRedeemResponseToError never receives secret/key_id).
- mapRedeemResponseToError can include `centralUrl` in its output (line 154 — not a leak, but a privacy-in-logs note: an attacker who controls central_url could embed payload in error output).
- `flash-cookie.ts` falls back to empty-string secret in dev/test when AUTH_SECRET is unset — production is gated by auth.ts boot guard but flash-cookie.ts doesn't gate independently. Defense-in-depth opportunity.
