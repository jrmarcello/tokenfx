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
- BCRYPT_COST=10 (not 12) is shared between seed-server.ts and redeem.ts via `lib/auth/bearer-auth.ts:BCRYPT_COST`. Cost choice was deliberate (saturate ingest hot path with cost 12 ~100ms).
- `/api/health` rejects "Authorization without key_id" with 400 (not 401) to prevent O(n) bcrypt-scan DoS.
- `/api/onboarding/clear-flash` is intentionally unauthenticated — the cookie is HMAC-signed + path-scoped so clearing it is harmless.
- Idempotency cache for createInvite is in-memory single-instance; spec calls this out as v1 limitation. If multi-replica ever happens, persistence is required.

Surprising/non-obvious findings worth carrying forward:
- The 401 byte-uniformity test (TC-I-49) does NOT explicitly assert Content-Length header equality, only response body bytes — relies implicitly on Next's auto-Content-Length being a function of body bytes.
- TC-U-21 byte-scans `formatSuccessMessage()` only — does not scan the orchestrator's stderr/stdout across error paths. The error-path scan is implicit (mapRedeemResponseToError never receives secret/key_id).
- mapRedeemResponseToError can include `centralUrl` in its output (line 154 — not a leak, but a privacy-in-logs note: an attacker who controls central_url could embed payload in error output).
- `flash-cookie.ts` falls back to empty-string secret in dev/test when AUTH_SECRET is unset — production is gated by auth.ts boot guard but flash-cookie.ts doesn't gate independently. Defense-in-depth opportunity.
