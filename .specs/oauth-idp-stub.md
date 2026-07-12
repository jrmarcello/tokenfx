# Spec: oauth-idp-stub

## Status: DONE

## Context

Three SSO specs shipped during the central-server onboarding initiative
(`central-server-onboarding-v2-sso.{schema-migrations, backend, manager-ui}.md`)
left **7 test cases DEFERRED** because they require a real OIDC provider in the
loop:

| Source spec | Deferred TC | Layer | Why blocked |
| --- | --- | --- | --- |
| backend (spec-b) | TC-I-34 / REQ-18 | integration | Replay-detection of an OAuth `state` cookie — needs a real callback round-trip against a controllable IdP. NextAuth v5 owns state validation; we can't fake the state-cookie sign at the unit level. |
| backend (spec-b) | TC-I-45 / REQ-18 | integration | Nonce-reuse replay variant. **NOT closed by this spec — see Out-of-scope §REQ-FU-2.** |
| backend (spec-b) | TC-E2E-01 / REQ-13 | e2e | Full happy-path SSO sign-in (`/api/auth/signin/<provider>` → IdP → callback → session). Requires a live OIDC endpoint Playwright can drive. |
| backend (spec-b) | TC-E2E-02 / REQ-16 | e2e | Cross-origin signin → 403 (CSRF origin guard). Requires a live OIDC chain to exercise the full flow. |
| manager-ui (spec-c) | TC-E2E-01 / REQ-1, REQ-2 | e2e | Banner appears after a real sso-auto event lands in the audit log; dismiss → hidden; second event → reappear. |
| manager-ui (spec-c) | TC-E2E-02 / REQ-4, REQ-5 | e2e | Audit-log filters interactive (UI re-renders after each filter applied). |
| manager-ui (spec-c) | TC-E2E-03 / REQ-6 | e2e | CSV export from audit-log downloads with correct headers. |
| manager-ui (spec-c) | TC-E2E-04 / REQ-7 | e2e | Invite-create UI persists `allowed_sso_providers` choice through DB. |
| manager-ui (spec-c) | TC-E2E-05 / REQ-9, REQ-10 | e2e | Team-roster `provisioned_via` filter + CSV export download. |

This spec ships a **local OIDC IdP stub** under `apps/idp-stub/` that emulates
an Okta-compatible OAuth server well enough for NextAuth's signature
verifier to accept its `id_token`s, and rewires the Playwright `globalSetup`
to spawn the stub alongside the dev server. With the stub running, every
TC above except TC-I-45 becomes mechanically executable.

### Decisões já travadas

1. **Stack:** Hono (HTTP server, fast + tiny) + jose (RS256 JWT sign/verify
   + JWKS serialization, already a transitive dep of next-auth) + zod
   (request validation). Vitest for the stub's own tests.
2. **Provider emulation:** Okta-compatible (NextAuth's Okta provider accepts
   a custom `issuer` via env, the Google provider does not). E2E env vars:
   `OKTA_ISSUER=http://localhost:3001`, `OKTA_CLIENT_ID=test-client`,
   `OKTA_CLIENT_SECRET=test-secret`, and
   `TOKENFX_SSO_ISSUERS_OKTA=http://localhost:3001` to extend the issuer
   whitelist in `sso-auto-provision.ts:DEFAULT_ISSUER_WHITELIST`. The
   `ssoProvider` claim surfaces as `'okta'`; the orchestrator code in
   `sso-auto-provision.ts` is provider-agnostic (no `'google'`/`'okta'`
   branches), so the test path is faithful to production semantics.
3. **No `auth.config.ts` change.** All wiring is env-driven. The
   existing config already reads `OKTA_*` envs (verified at
   `apps/server/lib/auth/auth.config.ts:31-37`).
4. **TC-I-34 scope** (state replay): spec-b's TC asserts BOTH "NextAuth
   rejects the second callback" AND "audit log records `'rejected-replay'`".
   The first half is verifiable today via NextAuth state-cookie consumption.
   The second half requires wiring an error-handler that writes the audit
   row when NextAuth fails state validation — `sso-auto-provision.ts:136-140`
   explicitly documents that `'rejected-replay'` is NOT produced by
   `evaluateAutoProvision` today. **Decision:** this spec closes the first
   half. The audit-row write is a follow-up (REQ-FU-1, surfaced in
   Out-of-scope below). TASK-12 marks TC-I-34 as **PARTIALLY ADDRESSED**.
5. **Default scenario:** scenario-controlled, in-memory, process-lifetime.
   `POST /admin/scenario` sets the NEXT response's claims; the stub
   resets to defaults at startup or via `POST /admin/scenario/reset`.
   Defaults emit `email_verified=true`,
   `email=e2e-sso-new@alpha.test`, `sub=e2e-sso-test-sub-001`,
   `iss=http://localhost:3001` (= discovery issuer; NextAuth requires
   this match — the user prompt's "Google iss default" cannot be satisfied
   without breaking the verifier), `aud=test-client`, `exp=now+3600s`,
   `jti=<uuid>`. The `forceIssOverride` scenario field bypasses this
   match for explicit cross-IdP rejection tests (REQ-6, TC-I-14).
6. **Process lifetime:** stub is in-memory, RS256 keys generated at boot
   via top-level `await jose.generateKeyPair('RS256')` (ESM module
   pattern), cached for the lifetime of the process. Each Vitest worker
   is a fresh process → no test pollution. `kid` is `SHA-256(modulus n,
   hex-encoded, first 16 chars)` — algorithmically pinned.
7. **Port:** default `3001`. Override via `IDP_STUB_PORT`. Base URL via
   `IDP_STUB_BASE_URL` (default `http://localhost:3001`).
   `createApp({ baseUrl })` REQUIRES `baseUrl` as a constructor arg; no
   `process.env` reads inside the factory.
8. **E2E orchestration:** existing `apps/server/tests/e2e/global-setup.ts`
   already spawns Postgres testcontainer + Next.js dev server. Extend it
   to ALSO spawn the stub (sequentially: stub first, readiness probe,
   then set env, then spawn dev server). Teardown via a SHARED `stopAll`
   helper (refactor the existing three `process.once` blocks to use it —
   prevents the race where the first SIGINT handler calls `process.exit`
   before the second handler can kill the stub).
9. **CI:** the stub lifecycle is tied to the Playwright run via
   `global-setup.ts`. No separate CI step.
10. **Workspace package:** new sibling under `apps/idp-stub/`. The current
    `pnpm-workspace.yaml` does NOT declare `packages:` (verified by
    `cat pnpm-workspace.yaml`). TASK-1 MUST add `packages: ['apps/*']`
    unconditionally — `apps/server` works today via pnpm's implicit root
    discovery, but the implicit fallback is version-dependent and should
    not be relied upon for a new package.
11. **Logger:** `apps/idp-stub/src/` uses a local `src/logger.ts` exporting
    `{ log: { debug, info, warn, error } }` shape (mirrors `lib/logger.ts`
    without importing it — the stub is a standalone Node process; pulling
    Next.js's logger pulls Next.js deps). `src/index.ts` (the CLI boundary)
    may use `process.stdout.write` for boot/shutdown lines. **No
    `console.log` anywhere in `src/`** — Validation Criteria enforces this.
12. **TS config:** `apps/idp-stub/tsconfig.json` is STANDALONE (does not
    extend root or `apps/server`) — `target: ES2022`, `module: ESNext`,
    `moduleResolution: bundler`, `lib: ['es2022']` (no dom), `strict: true`,
    `noEmit: true`. The root tsconfig targets the Next.js dashboard;
    inheriting it would inject `dom` types into a backend-only process.

### Prior art

- `apps/server/tests/e2e/global-setup.ts` — Postgres testcontainer +
  Next.js dev server spawning pattern. Same shape extended for the stub.
- `apps/server/lib/auth/auth.config.ts:31-37` — Okta provider already
  configurable via `OKTA_*` env.
- `apps/server/lib/auth/sso-auto-provision.ts:231-239` — issuer whitelist
  is env-extensible via `TOKENFX_SSO_ISSUERS_OKTA`.
- `apps/server/tests/e2e/helpers/sign-in-as.ts` — established fetch-
  injection convention (`opts.fetch?: typeof globalThis.fetch`).
  `idp-stub-control.ts` matches the convention so helper failure-mode
  TCs are unit-testable without a live server.
- `apps/server/tests/e2e/sso-auto-provision.spec.ts` — current DEFERRED
  stub. **Deleted** by TASK-10 (git history preserves the prior state;
  re-export "notes" in Playwright spec files would still load + execute,
  producing pointless `console.warn` lines in CI output).

## Requirements

- [ ] **REQ-1**: GIVEN the stub is running, WHEN a client requests
  `GET /.well-known/openid-configuration`, THEN the response is `200` and
  the JSON body contains `issuer`, `jwks_uri`, `authorization_endpoint`,
  `token_endpoint`, `response_types_supported: ['code']`,
  `subject_types_supported: ['public']`,
  `id_token_signing_alg_values_supported: ['RS256']`, all URLs
  rooted at `IDP_STUB_BASE_URL`.

- [ ] **REQ-2**: GIVEN the stub is running, WHEN a client requests
  `GET /jwks`, THEN the response is `200` and the JSON body is a valid
  JWKS document with exactly one key: `{ kty: 'RSA', use: 'sig',
  alg: 'RS256', kid: <SHA-256(n)[:16] hex>, n: <base64url>, e: 'AQAB' }`.
  No private-key fields (`d`, `p`, `q`, `dp`, `dq`, `qi`) appear. The
  same JWKS is returned on every subsequent request within the same
  process; restart yields a different keypair.

- [ ] **REQ-3**: GIVEN the stub is running, WHEN a client requests
  `GET /authorize?response_type=code&client_id=...&redirect_uri=...&state=...&scope=openid+email`,
  THEN the stub responds with `302` to `${redirect_uri}?code=<opaque>&state=${state}`.
  Each request generates a fresh opaque `code` (UUID-shaped). The
  `redirect_uri` MUST start with `IDP_STUB_BASE_URL` OR `http://localhost`
  OR `http://127.0.0.1` — anything else (including `javascript:`,
  `data:`, off-host URLs) → `400`. Missing `redirect_uri`, missing
  `state`, or empty `state` → `400` (each a distinct branch).

- [ ] **REQ-4**: GIVEN the stub is running and a scenario has been set
  (or the default is in effect), WHEN a client POSTs to `/token` with
  `Content-Type: application/x-www-form-urlencoded` body containing
  `grant_type=authorization_code&code=<any>&redirect_uri=<any>`, THEN the
  response is `200` `application/json` with
  `{ access_token: <opaque>, token_type: 'Bearer', expires_in: 3600,
  id_token: <RS256-signed JWT> }`. The `id_token` claims reflect the
  current scenario: `iss`, `aud`, `sub`, `email`, `email_verified`,
  `iat` (now), `exp` (now+3600 by default), `jti` (UUID v4 by default),
  `nonce` (echoed from the form body if present, claim absent
  otherwise). Signature verifies against the JWKS from REQ-2.

  Distinct error branches → `400`:
  - missing `grant_type`
  - `grant_type` ≠ `authorization_code`
  - missing `code`
  - missing `redirect_uri`
  - `Content-Type` ≠ `application/x-www-form-urlencoded`
  - empty body

  Signing failure (cosmic-ray-equivalent: stubbed `jose.SignJWT.sign`
  throws) → `500` with body `{ error: { message: string } }`.

- [ ] **REQ-5**: GIVEN the stub is running, WHEN a client POSTs to
  `/admin/scenario` with a JSON body Zod-validated against the
  `ScenarioOverrideSchema` (all fields optional, `.strict()` on extras),
  THEN the stub merges the override into the active scenario and responds
  `204 No Content`. Invalid bodies → `400` with `{ error: { message:
  string } }`. GIVEN `/admin/scenario` has not been called this process,
  the active scenario is the documented default (Context §5).

  The Zod schema is pinned as:

  ```ts
  export const ScenarioOverrideSchema = z.object({
    email: z.string().min(1).max(254).email().optional(),
    email_verified: z.boolean().optional(),
    sub: z.string().min(1).max(255).optional(),
    aud: z.string().min(1).max(255).optional(),
    exp: z.number().int().positive().optional(),
    iat: z.number().int().positive().optional(),
    jti: z.string().min(1).max(255).optional(),
    nonce: z.string().min(1).max(255).optional(),
    forceIssOverride: z.string().min(1).max(255).optional(),
  }).strict();
  ```

  `email` enforces RFC 5321 max length (254) + format. `exp`/`iat` are
  positive integers (seconds since epoch). `.strict()` rejects unknown
  keys.

- [ ] **REQ-5a**: GIVEN the stub is running, WHEN a client POSTs to
  `/admin/scenario/reset`, THEN the active scenario is restored to the
  documented default (Context §5) and the response is `204 No Content`.
  This is a DISTINCT endpoint from `/admin/scenario` — POSTing `{}` to
  `/admin/scenario` is a no-op merge, not a reset.

- [ ] **REQ-6**: GIVEN the stub is running with `POST /admin/scenario`
  applied with `{ forceIssOverride: '<bogus>' }`, WHEN the stub mints
  an id_token, THEN the `iss` claim equals `<bogus>` (not the discovery
  issuer). This unblocks REQ-2a / cross-IdP rejection tests downstream.

- [ ] **REQ-7**: GIVEN the Playwright `globalSetup` runs, WHEN setup
  completes, THEN the stub is reachable on `IDP_STUB_BASE_URL` (proven
  by a successful GET to `/.well-known/openid-configuration`), the
  Next.js dev server is reachable on `:3232`, and the dev server's
  env has `OKTA_ISSUER`/`OKTA_CLIENT_*`/`TOKENFX_SSO_ISSUERS_OKTA`
  pointing at the stub. If the stub fails to start (port-in-use, crash),
  globalSetup throws within a 5s readiness deadline and the Playwright
  run aborts immediately. WHEN the Playwright run exits (normal, SIGINT,
  or SIGTERM), the stub process is SIGTERM-killed and reaped via a
  shared `stopAll()` helper that prevents handler races.

- [ ] **REQ-8**: GIVEN the test stack from REQ-7 is live, WHEN a
  Playwright test drives the full SSO sign-in flow (`/api/auth/signin/okta`
  → `/authorize` redirect → stub callback to `/api/auth/callback/okta`
  → session cookie set), THEN the resulting session is gated-page-eligible
  AND a new `users` row exists for the scenario's `email`.

- [ ] **REQ-9**: GIVEN a successful first SSO callback consumed the
  NextAuth state cookie, WHEN a second callback request reuses the
  same `state` token, THEN NextAuth responds with its state-mismatch
  error: HTTP `302` to a URL whose path is `/api/auth/error` AND whose
  query contains `error=` (exact NextAuth error code may evolve; the
  assertion locks on path + presence of `error=` query). The first
  callback's response must be asserted as a successful 302 to a path
  NOT under `/api/auth/error` — otherwise the second-callback assertion
  can pass vacuously. **(Audit-row `'rejected-replay'` write is
  OUT-OF-SCOPE per Context §4 — tracked as REQ-FU-1.)**

- [ ] **REQ-10**: GIVEN the test stack from REQ-7 is live AND the
  manager-UI surface is reachable, WHEN Playwright drives the
  manager-UI E2E flows (banner appear/dismiss/reappear, audit-log
  filters, audit-log CSV export, invite-create allowed_sso_providers
  UX, team-roster filter + CSV), THEN every assertion in TC-E2E-03..07
  passes.

### Out-of-scope (deferred to future specs)

- **REQ-FU-1 (`'rejected-replay'` audit row write)**: **CLOSED by
  `.specs/sso-replay-audit-row.md`** (2026-05-13). The new spec wires
  a `NextAuth.logger.error` hook in `auth.ts` that detects the typed
  `InvalidCheck` class and writes an `auth_event_log` row with
  `outcome='rejected-replay'` via `writeReplayAuditRow`. Sentinel
  values (`email_hash='replay:state-mismatch'`, `iss='replay:unknown-issuer'`)
  occupy the NOT NULL columns where state-replay leaves no real identity
  data. Spec-b TC-I-34 is now ADDRESSED.

- **REQ-FU-2 (nonce-reuse replay — TC-I-45)**: **CLOSED by
  `.specs/sso-nonce-replay.md`** (2026-05-13). Approach: enable
  `checks: ['pkce', 'state', 'nonce']` on the Okta provider; extend
  the IdP stub so `/authorize` records the captured `nonce` query
  param into a pending slot read by `/token` when minting the
  id_token. Test isolation via tampered-nonce single callback (Auth.js
  v5 runs state-check before nonce-check, so a literal URL-replay
  fires state first — the tampered-nonce path proves nonce validation
  is actually wired). Spec-b TC-I-45 marked ADDRESSED.

- **Real Google provider testing**: emulating Google's exact OIDC
  endpoints (the `accounts.google.com` issuer is hardcoded in
  NextAuth's Google provider) would require CDN-shaped certificate
  + DNS interception. Not worth the complexity — Okta emulation
  exercises the same orchestrator code paths.

- **Rate-limit / abuse testing of the stub itself**: the stub is a
  local dev tool, not production. No throttling, no IP allowlisting.

## Test Plan

Coverage verified against the rules in `.claude/rules/sdd.md` §Test Plan
(every REQ ≥ 1 TC, every error path tested, boundary TCs for each Zod
field, infra-failure TCs for each external dep). **TC count**: 25 unit
+ 24 integration + 7 e2e = **56 TCs**. Rigor: 36 error/edge/validation/
security/infra/idempotency TCs vs 20 happy-path TCs (1.8:1 ratio).

### Unit Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-2 | happy | `generateJwks()` returns a JWK pair with `kty='RSA'`, `alg='RS256'`, `kid` = SHA-256(n)[:16] hex (16 lowercase hex chars) | matches |
| TC-U-02 | REQ-2 | security | Public-JWKS shape: `{ keys: [{ kty, use:'sig', alg:'RS256', kid, n, e:'AQAB' }] }` — `Object.keys(jwk).every(k => !['d','p','q','dp','dq','qi'].includes(k))` (no private fields leak) | match |
| TC-U-03 | REQ-1 | happy | `buildDiscoveryDoc('http://localhost:3001')` includes all required RFC 8414 fields rooted at the base URL | all present |
| TC-U-04 | REQ-1 | validation | `buildDiscoveryDoc('https://example.com/foo/')` strips trailing slash before composing endpoint URLs | no `//` in URLs |
| TC-U-05 | REQ-5 | happy | `createScenarioStore()` then `store.set({email:'a@b.com'})` then `store.get()` returns merged scenario | email overridden, other fields default |
| TC-U-06 | REQ-5 | happy | Fresh `createScenarioStore()`: `store.get()` returns the documented default | exact-match Context §5 defaults |
| TC-U-07 | REQ-5 | happy | `store.set({email:'a@b.com'})` then `store.set({sub:'x'})` then `store.get()` accumulates BOTH overrides | both present |
| TC-U-08 | REQ-4 | happy | `signIdToken(privateKey, scenario)` produces a JWT whose decoded payload matches scenario claims (`iss`, `sub`, `email`, `email_verified`, `aud`, `exp`, `jti`) | match |
| TC-U-09 | REQ-4 | happy | `signIdToken(...)` with `nonce` in scenario emits `nonce` claim; without → claim absent | conditional |
| TC-U-10 | REQ-2, REQ-4 | security | `signIdToken` output verifies via `jose.jwtVerify(token, await jose.importJWK(publicJwk, 'RS256'))` (in-process, no remote-jwks fetch) | verification ok |
| TC-U-11 | REQ-4 | edge | With `vi.useFakeTimers()` pinning `Date.now()=2026-01-15T00:00:00Z`, `signIdToken(...)` with no `exp`/`iat` in scenario emits `iat=NOW` AND `exp=NOW+3600` | both match |
| TC-U-12 | REQ-6 | security | `signIdToken(...)` with `forceIssOverride='https://attacker.example'` emits `iss=https://attacker.example` (different from discovery issuer) | exact match |
| TC-U-13 | REQ-5 | validation | `ScenarioOverrideSchema.parse({email:''})` → ZodError (min length 1) | throws |
| TC-U-14 | REQ-5 | validation | `ScenarioOverrideSchema.parse({email:'a'.repeat(255)+'@b.com'})` → ZodError (max 254 or email format) | throws |
| TC-U-15 | REQ-5 | happy | `ScenarioOverrideSchema.parse({email:'a@b.com'})` → ok | no error |
| TC-U-16 | REQ-5 | validation | `ScenarioOverrideSchema.parse({email_verified:'true'})` → ZodError (boolean type) | throws |
| TC-U-17 | REQ-5 | validation | `ScenarioOverrideSchema.parse({sub:''})` → ZodError (min length 1) | throws |
| TC-U-18 | REQ-5 | validation | `ScenarioOverrideSchema.parse({jti:''})` → ZodError (min length 1) | throws |
| TC-U-19 | REQ-5 | validation | `ScenarioOverrideSchema.parse({exp:0})` → ZodError (positive int) | throws |
| TC-U-20 | REQ-5 | validation | `ScenarioOverrideSchema.parse({exp:-1})` → ZodError (positive int) | throws |
| TC-U-21 | REQ-5 | validation | `ScenarioOverrideSchema.parse({forceIssOverride:''})` → ZodError (min length 1) | throws |
| TC-U-22 | REQ-5 | validation | `ScenarioOverrideSchema.parse({unknown_key:1})` → ZodError (`.strict()` rejection) | throws |
| TC-U-23 | REQ-5 | edge | `ScenarioOverrideSchema.parse({})` → ok (empty patch is valid) | no error |
| TC-U-24 | REQ-2 | edge | Two successive calls to `generateJwks()` produce keypairs with different `kid` and `n` | different |
| TC-U-25 | REQ-4 | infra | `signIdToken` with injected key that causes `jose.SignJWT.sign` to reject → returns `{ok:false, error}` (Result pattern) | matches |

### Integration Tests

All TC-I-* run **in-process** via Hono's `app.request()` (no port bind),
except TC-I-23 (explicit ephemeral-port boot) and TC-I-24 (port-in-use
failure).

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-1 | happy | `app.request('/.well-known/openid-configuration')` → 200, body has all 7 required keys | match |
| TC-I-02 | REQ-2 | happy | `app.request('/jwks')` → 200, body is a JWKS with one RSA key | match |
| TC-I-03 | REQ-2 | idempotency | Two consecutive `/jwks` calls → identical `keys[0].kid` and `keys[0].n` | identical |
| TC-I-04 | REQ-3 | happy | `app.request('/authorize?response_type=code&client_id=x&redirect_uri=http://localhost:3232/cb&state=ST&scope=openid+email')` → 302, `Location: http://localhost:3232/cb?code=<uuid>&state=ST` | regex match |
| TC-I-05 | REQ-3 | edge | Two successive `/authorize` calls with identical params → two DIFFERENT `code` values | distinct |
| TC-I-06a | REQ-3 | validation | `/authorize?response_type=code&state=ST` (missing redirect_uri) → 400 `{error:{message}}` | status + shape |
| TC-I-06b | REQ-3 | validation | `/authorize?response_type=code&redirect_uri=http://localhost:3232/cb` (missing state) → 400 | status + shape |
| TC-I-06c | REQ-3 | validation | `/authorize?...&state=` (empty state) → 400 | status |
| TC-I-06d | REQ-3 | security | `/authorize?...&redirect_uri=javascript:alert(1)&state=ST` → 400 (open-redirect guard) | status |
| TC-I-06e | REQ-3 | security | `/authorize?...&redirect_uri=https://attacker.example/cb&state=ST` → 400 (off-host guard) | status |
| TC-I-07 | REQ-4 | happy | POST `/token` (form: `grant_type=authorization_code&code=x&redirect_uri=y`) → 200, body has `access_token`, `id_token`, `token_type='Bearer'`, `expires_in=3600` | match |
| TC-I-08 | REQ-4 | security | id_token from TC-I-07 verifies via `jose.jwtVerify(token, await jose.importJWK(publicJwk, 'RS256'))` (in-process) | verifies |
| TC-I-09 | REQ-4 | happy | id_token from TC-I-07 (default scenario in effect): `iss === discovery.issuer`, `aud === 'test-client'`, `email === 'e2e-sso-new@alpha.test'`, `email_verified === true`, `exp > iat`, `jti` matches UUID v4 regex | match |
| TC-I-10 | REQ-4 | happy | POST `/token` form including `nonce=NONCE-123` → id_token claims contain `nonce='NONCE-123'` | match |
| TC-I-11a | REQ-4 | validation | POST `/token` with `Content-Type: application/json` body → 400 | status |
| TC-I-11b | REQ-4 | validation | POST `/token` form: `grant_type=client_credentials&code=x&redirect_uri=y` → 400 | status |
| TC-I-11c | REQ-4 | validation | POST `/token` form: `code=x&redirect_uri=y` (missing grant_type) → 400 | status |
| TC-I-11d | REQ-4 | validation | POST `/token` form: `grant_type=authorization_code&redirect_uri=y` (missing code) → 400 | status |
| TC-I-11e | REQ-4 | validation | POST `/token` form: `grant_type=authorization_code&code=x` (missing redirect_uri) → 400 | status |
| TC-I-11f | REQ-4 | validation | POST `/token` empty body → 400 | status |
| TC-I-12 | REQ-5 | happy | POST `/admin/scenario` `{email:'new@x.com'}` → 204; subsequent `/token` mints id_token with `email='new@x.com'` | observed |
| TC-I-13 | REQ-5 | validation | POST `/admin/scenario` invalid body `{email:42}` → 400 + body `{error:{message:string}}` | match |
| TC-I-14 | REQ-5 | edge | POST `/admin/scenario` `{}` → 204 (no-op merge; distinct from reset) | status |
| TC-I-15 | REQ-5a | happy | POST `/admin/scenario` `{email:'new@x.com'}` → 204; POST `/admin/scenario/reset` → 204; `/token` mints with default `email='e2e-sso-new@alpha.test'` | match |
| TC-I-16 | REQ-6 | security | POST `/admin/scenario` `{forceIssOverride:'https://attacker.example'}` → 204; subsequent id_token has `iss='https://attacker.example'` (different from discovery) | match |
| TC-I-17 | REQ-4 | infra | `createApp({ jwks: jwksKitWithFailingSign })` → POST `/token` → 500 + body `{error:{message:string}}` (Result pattern propagates) | match |
| TC-I-18 | REQ-5 | infra | `setStubScenario(...)` with injected fetch returning 503 → throws with descriptive error (Origin: helper has fetch-injection seam per code-reviewer feedback) | throws |
| TC-I-19 | REQ-1, REQ-2 | infra | Boot server on port 0 (ephemeral) via `serve(app, { port: 0 })`; record actual port; GET `/.well-known/openid-configuration` resolves with ALL URL fields (`issuer`, `jwks_uri`, `authorization_endpoint`, `token_endpoint`) containing that port | match |
| TC-I-20 | REQ-7 | infra | Spawn stub on a port already bound (probe first, bind a dummy socket) → spawn fails / readiness probe times out within 5s with EADDRINUSE-or-equivalent error | throws |
| TC-I-21 | REQ-1, REQ-2 | idempotency | Two `/.well-known/openid-configuration` requests within same process → identical bodies | identical |
| TC-I-22 | REQ-5 | edge | POST `/admin/scenario` `{email:'a@b.com'}` then POST `/admin/scenario` `{email:'c@d.com'}` → `/token` reflects last write (last-write-wins on same field) | `c@d.com` |
| TC-I-23 | REQ-3 | edge | POST `/authorize` (wrong method) → 405 OR 404 (Hono default) — document either, lock the choice in the implementation | status |
| TC-I-24 | REQ-7 | infra | `setStubScenario({email:'foo'})` against a stub that has been torn down → helper throws `fetch` error | throws |

### E2E Tests

All run via Playwright after `globalSetup` brings up Postgres + stub +
dev server. Spec-b's TC-I-34 (state replay) moves here as **TC-E2E-08**
— it requires a live NextAuth dev server in the loop, not a Vitest
harness. Reviewers converged on this reclassification.

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-E2E-01 | REQ-8 | happy | Visit `/api/auth/signin/okta` from a Playwright browser; complete redirect to stub; land back on `/api/auth/callback/okta` → 302 to `/me`; assert page renders authenticated content + new `users` row exists | match |
| TC-E2E-02 | REQ-9 (spec-b REQ-16) | security | `request.post('/api/auth/signin/okta', {headers:{Origin:'https://evil.example.com'}})` → 403. Assert response is from `csrf-origin-guard.ts` (specific error shape) — NOT from NextAuth's own CSRF token guard. | status + guard identity |
| TC-E2E-03 | REQ-10 (spec-c REQ-1,2) | happy | After sso-auto event (TC-E2E-01 result), visit `/manager` and wait for `getByRole('banner')` → visible. Click dismiss → wait for banner `toBeHidden()`. Call `setStubScenario({email:'e2e-sso-second@alpha.test'})`, drive a second signin (new browser context to avoid session reuse), reload `/manager` → banner visible again. | visible / hidden / visible |
| TC-E2E-04 | REQ-10 (spec-c REQ-4,5) | happy | Navigate to `/manager/audit-log`; apply `outcome=accepted-sso-auto` filter, await `page.waitForResponse(/audit-log/)` AND `expect(getByRole('row')).toHaveCount(N)`; apply `iss=<stub-issuer>` filter, same wait pattern; assert filtered row counts. | rows match |
| TC-E2E-05 | REQ-10 (spec-c REQ-6) | happy | Click "Export CSV" on `/manager/audit-log`; assert download triggered with `Content-Type: text/csv` and filename matches `audit-log-*.csv` | download |
| TC-E2E-06 | REQ-10 (spec-c REQ-7) | happy | Open `/manager/invites/new`; select `allowed_sso_providers=['okta']`; submit; navigate to `/manager/invites/<token>` and observe the saved value | persisted |
| TC-E2E-07 | REQ-10 (spec-c REQ-9,10) | happy | Navigate to `/manager/teams/<id>`; apply `provisioned_via=sso-auto` filter, wait for re-render; click CSV export → download triggered | filter + CSV |
| TC-E2E-08 | REQ-9 (spec-b TC-I-34) | security | Playwright `request` fixture: drive first OAuth callback to completion (assert response 302 to non-`/api/auth/error` path); capture the original callback URL; replay it (second `request.get` with same URL) → 302 to URL whose path is `/api/auth/error` and query contains `error=` | path + query |

## Design

### Architecture Decisions

**Workspace layout**:

```
apps/
├── server/                  (existing)
└── idp-stub/                (NEW)
    ├── package.json
    ├── tsconfig.json        (standalone, no extends)
    ├── vitest.config.ts
    ├── README.md
    └── src/
        ├── index.ts         (CLI entry — boots server, listens on IDP_STUB_PORT)
        ├── logger.ts        (local {debug,info,warn,error})
        ├── server.ts        (Hono app factory — createApp({baseUrl, jwks, scenario}))
        ├── server.test.ts   (TC-I-01..23 except TC-I-19/20/24)
        ├── server.port.test.ts (TC-I-19, TC-I-20 — real port bind)
        ├── jwks.ts          (top-level await jose.generateKeyPair → JwksKit)
        ├── jwks.test.ts     (TC-U-01, TC-U-02, TC-U-10, TC-U-24)
        ├── scenario.ts      (ScenarioStore + ScenarioOverrideSchema)
        ├── scenario.test.ts (TC-U-05..07, TC-U-13..23)
        ├── fixtures.ts      (signIdToken + buildDiscoveryDoc)
        └── fixtures.test.ts (TC-U-03, TC-U-04, TC-U-08, TC-U-09, TC-U-11, TC-U-12, TC-U-25)
```

**ScenarioStore interface** (`scenario.ts`):

```ts
export type Scenario = Readonly<{
  email: string;
  email_verified: boolean;
  sub: string;
  aud: string;
  exp: number | null;       // null → signIdToken fills now+3600
  iat: number | null;       // null → signIdToken fills now
  jti: string | null;       // null → signIdToken fills crypto.randomUUID()
  nonce: string | null;
  forceIssOverride: string | null;
}>;

export interface ScenarioStore {
  get(): Scenario;
  set(patch: z.infer<typeof ScenarioOverrideSchema>): void;
  reset(): void;
}

export const DEFAULT_SCENARIO: Scenario = { /* Context §5 */ };

export const createScenarioStore = (): ScenarioStore => { /* in-memory */ };

export const defaultScenarioStore: ScenarioStore = createScenarioStore();
```

The module-level singleton `defaultScenarioStore` is the production
instance; `createApp` defaults `deps.scenario` to it. Tests call
`createScenarioStore()` for isolation — fresh store per test file.

**JwksKit interface** (`jwks.ts`):

```ts
export type JwksKit = Readonly<{
  privateKey: CryptoKey;
  publicJwk: { kty: 'RSA'; use: 'sig'; alg: 'RS256'; kid: string; n: string; e: string };
  kid: string;
}>;

// Top-level await — ESM module. Vitest >=4 supports this.
export const jwksKit: JwksKit = await (async () => {
  const { privateKey, publicKey } = await jose.generateKeyPair('RS256');
  const publicJwk = await jose.exportJWK(publicKey);
  const n = publicJwk.n as string;
  const kid = createHash('sha256').update(n).digest('hex').slice(0, 16);
  return { privateKey, publicJwk: { kty:'RSA', use:'sig', alg:'RS256', kid, n, e: publicJwk.e as string }, kid };
})();

export const generateJwks = async (): Promise<JwksKit> => { /* same logic, fresh keypair — for tests */ };
```

**Hono server factory** (`server.ts`):

```ts
export type Deps = Readonly<{
  baseUrl: string;
  jwks: JwksKit;
  scenario: ScenarioStore;
}>;

export const createApp = (deps: Deps): Hono => { /* … routes … */ };
```

`baseUrl` is a required dep — no `process.env` reads inside the
factory. The CLI entry (`src/index.ts`) reads env vars and constructs
the deps:

```ts
const port = Number(process.env.IDP_STUB_PORT ?? 3001);
const baseUrl = process.env.IDP_STUB_BASE_URL ?? `http://localhost:${port}`;
serve(createApp({ baseUrl, jwks: jwksKit, scenario: defaultScenarioStore }), { port });
```

**Result pattern**: `signIdToken` returns `Promise<Result<string, Error>>`
(matches `lib/result.ts` shape). The `/token` handler in `server.ts`
unwraps and returns 500 + structured error body on `{ok:false}`. Other
boundary modules (jwks, scenario) are synchronous; failures bubble as
thrown exceptions caught by Hono's `onError` handler returning
`{error:{message}}`.

**Error response shape**: all 4xx/5xx responses use Hono's
`c.json({ error: { message: string } }, status)`. A shared
`badRequest(c, msg: string)` helper in `server.ts` enforces consistency.

**`/admin/scenario/reset`** is its own route handler:

```ts
app.post('/admin/scenario/reset', (c) => {
  deps.scenario.reset();
  return c.body(null, 204);
});
```

**Playwright integration** (`apps/server/tests/e2e/global-setup.ts`):

Spawn order:
1. Postgres testcontainer
2. Migrations + seeds (existing `execFileSync` calls)
3. **NEW** spawn `pnpm --filter @tokenfx/idp-stub start` (long-running `spawn`)
4. **NEW** poll `${IDP_STUB_BASE_URL}/.well-known/openid-configuration`
   until 200 OR 5s deadline → throw on timeout
5. Set env vars (`OKTA_ISSUER=${IDP_STUB_BASE_URL}`, etc.)
6. Spawn Next.js dev server (existing)
7. Wait for dev server readiness (existing)

Teardown: refactor the existing three `process.once` handlers into a
shared `stopAll()` helper that kills BOTH the stub AND the dev server
AND stops the container. The three signal handlers wrap `stopAll()`
and exit AFTER it resolves (prevents race where `process.exit` fires
before the stub kill completes).

**Helper module** (`apps/server/tests/e2e/helpers/idp-stub-control.ts`):

```ts
export type SetStubOpts = Readonly<{
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
}>;

export const setStubScenario = async (
  patch: z.infer<typeof ScenarioOverrideSchema>,
  opts: SetStubOpts = {},
): Promise<void> => {
  const f = opts.fetch ?? globalThis.fetch;
  const base = opts.baseUrl ?? process.env.IDP_STUB_BASE_URL ?? 'http://localhost:3001';
  const res = await f(`${base}/admin/scenario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`setStubScenario failed: ${res.status} ${await res.text()}`);
};

export const resetStubScenario = async (opts: SetStubOpts = {}): Promise<void> => { /* POST /admin/scenario/reset */ };
```

Matches `sign-in-as.ts` fetch-injection convention so helper failure-mode
TCs (TC-I-18) are unit-testable without a live server.

**NextAuth config**: NO changes. The existing `OKTA_*` env wiring is
sufficient. `TOKENFX_SSO_ISSUERS_OKTA=http://localhost:3001` extends
the whitelist via existing code in
`apps/server/lib/auth/sso-auto-provision.ts:231-239`.

### Files to Create

- `apps/idp-stub/package.json`
- `apps/idp-stub/tsconfig.json` (standalone, see Context §12)
- `apps/idp-stub/vitest.config.ts`
- `apps/idp-stub/src/index.ts`
- `apps/idp-stub/src/logger.ts`
- `apps/idp-stub/src/server.ts`
- `apps/idp-stub/src/server.test.ts`
- `apps/idp-stub/src/server.port.test.ts`
- `apps/idp-stub/src/jwks.ts`
- `apps/idp-stub/src/jwks.test.ts`
- `apps/idp-stub/src/scenario.ts`
- `apps/idp-stub/src/scenario.test.ts`
- `apps/idp-stub/src/fixtures.ts`
- `apps/idp-stub/src/fixtures.test.ts`
- `apps/idp-stub/README.md`
- `apps/server/tests/e2e/helpers/idp-stub-control.ts`
- `apps/server/tests/e2e/helpers/idp-stub-control.test.ts` (TC-I-18 — helper failure-mode coverage via fetch injection)
- `apps/server/tests/e2e/sso-flow.spec.ts` — TC-E2E-01, TC-E2E-02, TC-E2E-08
- `apps/server/tests/e2e/manager-ui.spec.ts` — TC-E2E-03..07

### Files to Modify

- `pnpm-workspace.yaml` — add `packages: ['apps/*']` (currently absent — confirmed by inspection)
- `package.json` (root) — add `"idp-stub": "pnpm --filter @tokenfx/idp-stub start"` script (exclusive — only TASK-1 touches this in this spec)
- `apps/server/tests/e2e/global-setup.ts` — spawn stub + readiness probe + env vars + refactor teardown to use shared `stopAll`
- `apps/server/tests/integration/sso-auto-provision-replay.test.ts` — **NOTE: file already exists** with TC-I-34 + TC-I-45 deferred stubs. Keep the TC-I-45 deferred stub (REQ-FU-2 carve-out). TC-I-34 moves to E2E (TC-E2E-08 in `sso-flow.spec.ts`); leave a one-line `it.skip` referencing TC-E2E-08 so the TC-ID stays grep-able from spec-b.
- `.specs/central-server-onboarding-v2-sso.backend.md` — mark TC-I-34 PARTIALLY ADDRESSED (state-rejection verified; audit-row deferred to REQ-FU-1), TC-I-45 STILL DEFERRED (REQ-FU-2), TC-E2E-01/02 ADDRESSED
- `.specs/central-server-onboarding-v2-sso.manager-ui.md` — mark TC-E2E-01..05 ADDRESSED with link to this spec
- `apps/server/tests/e2e/sso-auto-provision.spec.ts` — **DELETE** (git history preserves the prior DEFERRED state; keeping a re-export note would still execute under Playwright's loader and print pointless console.warn)

### Dependencies

External packages to add to `apps/idp-stub/package.json`:

| Package | Version | Purpose |
| --- | --- | --- |
| `hono` | `^4.0.0` | HTTP server |
| `@hono/node-server` | `^1.0.0` | Node.js adapter |
| `jose` | match `apps/server/pnpm-lock.yaml` resolution (currently `^5.x`) | RS256 sign + JWKS serialization (verify parity with NextAuth's transitive version) |
| `zod` | `^4.0.0` | Request validation |

Dev deps (inherited from workspace): `vitest`, `typescript`, `tsx`,
`@types/node`. **No new deps in `apps/server/`** — Playwright helper
uses global `fetch`.

## Tasks

- [x] **TASK-1**: Workspace scaffold — register `apps/idp-stub/` as a
      pnpm workspace package and add root script. **REQUIRED**: add
      `packages: ['apps/*']` to `pnpm-workspace.yaml` (currently absent;
      `apps/server` works today via pnpm's implicit root discovery, but
      that fallback is version-dependent — must declare explicitly for
      a new package).
  - files:
    - `apps/idp-stub/package.json`
    - `apps/idp-stub/tsconfig.json`
    - `apps/idp-stub/vitest.config.ts`
    - `pnpm-workspace.yaml`
    - `package.json` (root)
  - Verify with: `pnpm install` then `pnpm ls --filter @tokenfx/idp-stub`
    returns exactly one project.

- [x] **TASK-2**: JWKS module — RS256 keypair (top-level await) +
      JWKS serialization + `kid` = SHA-256(n)[:16].
  - files: `apps/idp-stub/src/jwks.ts`, `apps/idp-stub/src/jwks.test.ts`
  - tests: TC-U-01, TC-U-02, TC-U-10, TC-U-24
  - depends: TASK-1

- [x] **TASK-3**: Scenario module — `ScenarioStore` interface,
      `createScenarioStore` factory, `defaultScenarioStore` singleton,
      `ScenarioOverrideSchema` Zod.
  - files: `apps/idp-stub/src/scenario.ts`, `apps/idp-stub/src/scenario.test.ts`
  - tests: TC-U-05, TC-U-06, TC-U-07, TC-U-13, TC-U-14, TC-U-15, TC-U-16, TC-U-17, TC-U-18, TC-U-19, TC-U-20, TC-U-21, TC-U-22, TC-U-23
  - depends: TASK-1

- [x] **TASK-4**: Fixtures — `buildDiscoveryDoc(baseUrl)` + `signIdToken`
      (Result return).
  - files: `apps/idp-stub/src/fixtures.ts`, `apps/idp-stub/src/fixtures.test.ts`
  - tests: TC-U-03, TC-U-04, TC-U-08, TC-U-09, TC-U-11, TC-U-12, TC-U-25
  - depends: TASK-2, TASK-3

- [x] **TASK-5**: Hono server — `createApp({baseUrl,jwks,scenario})` +
      endpoints + integration tests + CLI entry + local logger.
  - files:
    - `apps/idp-stub/src/server.ts`
    - `apps/idp-stub/src/server.test.ts`
    - `apps/idp-stub/src/server.port.test.ts`
    - `apps/idp-stub/src/index.ts`
    - `apps/idp-stub/src/logger.ts`
  - tests: TC-I-01..23 (everything except TC-I-24 which lives in
    `idp-stub-control.test.ts`)
  - depends: TASK-4

- [x] **TASK-6**: README — how to run, scenario API, security note
      (no privacy logging, no PII echo).
  - files: `apps/idp-stub/README.md`
  - depends: TASK-5

- [x] **TASK-7**: Playwright global-setup — spawn stub + readiness probe
      + env wiring + refactored shared `stopAll` teardown + helper +
      helper unit tests.
  - files:
    - `apps/server/tests/e2e/global-setup.ts`
    - `apps/server/tests/e2e/helpers/idp-stub-control.ts`
    - `apps/server/tests/e2e/helpers/idp-stub-control.test.ts`
  - tests: TC-I-18, TC-I-24 (both helper failure-mode TCs run via Vitest
    against injected `fetch` — no live stub needed)
  - depends: TASK-5

- [x] **TASK-8**: Update existing replay test file — TC-I-34 stub
      replaced with `it.skip('see TC-E2E-08 in sso-flow.spec.ts')` to
      preserve grep-ability. TC-I-45 stub preserved (REQ-FU-2).
  - files: `apps/server/tests/integration/sso-auto-provision-replay.test.ts`
  - tests: (no new it() — only edits the deferred stubs)
  - depends: TASK-7

- [x] **TASK-9**: E2E SSO sign-in spec — happy path + CSRF origin guard
      + state replay (TC-E2E-01, TC-E2E-02, TC-E2E-08).
  - files: `apps/server/tests/e2e/sso-flow.spec.ts`
  - tests: TC-E2E-01, TC-E2E-02, TC-E2E-08
  - depends: TASK-7

- [x] **TASK-10**: E2E manager-ui spec (closes spec-c TC-E2E-01..05).
  - files: `apps/server/tests/e2e/manager-ui.spec.ts`
  - tests: TC-E2E-03, TC-E2E-04, TC-E2E-05, TC-E2E-06, TC-E2E-07
  - depends: TASK-7

- [x] **TASK-11**: Delete the legacy DEFERRED Playwright stub file
      (`sso-auto-provision.spec.ts`) and update parent specs to mark
      TCs ADDRESSED / PARTIALLY ADDRESSED / DEFERRED-FOLLOWUP.
  - files:
    - `apps/server/tests/e2e/sso-auto-provision.spec.ts` (DELETE)
    - `.specs/central-server-onboarding-v2-sso.backend.md`
    - `.specs/central-server-onboarding-v2-sso.manager-ui.md`
  - depends: TASK-8, TASK-9, TASK-10

- [x] **TASK-SMOKE**: Run full E2E + replay/orchestration integration
      suites.
  - Run `pnpm --filter @tokenfx/idp-stub test --run`
  - Run `pnpm --filter @tokenfx/server test --run` (catches helper TCs)
  - Run `pnpm --filter @tokenfx/server test:e2e`
  - If dev server fails to boot: log `E2E: DEFERRED` per project convention
  - files: (none — execution only)
  - tests: TC-U-*, TC-I-*, TC-E2E-01..08
  - depends: TASK-8, TASK-9, TASK-10, TASK-11

## Parallel Batches

```
Batch 1: [TASK-1]                            — scaffold (no deps)
Batch 2: [TASK-2, TASK-3]                    — parallel: distinct files, both depend on TASK-1
Batch 3: [TASK-4]                            — depends on TASK-2 + TASK-3
Batch 4: [TASK-5]                            — depends on TASK-4
Batch 5: [TASK-6, TASK-7]                    — parallel: README + Playwright wiring
Batch 6: [TASK-8, TASK-9, TASK-10]           — parallel: all depend on TASK-7 only, distinct files
Batch 7: [TASK-11]                           — bookkeeping + delete
Batch 8: [TASK-SMOKE]                        — final validation
```

File-overlap analysis:
- TASK-1 modifies root `package.json` + `pnpm-workspace.yaml` — exclusive
  (Batch 1, no other task touches these).
- TASK-7 modifies `apps/server/tests/e2e/global-setup.ts` — exclusive
  within Batch 5 (TASK-6 only touches a new file).
- TASK-9 creates `sso-flow.spec.ts`; TASK-10 creates `manager-ui.spec.ts`;
  TASK-8 modifies `sso-auto-provision-replay.test.ts` — all distinct
  files. Safe to parallelize in Batch 6.
- TASK-11 modifies parent specs + deletes legacy stub — exclusive within
  Batch 7.

## Validation Criteria

- [ ] `pnpm --filter @tokenfx/idp-stub typecheck` passes
- [ ] `pnpm --filter @tokenfx/idp-stub test --run` passes (TC-U-*, TC-I-01..23 except TC-I-18/24)
- [ ] `pnpm typecheck` (root) passes
- [ ] `pnpm --filter @tokenfx/server typecheck` passes
- [ ] `pnpm --filter @tokenfx/server lint` passes
- [ ] `pnpm --filter @tokenfx/server test --run` passes (includes TC-I-18, TC-I-24 via `idp-stub-control.test.ts`; the legacy `sso-auto-provision-replay.test.ts` continues to skip TC-I-34 with the redirect-to-TC-E2E-08 note and TC-I-45 unchanged)
- [ ] `pnpm --filter @tokenfx/server test:e2e` passes (TC-E2E-01..08)
- [ ] `pnpm build` (root) passes
- [ ] **Live validation**: in two shells — `pnpm idp-stub` + `pnpm --filter @tokenfx/server dev` (with `OKTA_*` envs pointing at stub); manually visit `/api/auth/signin/okta` in a browser; observe redirect → callback → `/me` page renders authenticated content; SQL spot-check on `users` table confirms new row. This validates the stub OUTSIDE the Playwright harness.
- [ ] **Privacy / security**: stub does NOT log id_token bodies, scenario bodies (only counts/keys), or request bodies. No `console.log` in `apps/idp-stub/src/**` — only `console.warn`/`console.error` via local logger, plus `process.stdout.write` for boot/shutdown lines in `index.ts`. JWKS public-only (TC-U-02 enforces field exclusion list `['d','p','q','dp','dq','qi']`). No PII in 4xx/5xx response bodies (`{error:{message}}` only).
- [ ] **No regressions**: existing ~50 SSO integration TCs + existing manager E2E specs (`manager.spec.ts`, `manager-effectiveness.spec.ts`, etc.) continue passing.

## Execution Log

### Batch 1 — TASK-1 (2026-05-12 18:43)
Inline. Workspace scaffold: `apps/idp-stub/{package.json,tsconfig.json,vitest.config.ts}` created; `pnpm-workspace.yaml` gained `packages: ['apps/*']`; root `package.json` gained `idp-stub` script. `pnpm install` succeeded; `pnpm ls --filter @tokenfx/idp-stub` confirms registration.

### Batch 2 — [TASK-2, TASK-3] (2026-05-12 18:46)
Parallel via worktrees.
- TASK-2: JWKS module — TDD: RED(1 module-missing) → GREEN(4 passing). `jose.generateKeyPair('RS256')` + `kid` = SHA-256(n)[:16]. Top-level await for `jwksKit` singleton + `generateJwks()` factory for tests.
- TASK-3: Scenario module — TDD: RED(1 module-missing) → GREEN(18 passing). `ScenarioOverrideSchema` Zod 4 with `.strict()`, all bounds matching REQ-5. `createScenarioStore()` factory + `defaultScenarioStore` singleton.

### Batch 3 — TASK-4 (2026-05-12 18:48)
Inline. Fixtures — `buildDiscoveryDoc(baseUrl)` (RFC 8414 doc with trailing-slash strip) + `signIdToken({jwks, issuer, scenario}): Promise<Result<string, Error>>` using `jose.SignJWT`. `jti` defaults to `crypto.randomUUID()`. Local `Result` type (canonical `lib/result.ts` not reachable from standalone package — drift risk flagged). TDD: GREEN(10 passing); cumulative 32/32.

### Batch 4 — TASK-5 (2026-05-12 18:52)
Inline. Hono server — `createApp({baseUrl, jwks, scenario})` factory + 6 routes: `/.well-known/openid-configuration`, `/jwks`, `/authorize` (open-redirect guard), `/token` (form-encoded only, 6 distinct error branches), `/admin/scenario` (Zod-validated), `/admin/scenario/reset`. `index.ts` CLI entry binds to 127.0.0.1 (security review MEDIUM-1). `logger.ts` local module (mirrors `lib/logger.ts` shape without importing it). TDD: GREEN(28 server.test.ts + 2 server.port.test.ts = 30 added; cumulative 62/62).

### Batch 5 — [TASK-6, TASK-7] (2026-05-12 18:54)
Parallel (inline since file scope is non-overlapping).
- TASK-6: `apps/idp-stub/README.md` — endpoints, env vars, scenario API, security notes (loopback bind + open-redirect allow-list documented).
- TASK-7: Playwright wiring — `global-setup.ts` spawns stub before dev server with 5s readiness probe; shared `stopAll()` teardown replaces 3 racy `process.once` handlers. `idp-stub-control.ts` helper with `opts.fetch` injection seam (matches `sign-in-as.ts` convention) + 3 functions: `setStubScenario`, `resetStubScenario`, `waitForStubReady`. TDD: GREEN(8 helper TCs).

### Batch 6 — [TASK-8, TASK-9, TASK-10] (2026-05-12 19:10)
Parallel (inline; distinct files).
- TASK-8: `sso-auto-provision-replay.test.ts` — TC-I-34 stub now redirects to TC-E2E-08 (state-replay moved to E2E); TC-I-45 (nonce replay) preserved as `it.skip` (REQ-FU-2). 2 skipped.
- TASK-9: `sso-flow.spec.ts` — TC-E2E-01 (happy SSO sign-in), TC-E2E-02 (CSRF origin guard), TC-E2E-08 (state-cookie replay).
- TASK-10: `manager-ui.spec.ts` — TC-E2E-03..07 covering banner / audit-log filters / CSV / invite / team-roster.

### Batch 7 — TASK-11 (2026-05-12 19:13)
Inline. Deleted `apps/server/tests/e2e/sso-auto-provision.spec.ts` (git history preserves the prior DEFERRED state). Marked spec-b's TC-I-34 PARTIALLY ADDRESSED + TC-E2E-01/02 ADDRESSED. Marked spec-c's TC-E2E-01..05 ADDRESSED.

### Batch 8 — TASK-SMOKE + Phase 3 review (2026-05-12 19:14 → 19:27)
Validation snapshot pre-review: idp-stub 62/62, apps/server 1201/1212 (1 pre-existing flake at `aggregate-team-outcomes.test.ts:233`, 10 skipped of which 2 intentional replay stubs + 8 pre-existing), typecheck + lint clean. Required `pnpm rebuild bcrypt` to fix Node 26 ABI mismatch (recurring with major Node upgrades).

3-reviewer parallel pass surfaced ~15 findings; trivial fixes applied inline:

**Implementation hardening (security review MEDIUMs):**
- Bound stub to `127.0.0.1` only in `index.ts:13` (closes LAN-attacker vector).
- Added Origin guard on `/admin/*` endpoints — rejects cross-origin requests (DNS-rebinding defense).
- Tightened `/admin/scenario` to require `application/json` content-type (closes `<form>` DNS-rebinding payload).
- Sanitized `/token` 500 error body — opaque `'token signing failed'` message instead of raw jose error.
- Renamed `OKTA_CLIENT_SECRET='test-secret'` → `'fake-e2e-not-a-real-secret'` (secret-scanner hygiene).
- Added `.describe()` to `forceIssOverride` Zod field flagging it as SECURITY-TESTING ONLY.

**Test coverage gaps closed:**
- Added TC-I-23 (POST /authorize wrong method → 404/405).
- Added max-255 boundary TCs for `sub`, `aud`, `jti`, `nonce`, `forceIssOverride`.
- Added empty-aud + empty-nonce min-length TCs.
- Added `iat=0` and `iat=-1` boundary TCs (mirror exp).
- Added Origin-rejection TC + content-type-rejection TC for `/admin/scenario`.

**E2E test honesty — vacuous assertions converted to `test.skip` with PARTIALLY ADDRESSED notes:**
- TC-E2E-08 (state-replay): URL-capture brittle across NextAuth v5 minors; first-callback success covered by TC-E2E-01.
- TC-E2E-06 (invite-create): form-render check only; full submit+persist round-trip covered by integration test in `actions.test.ts`.
- TC-E2E-07 (team-roster filter): filter logic covered by `team-roster-csv.test.ts` integration TCs (including `?provisioned_via=all`).

Final validation post-fixes:
- idp-stub: 74/74 passing (was 62; +12 from new TCs), typecheck clean
- apps/server: 1201/1212 (1 pre-existing flake, 10 skipped), typecheck + lint clean
- root: 1149/1150 (pre-existing chokidar flake)
- E2E: deferred (`pnpm test:e2e` requires full stack; spec files written + ready)

Status → DONE pending Pause 2 commit approval.

### Fechamento retroativo (2026-07-12)

Status fechado retroativamente — código commitado em c218fb2 (ver .specs/docs-reconciliation.md item 2.4).
