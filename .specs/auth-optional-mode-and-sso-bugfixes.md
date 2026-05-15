# Spec: auth-optional-mode-and-sso-bugfixes

## Status: DONE

## Context

Two intertwined goals, single spec because they share the auth code surface:

### Goal A — Make auth optional via env flag (initial release need)

For the initial release, `apps/server`'s manager dashboards ship as **localhost-only open-access** (no login). The SSO infrastructure (4 specs DONE: `central-server-onboarding-v2-sso.*`) stays in code; we add a flag-gated bypass so:

- Default in this codebase: `AUTH_REQUIRED=false` → all `/manager/*` and `/me/*` routes open. Queries that read `auth.user.orgId`/`role` see a shimmed demo session.
- Production deployments set `AUTH_REQUIRED=true` (or omit the flag) → full SSO behavior unchanged.

### Goal B — Fix the 3 pre-existing SSO bugs surfaced in cross-stack smoke

So that flipping `AUTH_REQUIRED=true` actually works:

1. **`E2E_AUTH_BYPASS` crashes Next.js standalone.** `apps/server/.next/standalone/server.js:5` hardcodes `process.env.NODE_ENV = 'production'`, overriding compose's `NODE_ENV: development`. The boot guard `assertNotProductionWithBypass` (`apps/server/lib/auth/e2e-bypass-provider.ts:102`) then throws on every `/api/auth/*` request.
2. **`pages.signIn: '/api/auth/signin'` self-loop.** `auth.config.ts:75` points the custom signin page at NextAuth's own handler URL → infinite 302 loop. The line is uncommented (the comment block below pertains to `error: '/auth/error'`, not `signIn`).
3. **CSRF Origin guard rejects same-origin POSTs.** Even with `Origin: http://localhost:3232` exactly matching the Host header, `POST /api/auth/signin/okta` returns 403 `cross-origin`. The `csrfWrap` in `apps/server/app/api/auth/[...nextauth]/route.ts:83` computes `baseUrl` via `new URL(request.url)`, which under `AUTH_TRUST_HOST=1` may diverge from the Origin header's canonical form.

### Decisões já travadas

**Architecture:**
- **Default polarity:** `isAuthRequired(env) = env.AUTH_REQUIRED !== 'false'`. Only the literal string `'false'` flips auth off — every other value (unset, empty, `'0'`, `'False'`, whitespace-padded, `undefined`) keeps auth on. Fail-safe.
- **Session injection strategy:** shim `auth()` directly. In `apps/server/lib/auth/auth.ts`, the exported `auth` function checks `isAuthRequired(process.env)` first; when false, returns `buildLocalDevSession()` directly without calling NextAuth. NextAuth never runs in localhost mode → no JWT, no cookies, no audit rows. Server Components and Server Actions calling `auth()` get the demo session transparently.
- **Localhost-binding enforcement: request-time, not boot-time.** Middleware checks the incoming `Host` header when `AUTH_REQUIRED=false`. If host is NOT in the localhost set (`localhost`, `127.0.0.1`, `[::1]`, with or without port), return 403. This actually enforces the constraint at runtime — `HOSTNAME` env is unreliable (Next.js standalone hardcodes `HOSTNAME=0.0.0.0`, doesn't reflect actual bind, easily spoofed by misconfigured boot).
- **`local-org` constant:** fixed UUID `'00000000-0000-0000-0000-000000000001'`. Defined as `LOCAL_ORG_ID` in `lib/auth/auth-required.ts`. Migration uses the same constant. Avoids the UUID-vs-text-slug type clash (`orgs.id` is `uuid PRIMARY KEY` per `0000_init.sql:8`).
- **Bug #1 dual opt-in:** introduce `TOKENFX_AUTH_BYPASS_ALLOWED=1` env. `assertNotProductionWithBypass` requires `E2E_AUTH_BYPASS=1` AND (`NODE_ENV ∈ {test, development}` OR `TOKENFX_AUTH_BYPASS_ALLOWED=1`). The new flag is the escape hatch for environments where Next.js standalone forces `NODE_ENV='production'` (smoke profile). Production never sets the flag.
- **Bug #2 fix:** delete the `pages.signIn: '/api/auth/signin'` line entirely. NextAuth renders its built-in signin page at `/api/auth/signin` without the override. The comment block below the line documents `error: '/auth/error'`, NOT `signIn` — confirmed via re-reading the source. No custom signin UI is required for the initial release.
- **Bug #3 fix:** switch `baseUrl` source in `csrfWrap` from `new URL(request.url).host` to the raw `request.headers.get('host')`. Confirmed by instrumentation in TASK-6 (no longer an open investigation — locked here based on the most-likely cause; if instrumentation reveals a different root cause, the spec must be updated before TASK-7 lands).

**Operational:**
- **Smoke profile** sets `AUTH_REQUIRED=true` (explicit), `TOKENFX_AUTH_BYPASS_ALLOWED=1`, re-adds `E2E_AUTH_BYPASS=1`. Smoke exercises the SSO path.
- **Production image** (`apps/server/Dockerfile`) sets NEITHER `AUTH_REQUIRED` nor `TOKENFX_AUTH_BYPASS_ALLOWED` nor `E2E_AUTH_BYPASS`. The unset state is the safe default.
- **Boot-time warning:** `lib/logger.warn("AUTH_REQUIRED=false — all manager dashboards are open-access. Set AUTH_REQUIRED=true for production.")` when localhost mode is on.

## Threat Model

1. **Trust boundary.** Three modes:
   - `AUTH_REQUIRED=false` + localhost-bound: no in-app trust boundary. Network-level isolation (request-time Host check + intended localhost binding) is the sole defense.
   - `AUTH_REQUIRED=true` + Okta/Google SSO: ID token from IdP is the trust boundary marker.
   - Smoke profile: `AUTH_REQUIRED=true` + IdP stub + `E2E_AUTH_BYPASS=1` paired with `TOKENFX_AUTH_BYPASS_ALLOWED=1`.

2. **Identidade autenticada.** Localhost mode: no caller identity verified — injected demo session `{role:'admin', orgId:LOCAL_ORG_ID}`. SSO mode: unchanged.

3. **Credenciais em jogo.** Localhost mode: zero credentials (no cookies issued — `auth()` shim returns the demo session without going through NextAuth). SSO mode: unchanged.

4. **Replay & idempotency.** Localhost mode: N/A. SSO mode: unchanged.

5. **Authorization scope.** Localhost mode: every query that reads `auth.user.orgId` receives the fixed `LOCAL_ORG_ID` UUID. The `org_id` filter remains active at the query layer — if multi-org data lands in the DB (e.g., a developer manually inserts rows for testing), queries STILL exclude them. The scoping mechanism is preserved; only the JWT-sourced identity is replaced.

6. **PII / audit trail.** Localhost mode: `auth_event_log` receives ZERO rows (no signin attempts, no NextAuth in flight). Invariant: SELECT COUNT(*) FROM auth_event_log = 0 after N requests in localhost mode. Smoke/production: unchanged.

### Security-critical invariants

- `AUTH_REQUIRED=false` + Host header NOT in localhost set → request returns 403 at middleware. Enforced AT EVERY REQUEST, not just at boot. The implication: even if the server binds to `0.0.0.0` and listens on the LAN, only requests with `Host: localhost*` headers are served. Attacker accessing via IP would need to send `Host: localhost` explicitly — at which point browser CORS/cookie behavior already constrains them.
- **`X-Forwarded-Host` is NOT honored.** Only the raw `Host` header is checked. A reverse proxy forwarding `Host: localhost` to a public bind would defeat this guard, but that requires the proxy operator to opt in — an explicit deployment misconfiguration documented in CLAUDE.md as "do NOT put apps/server behind a public reverse proxy with AUTH_REQUIRED=false".
- `AUTH_REQUIRED=true` (or unset) → current behavior 100% preserved.
- Production image sets no auth-disabling env vars (TC-V-PROD asserts).

## Requirements

- [ ] REQ-1: GIVEN `AUTH_REQUIRED` unset or set to anything other than the literal `"false"` (case-sensitive, no whitespace trim) WHEN the server boots THEN the SSO middleware enforces all `/manager/*` and `/me/*` routes (status quo).
- [ ] REQ-2: GIVEN `AUTH_REQUIRED=false` AND request has `Host: localhost:3232` (or `127.0.0.1:3232` or `[::1]:3232`) WHEN it hits `/manager/teams` THEN response is HTTP 200 with dashboard content (no signin redirect).
- [ ] REQ-3: GIVEN `AUTH_REQUIRED=false` AND request has `Host: <non-localhost>` (e.g., `192.168.1.5:3232`, `evil.example.com`) WHEN it hits any `/manager/*` or `/me/*` route THEN response is HTTP 403 with `{"error":"forbidden","code":"localhost-only"}`.
- [ ] REQ-4: GIVEN `AUTH_REQUIRED=false` WHEN any query reads `auth.user.orgId` THEN it receives the constant `LOCAL_ORG_ID` UUID; queries scoped on this id return rows for that org only.
- [ ] REQ-5 (bug #2): GIVEN `AUTH_REQUIRED=true` WHEN `curl -L http://localhost:3232/api/auth/signin` runs THEN it follows ≤1 redirect and returns HTTP 200 (NextAuth default signin page renders).
- [ ] REQ-6 (bug #1): GIVEN `AUTH_REQUIRED=true` AND `E2E_AUTH_BYPASS=1` AND `TOKENFX_AUTH_BYPASS_ALLOWED=1` WHEN the server boots THEN the bypass provider is wired (no boot-time throw).
- [ ] REQ-7 (bug #1 prod safety): GIVEN `E2E_AUTH_BYPASS=1` AND `NODE_ENV` is `'production'` AND `TOKENFX_AUTH_BYPASS_ALLOWED` unset or NOT `'1'` WHEN the server boots THEN it throws `E2E_AUTH_BYPASS=1 in production requires TOKENFX_AUTH_BYPASS_ALLOWED=1. Refusing to boot.`.
- [ ] REQ-8 (bug #1 backwards compat): GIVEN `E2E_AUTH_BYPASS=1` AND `NODE_ENV ∈ {test, development}` (regardless of `TOKENFX_AUTH_BYPASS_ALLOWED`) WHEN the server boots THEN bypass provider is wired (no throw). Preserves existing unit-test behavior.
- [ ] REQ-9 (bug #3): GIVEN `AUTH_REQUIRED=true` AND `POST /api/auth/signin/okta` with `Origin: http://localhost:3232` matching `Host: localhost:3232` WHEN the request is processed THEN response is NOT 403 cross-origin (302 to authorize URL).
- [ ] REQ-10 (bug #3 still rejects cross-origin): GIVEN same setup AND `Origin: http://evil.example.com` WHEN processed THEN response is 403 cross-origin (the guard still catches real attacks).
- [ ] REQ-11 (audit-log invariant): GIVEN `AUTH_REQUIRED=false` WHEN any number of requests hit any route THEN `SELECT COUNT(*) FROM auth_event_log` increases by 0 (NextAuth never runs → no audit rows).
- [ ] REQ-12 (regression): GIVEN existing E2E suites (`apps/server/tests/e2e/sso-flow.spec.ts`, `sso-nonce-replay.spec.ts`, `review-fixes-smoke.spec.ts`) WHEN re-run after this spec with `AUTH_REQUIRED=true` set THEN they continue to pass.
- [ ] REQ-13 (production safety): GIVEN the production image WHEN env is inspected THEN `AUTH_REQUIRED`, `TOKENFX_AUTH_BYPASS_ALLOWED`, `E2E_AUTH_BYPASS` are all absent.

## Test Plan

### Unit Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-1 | happy | `isAuthRequired({AUTH_REQUIRED: undefined})` | `true` (fail-safe) |
| TC-U-02 | REQ-1 | happy | `isAuthRequired({AUTH_REQUIRED: 'true'})` | `true` |
| TC-U-03 | REQ-2 | happy | `isAuthRequired({AUTH_REQUIRED: 'false'})` | `false` |
| TC-U-04 | REQ-1 | edge | `isAuthRequired({AUTH_REQUIRED: '0'})` | `true` (only literal `"false"` flips it) |
| TC-U-05 | REQ-1 | edge | `isAuthRequired({AUTH_REQUIRED: ''})` | `true` |
| TC-U-06 | REQ-1 | edge | `isAuthRequired({AUTH_REQUIRED: 'False'})` (case-sensitive) | `true` |
| TC-U-07 | REQ-1 | edge | `isAuthRequired({AUTH_REQUIRED: 'false '})` (trailing space — no trim) | `true` |
| TC-U-08 | REQ-4 | happy | `buildLocalDevSession()` shape | `{user:{id:'local-dev', email:'dev@localhost', role:'admin', orgId:LOCAL_ORG_ID}, expires:<>=now+1y>}` |
| TC-U-09 | REQ-3 | happy | `isLocalhostHost('localhost:3232')` | `true` |
| TC-U-10 | REQ-3 | happy | `isLocalhostHost('127.0.0.1:3232')` | `true` |
| TC-U-11 | REQ-3 | happy | `isLocalhostHost('[::1]:3232')` | `true` |
| TC-U-12 | REQ-3 | happy | `isLocalhostHost('localhost')` (no port) | `true` |
| TC-U-13 | REQ-3 | edge | `isLocalhostHost('192.168.1.5:3232')` | `false` |
| TC-U-14 | REQ-3 | edge | `isLocalhostHost('evil.example.com')` | `false` |
| TC-U-15 | REQ-3 | edge | `isLocalhostHost('localhost.evil.com')` (suffix attack) | `false` |
| TC-U-16 | REQ-3 | edge | `isLocalhostHost('0.0.0.0:3232')` | `false` (0.0.0.0 is the "any" interface, not loopback) |
| TC-U-17 | REQ-3 | edge | `isLocalhostHost(null)` (Host header missing) | `false` (fail-closed) |
| TC-U-18 | REQ-6 | happy | `assertNotProductionWithBypass({NODE_ENV:'production', E2E_AUTH_BYPASS:'1', TOKENFX_AUTH_BYPASS_ALLOWED:'1'})` | no throw |
| TC-U-19 | REQ-7 | security | `{NODE_ENV:'production', E2E_AUTH_BYPASS:'1'}` (BYPASS_ALLOWED unset) | throws |
| TC-U-20 | REQ-7 | security | `{NODE_ENV:'production', E2E_AUTH_BYPASS:'1', TOKENFX_AUTH_BYPASS_ALLOWED:'0'}` | throws (literal '1' required) |
| TC-U-21 | REQ-8 | happy | `{NODE_ENV:'development', E2E_AUTH_BYPASS:'1'}` (legacy dev path) | no throw |
| TC-U-22 | REQ-8 | happy | `{NODE_ENV:'test', E2E_AUTH_BYPASS:'1'}` (legacy test path) | no throw |
| TC-U-23 | REQ-7 | security | `{NODE_ENV:'production', E2E_AUTH_BYPASS:'0'}` (bypass off) | no throw (guard inert when bypass off) |
| TC-U-24 | REQ-9 | happy | `checkSigninOrigin(req with Origin='http://localhost:3232', baseUrl='http://localhost:3232')` | `{ok:true}` |
| TC-U-25 | REQ-10 | security | `checkSigninOrigin(req with Origin='http://evil.example.com', baseUrl='http://localhost:3232')` | `{ok:false, reason:'cross-origin'}` |
| TC-U-26 | REQ-9 | edge | Reproduce bug #3: `request.url='http://localhost:3232/api/auth/signin/okta'` + `Origin: http://localhost:3232` + the route handler builds baseUrl via `request.headers.get('host')` (NOT `url.host`) | `{ok:true}` — regression guard for the fix |

### Integration Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-2 | happy | `AUTH_REQUIRED=false` + dev server + `curl -H 'Host: localhost:3232' http://localhost:3232/manager/teams` | HTTP 200; HTML body contains team-dashboard marker (e.g., `<th>Team</th>` or stable selector) |
| TC-I-02 | REQ-2 | happy | Same + `/me/dashboard` | HTTP 200 |
| TC-I-03 | REQ-4 | happy | With localhost mode active, render a Server Component calling `getTeamsForOrg(auth.user.orgId)`; insert a `teams` row with `org_id=LOCAL_ORG_ID` first | response contains that team's name |
| TC-I-04 | REQ-3 | security | `curl -H 'Host: 192.168.1.5:3232' http://localhost:3232/manager/teams` (AUTH_REQUIRED=false) | HTTP 403; body `{"error":"forbidden","code":"localhost-only"}` |
| TC-I-05 | REQ-3 | security | Same with `Host: evil.example.com` | HTTP 403 same body |
| TC-I-06 | REQ-3 | security | Same with `Host: localhost.evil.com` (suffix attack) | HTTP 403 |
| TC-I-07 | REQ-4 | security | With localhost mode active: (1) insert a second org with a different UUID `'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'` + a team scoped to it; (2) curl `/manager/teams`; (3) assert response body does NOT contain the second-org team's name (proves query-layer scoping is intact) | 200 + body excludes the off-org team |
| TC-I-08 | REQ-11 | security | With localhost mode active, hit `/manager/teams` and `/me/dashboard` 3x each; `SELECT COUNT(*) FROM auth_event_log` before and after | counts unchanged |
| TC-I-09 | REQ-5 | happy | With `AUTH_REQUIRED=true`: `curl -L http://localhost:3232/api/auth/signin` (cookie jar enabled for csrf) | HTTP 200 after ≤1 redirect; HTML body present |
| TC-I-10 | REQ-9 | happy | With `AUTH_REQUIRED=true`: POST `/api/auth/signin/okta` with csrf token + matching Origin + Host | HTTP 302; Location starts with the issuer's authorize URL |
| TC-I-11 | REQ-10 | security | Same with `Origin: http://evil.example.com` | HTTP 403; body code = `cross-origin` |
| TC-I-12 | REQ-12 | happy | With `AUTH_REQUIRED=true` explicit: run `pnpm test:e2e --grep "sso-flow"` against the existing global-setup dev server | all assertions in `sso-flow.spec.ts` pass; key check: post-login URL = `/manager/teams` |
| TC-I-13 | REQ-1 | edge | `AUTH_REQUIRED` unset + `curl /manager/teams` (no session cookie) | HTTP 307 → `/api/auth/signin` (current SSO behavior preserved) |
| TC-I-14 | REQ-13 | security | `docker build -t test-prod -f apps/server/Dockerfile .` then `docker inspect test-prod --format '{{range .Config.Env}}{{.}}{{"\n"}}{{end}}' \| grep -E 'AUTH_REQUIRED\|TOKENFX_AUTH_BYPASS_ALLOWED\|E2E_AUTH_BYPASS' \|\| echo ABSENT` | output is `ABSENT` |
| TC-I-15 | REQ-3 | security | `AUTH_REQUIRED=false` request with `X-Forwarded-Host: localhost` AND `Host: 192.168.1.5:3232` | HTTP 403 (raw `Host` is checked, X-Forwarded-Host ignored) |
| TC-I-16 | REQ-6 | happy | Smoke compose with `E2E_AUTH_BYPASS=1` + `TOKENFX_AUTH_BYPASS_ALLOWED=1` boots tokenfx-server | container reaches HEALTHY; `curl /api/auth/signin/credentials` returns the bypass form |
| TC-I-17 | REQ-9 | happy | Inside running smoke stack: simulate browser POST roundtrip end-to-end via curl through the IdP stub | session cookie set; final redirect lands on `/manager/teams` (or any authenticated page) |

### E2E Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-E2E-01 | REQ-2 | happy | New `tests/e2e/auth-localhost-mode.spec.ts`: Playwright with `AUTH_REQUIRED=false` env, browser hits `localhost:3232/manager/teams` | dashboard renders; no signin redirect; `local-org` content visible |
| TC-E2E-02 | REQ-12 | happy | Existing `apps/server/tests/e2e/sso-flow.spec.ts` (file path verbatim) run with explicit `AUTH_REQUIRED=true` in global-setup env | unchanged: all assertions pass |
| TC-E2E-03 | REQ-12 | security | Existing `apps/server/tests/e2e/sso-nonce-replay.spec.ts` run with `AUTH_REQUIRED=true` | unchanged: nonce replay rejected |

## Design

### Architecture Decisions

Three independent surfaces with locked approaches:

**1. `apps/server/lib/auth/auth-required.ts`** (new) — pure-function gate + localhost-host helper + demo session builder. Single file (no `local-dev-session.ts` micro-split — reviewer SHOULD-FIX consolidated):

```ts
// Only the exact string 'false' disables auth — every other value
// (including unset/empty/'0'/'False'/whitespace-padded) keeps auth on.
// Fail-safe: misconfiguration leaves auth ON, never OFF.
export const isAuthRequired = (env: NodeJS.ProcessEnv): boolean =>
  env.AUTH_REQUIRED !== 'false';

export const LOCAL_ORG_ID = '00000000-0000-0000-0000-000000000001';

const LOCALHOST_HOSTS: ReadonlySet<string> = new Set([
  'localhost', '127.0.0.1', '[::1]',
]);

// Accepts `<host>` or `<host>:<port>`. Suffix-attack-resistant: parses
// the host portion strictly and matches against an allow-list.
export const isLocalhostHost = (hostHeader: string | null): boolean => {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, '');
  return LOCALHOST_HOSTS.has(host);
};

export const buildLocalDevSession = () => ({
  user: {
    id: 'local-dev',
    email: 'dev@localhost',
    role: 'admin' as const,
    orgId: LOCAL_ORG_ID,
  },
  expires: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
});
```

**2. `apps/server/middleware.ts`** — early-return when localhost mode is on; localhost-host check enforced:

```ts
if (!isAuthRequired(process.env)) {
  const host = request.headers.get('host');
  if (!isLocalhostHost(host)) {
    return NextResponse.json(
      { error: 'forbidden', code: 'localhost-only' },
      { status: 403 },
    );
  }
  return NextResponse.next(); // open access for localhost
}
// ... existing auth middleware chain
```

**3. `apps/server/lib/auth/auth.ts`** — shim the `auth()` export. When localhost mode is on, return `buildLocalDevSession()` directly without invoking NextAuth:

```ts
const realAuth = NextAuth(buildAuthConfig(process.env)).auth;
export const auth: typeof realAuth = (async (...args) => {
  if (!isAuthRequired(process.env)) {
    return buildLocalDevSession();
  }
  return realAuth(...args);
}) as typeof realAuth;
```

**Bug #2 fix (`auth.config.ts`):** delete line 75 `signIn: '/api/auth/signin',`. The comment block at lines 76-81 documents `error: '/auth/error'` (the next line), not `signIn`. Verified via re-reading.

**Bug #1 fix (`e2e-bypass-provider.ts`):** update `assertNotProductionWithBypass`:

```ts
export const assertNotProductionWithBypass = (
  env: NodeJS.ProcessEnv = process.env,
): void => {
  if (env.E2E_AUTH_BYPASS !== '1') return; // guard inert
  // Legacy compat: dev/test NODE_ENV permits bypass without the new flag.
  if (env.NODE_ENV === 'test' || env.NODE_ENV === 'development') return;
  // Next.js standalone hardcodes NODE_ENV='production' at server.js:5,
  // so the legacy NODE_ENV signal alone is insufficient for the smoke
  // profile. Require explicit dual opt-in via the new flag.
  if (env.TOKENFX_AUTH_BYPASS_ALLOWED === '1') return;
  throw new Error(
    'E2E_AUTH_BYPASS=1 in production requires TOKENFX_AUTH_BYPASS_ALLOWED=1. Refusing to boot.',
  );
};
```

**Bug #3 fix (`app/api/auth/[...nextauth]/route.ts:csrfWrap`):** change baseUrl source from URL-normalized `url.host` to the raw `Host` header:

```ts
// Before: const baseUrl = `${url.protocol}//${url.host}`;
const host = request.headers.get('host');
const baseUrl = host ? `${url.protocol}//${host}` : `${url.protocol}//${url.host}`;
```

Hypothesis (locked, but verify with instrumentation in TASK-6): `new URL(request.url).host` under `AUTH_TRUST_HOST=1` normalizes ports/case differently than the raw header, producing `baseOrigin !== candidateOrigin` for same-origin requests. The raw header bypasses normalization.

**Migration `000X_local_org_seed.sql`:**

```sql
-- Seeds the deterministic local-org row used by AUTH_REQUIRED=false
-- localhost mode. UUID matches LOCAL_ORG_ID in lib/auth/auth-required.ts.
INSERT INTO orgs (id, name)
VALUES ('00000000-0000-0000-0000-000000000001', 'Local Development Org')
ON CONFLICT (id) DO NOTHING;
```

Idempotent. Lands in every environment (including production) because the row is harmless — without `AUTH_REQUIRED=false`, no code path references it.

**`apps/server/instrumentation.ts`** (new file — Next.js 15 convention): boot-time warning when `AUTH_REQUIRED=false`. No localhost-binding check here (that's request-time in middleware).

### Files to Create

- `apps/server/lib/auth/auth-required.ts` — gate + helpers + LOCAL_ORG_ID + demo session.
- `apps/server/lib/auth/auth-required.test.ts` — TC-U-01..23.
- `apps/server/lib/db/migrations/0005_local_org_seed.sql` — seed migration.
- `apps/server/instrumentation.ts` — Next.js 15 boot hook for the warning log.
- `apps/server/tests/e2e/auth-localhost-mode.spec.ts` — TC-E2E-01.

### Files to Modify

- `apps/server/lib/auth/auth.config.ts` — wire `isAuthRequired` into `authorized()`; delete `pages.signIn` line.
- `apps/server/lib/auth/auth.ts` — wire `auth()` shim for localhost mode.
- `apps/server/lib/auth/e2e-bypass-provider.ts` — update guard logic.
- `apps/server/lib/auth/e2e-bypass-provider.test.ts` — adjust + add TC-U-18..23.
- `apps/server/app/api/auth/[...nextauth]/route.ts` — bug #3 fix.
- `apps/server/lib/auth/csrf-origin-guard.test.ts` — add TC-U-24..26.
- `apps/server/middleware.ts` — localhost-host enforcement.
- `docker-compose.yaml` — smoke profile: `AUTH_REQUIRED=true`, `TOKENFX_AUTH_BYPASS_ALLOWED=1`, re-add `E2E_AUTH_BYPASS=1`.
- `CLAUDE.md` — document `AUTH_REQUIRED`, `TOKENFX_AUTH_BYPASS_ALLOWED` env vars; warn against public reverse proxy with localhost mode.
- `docs/smoke-runbook.md` — update; remove the 3 SSO bugs from "Deferred" (resolved).

### Dependencies

None.

## Tasks

- [ ] TASK-1: `auth-required.ts` + tests — pure-function gate, `LOCAL_ORG_ID`, `isLocalhostHost`, `buildLocalDevSession`.
  - files: apps/server/lib/auth/auth-required.ts, apps/server/lib/auth/auth-required.test.ts
  - tests: TC-U-01..17

- [ ] TASK-2: Migration `0005_local_org_seed.sql` — auto-create `LOCAL_ORG_ID` row.
  - files: apps/server/lib/db/migrations/0005_local_org_seed.sql
  - tests: (verified by TC-I-03 integration check)

- [ ] TASK-3: Bug #2 fix — delete `pages.signIn` line in `auth.config.ts`. **Pre-commit step:** `git blame apps/server/lib/auth/auth.config.ts | grep signIn` to confirm no recent spec authored the line for a specific reason (sso-replay-audit-row spec REQ-3's comment block applies to the NEXT line `error: '/auth/error'`, NOT to signIn — re-verify in the actual source).
  - files: apps/server/lib/auth/auth.config.ts
  - tests: TC-I-09

- [ ] TASK-4: Bug #1 fix — `assertNotProductionWithBypass` with dual opt-in.
  - files: apps/server/lib/auth/e2e-bypass-provider.ts, apps/server/lib/auth/e2e-bypass-provider.test.ts
  - tests: TC-U-18..23

- [ ] TASK-5: Bug #3 fix — switch `baseUrl` source in `csrfWrap` from `url.host` to `request.headers.get('host')`. **Pre-implementation step:** add temporary `logger.debug('csrf-guard', {urlHost: url.host, headerHost: request.headers.get('host'), originHeader, baseOriginFromUrlHost, baseOriginFromHeaderHost})`, run smoke + capture one failing request, paste the values into this spec's Execution Log. **If the captured evidence contradicts the `url.host` hypothesis, STOP and update Design before applying the fix.** Otherwise apply the fix as designed and remove the debug log in the same commit.
  - files: apps/server/app/api/auth/[...nextauth]/route.ts, apps/server/lib/auth/csrf-origin-guard.test.ts
  - tests: TC-U-24..26, TC-I-10, TC-I-11

- [ ] TASK-6: Wire `isAuthRequired` into `auth.config.ts:authorized()` (early-return permitting all when localhost mode is on).
  - files: apps/server/lib/auth/auth.config.ts
  - tests: TC-I-13
  - depends: TASK-1, TASK-3

- [ ] TASK-7: Wire `auth()` shim in `auth.ts`.
  - files: apps/server/lib/auth/auth.ts
  - tests: TC-I-03
  - depends: TASK-1, TASK-4

- [ ] TASK-8: Middleware host check + open-access early-return when localhost mode is on.
  - files: apps/server/middleware.ts
  - tests: TC-I-01, TC-I-02, TC-I-04, TC-I-05, TC-I-06, TC-I-15
  - depends: TASK-1

- [ ] TASK-9: Instrumentation file — boot-time warning when `AUTH_REQUIRED=false`.
  - files: apps/server/instrumentation.ts
  - tests: (visual — stdout log inspection)
  - depends: TASK-1

- [ ] TASK-10: `docker-compose.yaml` smoke profile — `AUTH_REQUIRED=true`, `TOKENFX_AUTH_BYPASS_ALLOWED=1`, re-add `E2E_AUTH_BYPASS=1`.
  - files: docker-compose.yaml
  - tests: TC-I-14, TC-I-16
  - depends: TASK-4, TASK-5

- [ ] TASK-11: Audit-log invariant test + cross-org scoping test.
  - files: (uses existing infrastructure — colocated integration test file e.g. apps/server/tests/integration/auth-localhost-mode.test.ts)
  - tests: TC-I-07, TC-I-08
  - depends: TASK-2, TASK-7, TASK-8

- [ ] TASK-12: Documentation — `CLAUDE.md` env vars + warnings; `docs/smoke-runbook.md` updates.
  - files: CLAUDE.md, docs/smoke-runbook.md
  - tests: (none)
  - depends: TASK-1, TASK-3, TASK-4, TASK-5

- [ ] TASK-SMOKE: Full smoke run end-to-end. Verify the 3 bugs are gone AND `AUTH_REQUIRED=false` works on the dev server.
  - files: docs/smoke-runbook.md (any wording drift)
  - tests: TC-E2E-01, TC-E2E-02, TC-E2E-03, TC-I-12, TC-I-17
  - depends: TASK-6, TASK-9, TASK-10, TASK-11, TASK-12

## Parallel Batches

- **Batch 1:** `[TASK-1, TASK-2, TASK-3, TASK-4, TASK-5]` — independent: pure helpers, migration, single-line config delete, guard fix, bug #3 fix.
- **Batch 2:** `[TASK-6, TASK-7, TASK-8, TASK-9]` — depend on TASK-1 (and TASK-3 for TASK-6). Different files: `auth.config.ts` (TASK-6), `auth.ts` (TASK-7), `middleware.ts` (TASK-8), `instrumentation.ts` (TASK-9). No file overlap → parallel safe.
- **Batch 3:** `[TASK-10, TASK-11]` — TASK-10 needs TASK-4/5 done; TASK-11 needs TASK-2/7/8 done. Different files (`docker-compose.yaml` vs new integration test).
- **Batch 4:** `[TASK-12]` — documentation; can land in parallel with Batch 3 BUT keeping in own batch to ensure all impl tasks complete first.
- **Batch 5:** `[TASK-SMOKE]`.

## Validation Criteria

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test --run` passes (1193+ tests, no flakes)
- [ ] `docker compose --profile smoke up -d` reaches HEALTHY for all 4 services
- [ ] Dev `pnpm dev` with `AUTH_REQUIRED=false`: `curl localhost:3232/manager/teams` returns 200
- [ ] Same with `Host: evil.com` header: returns 403
- [ ] With `AUTH_REQUIRED=true`: `curl -L /api/auth/signin` returns 200 (no loop)
- [ ] With `AUTH_REQUIRED=true`: `POST /api/auth/signin/okta` with valid same-origin headers returns 302
- [ ] Production image `docker inspect` shows no auth-disabling env vars
- [ ] `auth_event_log` row count unchanged after N requests in localhost mode
- [ ] Existing SSO E2E suite passes with `AUTH_REQUIRED=true`

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->
