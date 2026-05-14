# Project Review — 2026-05-14

**Trigger:** `roadmap.md` → "Vamos rodar um full-review-team" (pre-release quality gate before full system smoke).
**Method:** `/review` (3 parallel agents: code-reviewer, security-reviewer, data-reviewer).
**Scope:** monorepo — root `tokenfx` (Next.js 15 dashboard), `apps/server` (central server / SSO), `apps/idp-stub` (local OIDC stub).
**Recent focus area:** SSO surface (Okta provider, NextAuth Credentials seam, nonce/replay, audit rows, e2e bypass, IdP stub).

---

## Executive Summary

| Category | Severity | Count |
| --- | --- | --- |
| Code | MUST FIX | 2 |
| Code | SHOULD FIX | 5 |
| Code | NICE TO HAVE | 5 |
| Security | CRITICAL | 0 |
| Security | HIGH | 3 |
| Security | MEDIUM | 5 |
| Security | LOW | 7 |
| Data | MUST FIX | 3 |
| Data | SHOULD FIX | 5 |
| Data | NICE TO HAVE | 3 |

**Top-line verdict:** no CRITICAL security finding, but there are 3 HIGH-severity security issues (two suffix-injection bugs + an unbounded JWT claim write) and **a data MUST FIX that blocks the smoke entirely** — `apps/server` migrations `0004` and `0005` are not registered in the Drizzle journal, so the SSO and manager-alert tables never apply in fresh DBs. **Fix that one first or the smoke will not even boot the SSO surface.**

---

## CRITICAL / MUST FIX (blocks the smoke or is exploitable)

### D-1 — `apps/server` migrations 0004 + 0005 invisible to the Drizzle migrator
**Data · MUST FIX**

[apps/server/lib/db/migrations/meta/_journal.json](apps/server/lib/db/migrations/meta/_journal.json) lists only `0000`–`0003`. Drizzle's `node-postgres` migrator iterates `journal.entries` exclusively. Missing from any fresh DB: `auth_event_log`, `manager_alert_acks`, `onboarding_invites.allowed_sso_providers`, `onboarding_redemption_log.{method,sso_provider,sso_subject_hash,iss,user_agent}`, `user_machines.provisioned_via`, 10 new `onboarding_outcome` enum values, and the composite-uniqueness swap on `users`. All DDL is idempotent (`IF NOT EXISTS` guards), so simply registering the entries is safe.

**Fix:** append the two missing entries to `_journal.json` with sequential `idx` and plausible `when` timestamps (full snippet in data-review section below).

---

### H1 — IdP stub `redirect_uri` accepts suffix-injected hosts
**Security · HIGH**

[apps/idp-stub/src/server.ts:46-49](apps/idp-stub/src/server.ts#L46-L49): validation is `uri.startsWith('http://localhost')` / `startsWith('http://127.0.0.1')`. `http://localhost.evil.com/cb` passes.

**Exploit:** a page in the developer's browser hits the local stub with a malicious `redirect_uri`, the stub 302s with `?code=...` to attacker, attacker POSTs `/token` and obtains a signed id_token.

**Fix:** parse with `new URL(uri)` and assert `hostname === 'localhost' || hostname === '127.0.0.1' || url.origin === baseUrl`. Mirror the pattern already in [apps/server/lib/auth/same-origin-get-guard.ts](apps/server/lib/auth/same-origin-get-guard.ts) (`tryUrlOrigin`).

---

### M4 — CSRF origin guard's `Referer` fallback is suffix-injectable
**Security · HIGH (escalated from MEDIUM — the central server is public-facing)**

[apps/server/lib/auth/csrf-origin-guard.ts:74](apps/server/lib/auth/csrf-origin-guard.ts#L74): `candidate.startsWith(baseUrl)` against the `Referer` header. With `baseUrl = https://app.tokenfx.io`, the Referer `https://app.tokenfx.io.evil.com/foo` passes.

**Exploit:** attacker controls (or registers) a sibling registrable domain and bypasses SSO-initiation CSRF guard.

**Fix:** match the `same-origin-get-guard.ts` pattern — parse both Origin and Referer via `new URL(...).origin` and use exact `===` equality against `baseUrl`.

---

### H2 — `extractIssuer` decodes id_token without local signature verification
**Security · HIGH (defense-in-depth)**

[apps/server/lib/auth/auth.ts:100-119](apps/server/lib/auth/auth.ts#L100-L119): base64-decodes the JWT payload and trusts the `iss` claim. The comment correctly states NextAuth verifies signatures upstream. If a future provider config slips into `authConfig.providers` that does NOT verify id_tokens (e.g. an OAuth2-only provider), an attacker forges any `iss` and the `issuerWhitelist` accepts it → full SSO impersonation.

**Fix:** add a boot-time canary asserting every provider in `authConfig.providers` is one of the explicitly OIDC-with-signature-verification classes (Okta, Google, the env-gated Credentials bypass). Refuse to boot otherwise unless `TOKENFX_ALLOW_UNVERIFIED_PROVIDERS=1`. Alternative: do a local `jose.jwtVerify` against JWKS inside `extractIssuer`.

---

### H3 — `iss` claim persisted unbounded
**Security · HIGH**

Same file, same function. `iss` flows into `writeAuthEvent` → `text('iss').notNull()` ([apps/server/lib/db/schema.ts:664](apps/server/lib/db/schema.ts#L664)). No length cap. A whitelisted (or future-whitelisted) tenant signing a 100KB+ `iss` produces multi-MB audit rows.

**Fix:** `payload.iss.slice(0, 512)` at extraction (mirror `truncateUserAgent`); future migration to `varchar(512)`.

---

### C-1 — Unsafe cast in NextAuth error logger
**Code · MUST FIX**

[apps/server/lib/auth/auth.ts:252](apps/server/lib/auth/auth.ts#L252): `(error as { type?: string })` widens an already-typed `Error`. The existing `isStateReplayAuthError` type guard already narrows correctly — use it first, fall back to `error.name`, eliminate the cast.

---

### C-2 — `console.*` in `apps/server/lib/db/migrate.ts`
**Code · MUST FIX**

[apps/server/lib/db/migrate.ts:15,19](apps/server/lib/db/migrate.ts#L15-L19): violates `ts-conventions.md` §Logging. CLI branch is fine to use `process.stdout.write` / `process.stderr.write`, or import the project logger.

---

## SHOULD FIX (correctness, performance, hygiene — non-blocking but address before merge to release)

### Data

- **D-2** — `turns.timestamp` lacks an index; five quota queries on the hot dashboard path do `SCAN turns`. Add `CREATE INDEX IF NOT EXISTS idx_turns_timestamp ON turns(timestamp);` in [lib/db/schema.sql](lib/db/schema.sql). (Re-classified as SHOULD FIX since current scale is 26K rows; will become MUST FIX as transcripts grow.)
- **D-3** — `sessions.ended_at` lacks an index; `runOutcomeSweep` in [lib/ingest/writer.ts](lib/ingest/writer.ts) does `SCAN s` on every ingest. Add `CREATE INDEX IF NOT EXISTS idx_sessions_ended_at ON sessions(ended_at);`.
- **D-4** — N+1 in `getPersonalEffectivenessAggregates` in [lib/queries/effectiveness-v2.ts:355](lib/queries/effectiveness-v2.ts#L355): ~7 `.get()` per session × 55 sessions = ~385 round-trips per render. Five of the seven metrics can collapse into one aggregate SQL.
- **D-5** — `selectCandidates` and 5 sibling functions in [lib/reporter/runner.ts](lib/reporter/runner.ts) call `db.prepare(...)` per invocation. Move to WeakMap-memoized `getPrepared(db)`. For statements with dynamic `IN (?,?,...)`, use the `json_each(?)` pattern already in [lib/queries/effectiveness.ts](lib/queries/effectiveness.ts).
- **D-6** — Correlated scalar subquery in `ROLLUP_ALL_SQL` ([lib/ingest/reconcile.ts:91-106](lib/ingest/reconcile.ts#L91-L106)). Replace `tool_call_count` subquery with a `LEFT JOIN tool_calls`.

### Security

- **M1** — `x-forwarded-for` trusted without proxy attestation across [apps/server/app/api/onboarding/redeem-invite/route.ts:102-113](apps/server/app/api/onboarding/redeem-invite/route.ts#L102-L113), `request-context-extract.ts:49-61`, `app/api/ingest/route.ts:387`, `app/api/health/route.ts:99`. Either gate XFF on `TOKENFX_TRUSTED_PROXY=1`, or document the trust boundary in `apps/server/SECURITY.md`.
- **M2** — `writeReplayAuditRowOnInvalidCheck` writes `ip=null, ua=null` silently when ALS context is empty. Use a distinct sentinel (`ip='no-context'`) so analysts can distinguish "no XFF" from "audit fired outside request scope".
- **M5** — Plaintext-secret cache in [apps/server/lib/auth/bearer-auth.ts:143-166](apps/server/lib/auth/bearer-auth.ts#L143-L166) creates a 60s stale-credential window post-rotation. Cache the bcrypt digest instead, or document the window.

### Code

- **C-3** — `switch (decision.kind)` in [apps/server/lib/auth/auth.ts:332](apps/server/lib/auth/auth.ts#L332) has no exhaustiveness guard. A future `SignInDecision` variant silently rejects login with no log line. Add `default: { const _exhaustive: never = decision.kind; void _exhaustive; return false; }`.
- **C-4** — 11 sites in `apps/server/lib/queries/*` copy-paste the Drizzle `tx.execute()` unwrap idiom. Lift to `apps/server/lib/db/exec.ts` as `extractExecRows<Row>(result: unknown): Row[]`. Two files already extract this — finish the job.
- **C-5** — `Exclude<AuthEventOutcome, never>` in [apps/server/lib/auth/sso-auto-provision.ts:407](apps/server/lib/auth/sso-auto-provision.ts#L407) is a no-op. Change to `Exclude<AuthEventOutcome, 'accepted-sso-auto'>` so passing an acceptance outcome to the rejection helper fails at compile time.
- **C-6** — Avoidable casts in [lib/ingest/transcript/parser.ts:181,183,245](lib/ingest/transcript/parser.ts#L181-L245). The `as string` on line 245 is dead after the typeof guard.
- **C-7** — `runOutcomeSweep` in [lib/ingest/writer.ts:558-564](lib/ingest/writer.ts#L558-L564) re-prepares both static SQL strings on every call. Hoist or WeakMap-cache.

---

## NICE TO HAVE

### Security (LOW)

- **L1** — Pin Auth.js cookie config explicitly in [apps/server/lib/auth/auth.config.ts](apps/server/lib/auth/auth.config.ts) instead of relying on v5 defaults.
- **L2** — `INTERNAL_CRON_SECRET` boot guard only fires on `NODE_ENV=production`; also gate `staging`.
- **L3** — Validate XFF as IP before bucketing the rate limiter (likely already handled by `truncateIpForAudit` — verify with a TC).
- **L5** — IdP stub does not validate `client_id` in `/authorize`. Add a TC.
- **L6** — IdP stub's `forceIssOverride` is unguarded — add a `NODE_ENV !== 'production'` boot guard to the stub binary in case it's ever bundled.
- **L7** — UA truncation applied at DB write but not at log lines. Inconsistent.

### Code

- C-8 — `LR` duplicate logger forwarding in NextAuth error hook.
- C-9 — Single `REDIRECT_URI_ALLOWED_PREFIXES` path in idp-stub. (Subsumed by H1 fix.)
- C-10 — `Result<T,E>` redefined inline in [apps/idp-stub/src/fixtures.ts:7-9](apps/idp-stub/src/fixtures.ts#L7-L9) instead of shared.
- C-11 — Skeleton `loading.tsx` files use index keys (acceptable but inconsistent).
- C-12 — `signIn` callback lacks explicit return type annotation.

### Data

- D-9 — Consider covering index on `sessions(started_at, id, project, total_cost_usd, turn_count)` at 10K+ sessions.
- D-10 — Document the ALTER-TABLE CHECK-constraint limitation in [lib/db/migrate.ts:222](lib/db/migrate.ts#L222).
- D-11 — Verify the ingest Zod schema explicitly rejects unknown `outcome_status` values.

---

## Reviewed and OK (audit trail)

The security reviewer explicitly cleared the following — keep doing what we're doing:

- **`search-hit.tsx` `dangerouslySetInnerHTML`** — input passes through `renderSnippet` which HTML-escapes everything and only re-introduces `<mark>` tags.
- **SQL injection across `apps/server/lib/queries/*`** — every site uses Drizzle parameter-bound `sql` or query-builder primitives. No concatenation.
- **Path traversal in root `tokenfx`** — `lib/fs-paths.ts:resolveWithinClaudeProjects` rejects `..` pre-normalization, realpaths both root + candidate, and prefix-checks with `path.sep`. Solid.
- **SSO state/PKCE/nonce checks** — `auth.config.ts:44` adds `'nonce'` to Okta's `['pkce', 'state']`. Auth.js v5 handles cookie lifecycle; `AUTH_SECRET` boot-gated.
- **`auth_event_log` privacy** — accepts only `emailHash` / `ssoSubjectHash` (peppered), rejects raw email/subject at the type level. Sentinels (`replay:state-mismatch`, `replay:unknown-issuer`) cannot collide with real hashes.
- **`e2e-bypass-provider` env gate** — `NODE_ENV in {test, development}` allowlist; boot guard at `auth.ts:188`; canary test locks the NextAuth contract.
- **`flash-cookie.ts`** — HMAC-SHA256, constant-time verify, httpOnly + secure + sameSite=strict + 120s TTL + path-scoped.
- **`bearer-auth.ts:parseBearerAuthorization`** — strict RFC 7235.
- **`redeem-invite/route.ts`** — uniform 401 body across all rejection kinds (anti-probing).
- **`gh` CLI invocation in `pr-lookup.ts`** — `shell: false`, argv array, hardcoded timeouts.
- **CSV export formula injection** — `audit-log/export/route.ts` passes every cell through `toCsvRow` (OWASP guard).
- **idp-stub `/admin/*` Origin guard** — `requireLoopbackOrigin` + JSON-only content type.
- **No hardcoded credentials** — `sk_`/`Bearer`/`AKIA`/`-----BEGIN` grep returned only test forbidden-substring fixtures.
- **No `postinstall` scripts** in any workspace `package.json`.

### Positive patterns to preserve (code + data)

- **Dependency injection in `sso-auto-provision.ts`** — `AutoProvisionDeps` + `depsPatch?: Partial<AutoProvisionDeps>`. Gold standard for the auth layer.
- **`AsyncLocalStorage`-based request context** ([apps/server/lib/auth/request-context.ts](apps/server/lib/auth/request-context.ts)) — clean, typed overloads, documented contract.
- **Discriminated `Result<T,E>` end-to-end** in both apps.
- **Privacy-preserving log discipline** — every auth-layer `logger.warn` logs `emailDomain(email)`, never raw.
- **WeakMap-cached prepared statements** in the ingestion writer.
- **All 4 SQLite PRAGMAs correct** — `foreign_keys=ON`, `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`.
- **Multi-statement writes always wrapped in `db.transaction(fn)`** — `writer.ts`, `reconcile.ts`.
- **CHECK constraints on every bounded text column** in `lib/db/schema.sql`.
- **Defensive DDL** — uniqueness swap on `users` in migration 0004 (add composite → add sso → drop old) inside one DO block; pre-flight `RAISE EXCEPTION` before the 180-day cap CHECK.
- **Idempotency consistent across both apps** — `IF NOT EXISTS` everywhere, `pg_constraint` checks before `ALTER`, `ON CONFLICT` in every SQLite write.
- **Reporter idempotency** — `payload_hash` + `pushed_at`, 50-session batch ceiling, batched `IN (...)` queries (not per-session).

---

## Recommended Action Plan (phases)

### Phase 1 — Unblock the smoke (do BEFORE the full system test)
1. **D-1** — register migrations 0004 + 0005 in `_journal.json`. **Without this, `apps/server` boots a half-empty schema.**
2. **H1** — fix `redirect_uri` validation in `apps/idp-stub/src/server.ts`. One-line URL-parse swap.
3. **M4** — fix `Referer` suffix injection in `csrf-origin-guard.ts`. Same pattern as H1.
4. **H3** — cap `extractIssuer` output at 512 chars.
5. **C-1**, **C-2** — clean up the unsafe cast + `console.*` in auth/migrate.

### Phase 2 — Defense in depth (this release window)
6. **H2** — add the provider-class canary test.
7. **C-3** — exhaustiveness guard on `SignInDecision` switch.
8. **D-2**, **D-3** — add the two missing indexes. Small change, real impact on the hot path.
9. **M1** — decide on the XFF trust model + document.
10. **M5** — fix the bcrypt cache rotation window or document.

### Phase 3 — Hygiene (next sprint, non-blocking)
- **D-4**, **D-5**, **D-6** — collapse N+1, memoize prepared statements, replace correlated subquery.
- **C-4**, **C-5**, **C-6**, **C-7** — code consolidation.
- All LOW / NICE TO HAVE items.

---

## Notes for the smoke test (per roadmap.md)

After Phase 1 lands, the smoke needs to verify:

- **Duplicate-session check:** ingest the same JSONL twice; assert `(session_id, source_file)` uniqueness holds and `runOutcomeSweep` does not double-write.
- **Dashboard numerics:** load both `tokenfx` dashboard and `apps/server` admin pages; spot-check at least one metric per surface against raw SQL.
- **Cross-app integration:** trigger the reporter end-to-end and verify rows land in `apps/server` with consistent `session_id` typing.
- **SSO happy path AND replay-rejection path:** the latter MUST write an `auth_event_log` row with the `replay:state-mismatch` sentinel — direct evidence the recent SSO work is wired correctly through migration 0004.
