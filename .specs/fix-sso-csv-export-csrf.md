# Spec: fix-sso-csv-export-csrf

## Status: DONE

## Context

Surge da Pause 2 do `central-server-onboarding-v2-sso.manager-ui` (commit
`4267229`), security HIGH H1.

### Problema

Os dois GET routes de CSV shipped pela spec (c) servem PII sensível do org:

- `apps/server/app/manager/audit-log/export/route.ts` — auth-event-log com
  `email_hash_prefix`, `iss`, `city`, UA, `decision_reason`.
- `apps/server/app/manager/teams/[id]/export/route.ts` — roster com
  `email_hash_prefix`, `provisioned_via`, `created_at`, `last_login_at`.

Browsers NÃO fazem pre-flight em GET → um atacante pode criar
`<a href="https://app.tokenfx.io/manager/audit-log/export">click me</a>`
num site malicioso. Manager autenticado que clica auto-baixa o CSV
(o atacante não lê o body — o browser entrega ao destino — mas vaza
via DNS-rebind, log de download, ou via técnicas mais sofisticadas
quando o body é JSON parseable; mais relevante: o CSV é entregue
ao **cliente** do atacante via attachment download e pode ser
exfiltrado posteriormente).

Isso é um vetor clássico de **CSRF-on-GET sensitive download**. O
mitigação padrão (OWASP Same-Origin Policy + Fetch Metadata Spec) é
checar `Sec-Fetch-Site` na request e rejeitar non-same-origin.

### Decisões já travadas

- **Helper separado** de `csrf-origin-guard.ts` (que é POST-only com
  Origin como sinal primário). GET tem semântica de navegação
  diferente (`<a href>`, bookmarks, type-URL) — precisa de
  `Sec-Fetch-Site` como sinal primário, com fallback Origin/Referer.
- **Sec-Fetch-Site=same-site → REJECT** (não accept). O manager
  dashboard está num único subdomain; same-site (e.g. blog.tokenfx.io
  → app.tokenfx.io) seria suspeito. Defesa em profundidade.
- **NO audit-log row** pra blocks de CSV CSRF. O `onboarding_redemption_log`
  é pra eventos de SSO/onboarding, não pra probes de manager-UI. Warn
  log é suficiente pra ops triage. Se padrão emergir, future spec
  adiciona `manager_csrf_log` table dedicada.
- **NO change em `csrfWrap`** do `/api/auth/[...nextauth]/route.ts` —
  esse wrappa POST flows (signin); CSV GETs têm Route Handlers separados.
- **Test helper update**: `makeReq()` nas test suites existentes precisa
  incluir `sec-fetch-site: 'same-origin'` por default, senão os 33+ TCs
  existentes quebram quando o guard rejeitar headers ausentes. Cross-site
  tests sobrescrevem o header explicitamente.
- **baseUrl source**: derivar de `request.nextUrl.origin` (mesma
  abordagem que o filename usa hoje). Não há `getBaseUrl()` helper
  centralizado a ser reaproveitado; `request.nextUrl.origin` já dá o
  scheme+host+port atual em ambos os route handlers.

## Requirements

- [ ] **REQ-1**: GIVEN uma request GET pro CSV export, WHEN o header
  `Sec-Fetch-Site` é `'same-origin'` OU `'none'`, THEN o guard retorna
  `{ok: true}` e o handler prossegue pra `auth()` + filter parse +
  query + CSV stream.
- [ ] **REQ-2**: GIVEN uma request GET, WHEN `Sec-Fetch-Site` é
  `'cross-site'`, THEN o guard retorna `{ok: false, reason: 'cross-site'}`
  e o handler responde `403 Forbidden` com body
  `{ error: { message: 'cross-origin request blocked', code: 'cross-site' } }`,
  `Content-Type: application/json`, e logger.warn fires once with
  `{ route, reason, sec_fetch_site: 'cross-site' }`. NUNCA loga o valor
  dos headers Origin/Referer (podem conter URLs sensíveis).
- [ ] **REQ-3**: GIVEN uma request GET, WHEN `Sec-Fetch-Site` é
  `'same-site'`, THEN o guard retorna `{ok: false, reason: 'same-site-rejected'}`
  e o handler responde 403. Mesmo shape de body/log. Decisão #15 do
  spec: same-site é tratado como suspeito num modelo de single-subdomain.
- [ ] **REQ-4**: GIVEN uma request GET sem header `Sec-Fetch-Site`
  (browser legado ou cliente non-browser), WHEN existem `Origin` ou
  `Referer` headers, THEN o guard faz fallback **origin-equality check**:
  candidate URL (Origin OR Referer) é parseado via `new URL()`; o
  `.origin` extraído (`scheme://host[:port]`, sem path) é comparado
  por igualdade exata contra `baseUrl`. Origin é preferido sobre
  Referer. `Origin: null` → reject `null-origin`. Não é prefix-match
  (`startsWith`) porque essa é vulnerável a substring attack
  (e.g. `https://app.tokenfx.io.evil.com` passaria um `startsWith`
  ingênuo) — TC-U-13 verifica.
- [ ] **REQ-5**: GIVEN uma request GET sem `Sec-Fetch-Site` E sem
  `Origin` E sem `Referer`, THEN o guard rejeita com
  `{ok: false, reason: 'missing-origin'}` → 403. Defensive default:
  browsers legítimos mandam pelo menos um dos três.
- [ ] **REQ-6**: GIVEN o guard rejeita, THEN o response é gerado ANTES
  de `auth()` ser chamado — i.e., requests cross-site nunca exercitam
  o auth flow, evitando leaks de info (existência de session, etc).
- [ ] **REQ-7**: GIVEN o guard aceita E o auth check passa, THEN o
  comportamento do route é IDÊNTICO ao current — mesmo CSV body, mesmo
  Content-Disposition, mesmo `X-TokenFx-Truncated` header. Anti-regressão:
  todos os 33+ TCs existentes continuam green com `makeReq()` injetando
  `sec-fetch-site: 'same-origin'` por default.

## Test Plan

### Unit Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-1 | happy | `Sec-Fetch-Site: same-origin` → ok | `{ok: true}` |
| TC-U-02 | REQ-1 | happy | `Sec-Fetch-Site: none` (typed URL / bookmark) → ok | `{ok: true}` |
| TC-U-03 | REQ-2 | security | `Sec-Fetch-Site: cross-site` → reject `cross-site` | `{ok: false, reason: 'cross-site'}` |
| TC-U-04 | REQ-3 | security | `Sec-Fetch-Site: same-site` → reject `same-site-rejected` | `{ok: false, reason: 'same-site-rejected'}` |
| TC-U-05 | REQ-4 | happy | no Sec-Fetch-Site + Origin matches baseUrl prefix → ok | `{ok: true}` |
| TC-U-06 | REQ-4 | security | no Sec-Fetch-Site + Origin = `null` → reject `null-origin` | `{ok: false, reason: 'null-origin'}` |
| TC-U-07 | REQ-4 | security | no Sec-Fetch-Site + Origin mismatch (`https://evil.com`) → reject `cross-origin` | `{ok: false, reason: 'cross-origin'}` |
| TC-U-08 | REQ-4 | happy | no Sec-Fetch-Site + no Origin + Referer matches baseUrl prefix → ok | `{ok: true}` |
| TC-U-09 | REQ-4 | security | no Sec-Fetch-Site + no Origin + Referer mismatch → reject `cross-origin` | `{ok: false, reason: 'cross-origin'}` |
| TC-U-10 | REQ-5 | security | no Sec-Fetch-Site + no Origin + no Referer → reject `missing-origin` | `{ok: false, reason: 'missing-origin'}` |
| TC-U-11a | REQ-4 | edge | unknown Sec-Fetch-Site value (e.g. `'future-value'`) + Origin matches baseUrl → falls through to Origin/Referer fallback → ok | `{ok: true}` |
| TC-U-11b | REQ-4 | security | unknown Sec-Fetch-Site value + no Origin + no Referer → falls through → reject `missing-origin` | `{ok: false, reason: 'missing-origin'}` |
| TC-U-12 | REQ-4 | edge | Origin matches baseUrl exactly (no trailing slash, no default port) → ok | `{ok: true}` |
| TC-U-13 | REQ-4 | security | Origin is `https://app.tokenfx.io.evil.com` (suffix-injection attack — prefix match would naively accept) → reject `cross-origin` | guard parses `new URL(origin).origin` and compares equality with `baseUrl`; `https://app.tokenfx.io.evil.com` ≠ `https://app.tokenfx.io` |
| TC-U-14 | REQ-4 | edge | Referer = `https://app.tokenfx.io/manager/audit-log` (same baseUrl with trailing path) → ok | `new URL(referer).origin` strips path, equals baseUrl |
| TC-U-15 | REQ-4 | edge | Origin = `https://app.tokenfx.io:443` (explicit default port), baseUrl = `https://app.tokenfx.io` → ok | `URL.origin` normalizes default ports — `https://app.tokenfx.io:443` resolves to `https://app.tokenfx.io` |

### Integration Tests (Route Handler)

Both routes have identical guard wiring. Integration TCs verify the
wiring in BOTH `exportAuditLogImpl` and `exportTeamRosterImpl`.

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-7 | happy | audit-log: request with `sec-fetch-site: same-origin` + valid session → 200 text/csv (no regression) | 200 + CSV body |
| TC-I-02 | REQ-2, REQ-6 | security | audit-log: `sec-fetch-site: cross-site` → 403 JSON `{error: {message, code: 'cross-site'}}`; `expect(authFnStub).not.toHaveBeenCalled()` before checking status; warn log fires once | 403 + JSON + auth not called |
| TC-I-03 | REQ-3 | security | audit-log: `sec-fetch-site: same-site` → 403 with `code: 'same-site-rejected'` | 403 + JSON |
| TC-I-04 | REQ-5 | security | audit-log: no Sec-Fetch-Site + no Origin + no Referer → 403 with `code: 'missing-origin'`; logged `sec_fetch_site` is the literal string `'<missing>'` (not `null`) | 403 + JSON + sentinel logged |
| TC-I-05 | REQ-7 | happy | team-roster: `sec-fetch-site: same-origin` + valid session → 200 text/csv | 200 + CSV body |
| TC-I-06 | REQ-2, REQ-6 | security | team-roster: `sec-fetch-site: cross-site` → 403 with `code: 'cross-site'`; `expect(authFnStub).not.toHaveBeenCalled()` | 403 + JSON + auth not called |
| TC-I-07a | REQ-2 | security | audit-log: privacy — warn log call's second arg matches `expect.objectContaining({route, reason, sec_fetch_site})` AND `expect.not.objectContaining({origin: …})` AND `expect.not.objectContaining({referer: …})`. Request seeded with `Origin: https://leak.example.com` + `Referer: https://leak.example.com/path` to ensure NO substring of those values appears in any log spy arg | structured payload only |
| TC-I-07b | REQ-2 | security | team-roster: same privacy assertion as TC-I-07a, mirrored on the team-roster route | structured payload only |
| TC-I-08 | REQ-1 | happy | audit-log: `sec-fetch-site: none` (typed URL / bookmark) + valid session → 200 text/csv | 200 + CSV body |
| TC-I-09 | REQ-1 | happy | team-roster: `sec-fetch-site: none` + valid session → 200 text/csv | 200 + CSV body |
| TC-I-10 | REQ-4 | security | audit-log: no Sec-Fetch-Site + `Origin: https://evil.example.com` → 403 with `code: 'cross-origin'` | 403 + JSON |
| TC-I-11 | REQ-4 | security | audit-log: no Sec-Fetch-Site + `Origin: null` → 403 with `code: 'null-origin'` | 403 + JSON |
| TC-I-12 | REQ-3 | security | team-roster: `sec-fetch-site: same-site` → 403 with `code: 'same-site-rejected'` (symmetric with TC-I-03) | 403 + JSON |
| TC-I-13 | REQ-5 | security | team-roster: no Sec-Fetch-Site + no Origin + no Referer → 403 with `code: 'missing-origin'` (symmetric with TC-I-04) | 403 + JSON |
| TC-I-14 | REQ-4 | security | team-roster: no Sec-Fetch-Site + `Origin: https://evil.example.com` → 403 with `code: 'cross-origin'` (symmetric with TC-I-10) | 403 + JSON |

### E2E Tests

N/A — guard behavior is fully exercised by unit + integration TCs.
No new user-visible UI in this spec; the existing CSV download UX is
preserved for same-origin requests.

## Design

### Architecture Decisions

1. **New helper module** `apps/server/lib/auth/same-origin-get-guard.ts`,
   sibling of `csrf-origin-guard.ts`. Both modules are Edge-runtime
   safe (no DB / Node-only imports). Naming intent: `csrf-origin-guard`
   is POST-oriented (Origin/Referer); `same-origin-get-guard` is
   GET-oriented (Sec-Fetch-Site primary).
   **Decision — directory placement**: stays in `lib/auth/` despite
   not being strictly auth-specific. Rationale: (a) `HasHeaderGetter`
   type coupling with `csrf-origin-guard.ts`; (b) operational context
   is CSRF defense (auth-adjacent); (c) keeps the two CSRF guards
   co-located for easy discovery by future maintainers.
   **Decision — `Sec-Fetch-Mode` / `Sec-Fetch-Dest` ignored**: the
   Fetch Metadata Spec also defines `Sec-Fetch-Mode` (`navigate` /
   `no-cors` / `cors` / `same-origin`) and `Sec-Fetch-Dest` (`document`,
   `empty`, ...). `Sec-Fetch-Site` alone is sufficient for this threat
   (cross-origin navigation/fetch from `<a href>` or `fetch()`); Mode
   and Dest add no signal not already present in Site. Layering them
   would create false-negatives without improving the security model.

2. **Public surface**:

   ```ts
   import type { HasHeaderGetter } from './csrf-origin-guard';

   export type SameOriginGetReason =
     | 'cross-site'
     | 'same-site-rejected'
     | 'cross-origin'
     | 'null-origin'
     | 'missing-origin';

   export type CheckSameOriginGetResult =
     | { ok: true }
     | { ok: false; reason: SameOriginGetReason };

   export const checkSameOriginGet = (
     request: HasHeaderGetter,
     baseUrl: string,
   ): CheckSameOriginGetResult;
   ```

   Re-exports `HasHeaderGetter` shape — same minimal contract as the
   POST guard (NextRequest, global Request, hand-written test stubs).
   **Decision — custom Result shape (`{ok, reason}`) instead of canonical
   `Result<void, SameOriginGetReason>` from `lib/result.ts`**: matches
   the existing `CheckSigninOriginResult` convention in
   `csrf-origin-guard.ts` (`reason` field name, not `error`). Both
   CSRF guards using the same tagged-union shape keeps the call-site
   ergonomics consistent (`if (!result.ok) ... result.reason ...`).
   Future cleanup could unify both to `Result<void, E>` in a refactor
   spec, but adopting it asymmetrically here would create drift.

3. **Decision matrix** (locked):

   ```text
   Sec-Fetch-Site = 'same-origin'    → ok
   Sec-Fetch-Site = 'none'           → ok (typed URL / bookmark / new tab)
   Sec-Fetch-Site = 'same-site'      → reject 'same-site-rejected'
   Sec-Fetch-Site = 'cross-site'     → reject 'cross-site'
   Sec-Fetch-Site = unknown value    → fall through to Origin/Referer (forward-compat)
   Sec-Fetch-Site = missing          → fall through to Origin/Referer

   Fallback (Origin/Referer):
     Origin = 'null'                            → reject 'null-origin'
     Origin = baseUrl-prefix-match              → ok
     Origin = mismatch                          → reject 'cross-origin'
     Origin missing AND Referer prefix-match    → ok
     Origin missing AND Referer mismatch        → reject 'cross-origin'
     Origin missing AND Referer missing         → reject 'missing-origin'
   ```

   The fallback Origin/Referer handling is an **independent
   implementation — stricter than `checkSigninOrigin` by design**: the
   POST guard uses `startsWith(baseUrl)`; the GET guard uses
   `new URL(candidate).origin === baseUrl` (exact equality after URL
   parsing). The stricter check defends against suffix-injection
   attacks (TC-U-13) without breaking trailing-path Referer values
   (TC-U-14 — `URL.origin` strips path/query). Future maintainers must
   NOT "sync" this back to `startsWith`.

4. **Route wiring** — insert AT THE TOP of both `exportAuditLogImpl`
   and `exportTeamRosterImpl`, BEFORE `authFn()` call:

   ```ts
   // `new URL(req.url).origin` works for both NextRequest (production)
   // and global Request (audit-log test path). Both expose `.url` as an
   // absolute URL string; `URL.origin` normalizes default ports. Behind a
   // reverse proxy, this returns whatever the Next.js runtime resolved
   // from `host` / `x-forwarded-host` — same source the existing route
   // uses for filename construction (no behavior drift).
   const baseUrl = new URL(req.url).origin;
   const guard = checkSameOriginGet(req, baseUrl);
   if (!guard.ok) {
     logger.warn('csv-export csrf blocked', {
       route: '/manager/audit-log/export',  // hardcoded per route
       reason: guard.reason,
       sec_fetch_site: req.headers.get('sec-fetch-site') ?? '<missing>',
       // Intentionally NO origin/referer values — those may include
       // sensitive third-party URLs. Structured payload keys are the
       // ONLY thing logged; do not spread `request` or accept ad-hoc
       // fields here.
     });
     return new Response(
       JSON.stringify({ error: { message: 'cross-origin request blocked', code: guard.reason } }),
       { status: 403, headers: { 'content-type': 'application/json' } },
     );
   }
   const session = await deps.authFn();
   // ... existing flow ...
   ```

5. **baseUrl derivation**: `new URL(req.url).origin` produces
   `https://app.tokenfx.io` (no path, no trailing slash). Same shape as
   what `csrf-origin-guard` expects (no trailing path). Consistent with
   the existing route code that uses `new URL(req.url)` for filename
   construction.

6. **Substring-attack guard (TC-U-13)**: the prefix-match uses
   `candidate.startsWith(baseUrl)` BUT this naively accepts
   `https://app.tokenfx.io.evil.com` (suffix injection). Mitigation
   already baked in: `Origin` headers are always `scheme://host[:port]`
   with no path — a malicious origin can never have `app.tokenfx.io.X`
   as a sub-component of its own origin and pass equality. To be
   strict, the implementation parses `candidate` as URL and compares
   `.origin` to `baseUrl` (exact equality, NOT prefix). This is
   stricter than `checkSigninOrigin`'s prefix-match — locked: use URL
   equality for the GET guard, since we're not dealing with Referer
   trailing-path cases for Origin. For Referer (which DOES have a
   trailing path), use prefix-match-on-baseUrl-only.

   Concretely:

   ```ts
   const tryUrlOrigin = (raw: string): string | null => {
     try {
       return new URL(raw).origin;
     } catch {
       return null;
     }
   };

   const checkOrigin = (origin: string, baseUrl: string): boolean => {
     const candidateOrigin = tryUrlOrigin(origin);
     return candidateOrigin !== null && candidateOrigin === baseUrl;
   };

   const checkReferer = (referer: string, baseUrl: string): boolean => {
     const refererOrigin = tryUrlOrigin(referer);
     return refererOrigin !== null && refererOrigin === baseUrl;
   };
   ```

   Both use `new URL(...).origin` which strips path/query/fragment and
   normalizes to `scheme://host[:port]`. Comparison is exact-string
   equality — cannot be subverted by suffix injection.

7. **`logger.warn` privacy**: log includes `route`, `reason`,
   `sec_fetch_site` (a fixed-cardinality enum value, NOT a URL). Origin
   and Referer header VALUES are deliberately omitted — they may
   contain sensitive customer URLs / referring paths.

8. **Test helper update** — the two test files have DIFFERENT helpers
   with different names and return shapes:
   - `apps/server/app/manager/audit-log/export/route.test.ts` uses
     `makeRequest(url?: string): Request` — builds **global `Request`**.
   - `apps/server/app/manager/teams/[id]/export/route.test.ts` uses
     `makeReq(search?: string): NextRequest` — builds **`NextRequest`**.

   Both need an additive `headerOverrides` parameter that defaults to
   injecting `sec-fetch-site: 'same-origin'`. Existing 33+ TCs (across
   both files) work unchanged because the default is the happy path;
   new TCs override the header explicitly.

   ```ts
   // audit-log/export/route.test.ts
   const makeRequest = (
     url: string = 'http://localhost/manager/audit-log/export',
     headerOverrides: Record<string, string> = {},
   ): Request =>
     new Request(url, {
       method: 'GET',
       headers: new Headers({ 'sec-fetch-site': 'same-origin', ...headerOverrides }),
     });

   // teams/[id]/export/route.test.ts
   const makeReq = (
     search = '',
     headerOverrides: Record<string, string> = {},
   ): NextRequest => {
     const url = `http://localhost/manager/teams/${TEAM_ID}/export${search}`;
     return new NextRequest(url, {
       headers: new Headers({ 'sec-fetch-site': 'same-origin', ...headerOverrides }),
     });
   };
   ```

   **Decision — duplication not consolidated**: the two helpers stay
   colocated in their respective test files. A shared helper would
   require a new `apps/server/tests/helpers/` module that doesn't exist
   yet; introducing it for 2 callers is premature. If a third CSV
   export route lands, the cleanup is straightforward (mechanical
   extraction). This is documented so reviewers don't flag the
   duplication as oversight.

9. **NO change** to:
   - `csrfWrap` in `app/api/auth/[...nextauth]/route.ts` (POST-only).
   - Other GET Route Handlers in the codebase. Locked: scope is the
     2 CSV export routes. If a future spec wants org-wide GET CSRF
     protection (e.g. via middleware), it can adopt this helper.

   **Decision — middleware approach considered + rejected**: the
   existing `apps/server/middleware.ts` is a thin NextAuth adapter
   (`export const { auth: middleware } = NextAuth(authConfig)`).
   Extending it for per-path Sec-Fetch-Site checks would couple CSRF
   defense to the auth bootstrap and complicate the Edge-runtime
   constraints already documented there. Higher-quality alternative
   (per-route wiring) is chosen because: (a) the guard is independently
   testable as a pure function; (b) adding middleware logic for 2 routes
   creates more cross-cutting risk than 2 small handler edits; (c)
   future scaling to N routes can adopt a `withSameOriginGuard(handler)`
   wrapper without refactoring middleware. **Trade-off acknowledged**:
   per-route wiring is opt-in; a future GET route added to `/manager/*`
   that streams PII could forget the guard. Mitigation: SECURITY.md §8
   addendum (out of scope here) should document the convention.

### Files to Create

- `apps/server/lib/auth/same-origin-get-guard.ts`
- `apps/server/lib/auth/same-origin-get-guard.test.ts`

### Files to Modify

- `apps/server/app/manager/audit-log/export/route.ts` (insert guard at top of `exportAuditLogImpl`)
- `apps/server/app/manager/audit-log/export/route.test.ts` (update `makeReq()` to default `sec-fetch-site: 'same-origin'`; add 3 new TCs)
- `apps/server/app/manager/teams/[id]/export/route.ts` (insert guard at top of `exportTeamRosterImpl`)
- `apps/server/app/manager/teams/[id]/export/route.test.ts` (update `makeReq()`; add 3 new TCs)

### Dependencies

None — pure-JS helper, uses built-in `URL` constructor + `Headers`.
No new npm packages.

## Tasks

- [x] **TASK-1**: Create `lib/auth/same-origin-get-guard.ts` + unit tests.
  - files: `apps/server/lib/auth/same-origin-get-guard.ts`, `apps/server/lib/auth/same-origin-get-guard.test.ts`
  - tests: TC-U-01, TC-U-02, TC-U-03, TC-U-04, TC-U-05, TC-U-06, TC-U-07, TC-U-08, TC-U-09, TC-U-10, TC-U-11a, TC-U-11b, TC-U-12, TC-U-13, TC-U-14, TC-U-15

- [x] **TASK-2**: Wire guard into `audit-log/export/route.ts`; update `makeRequest()` helper (defaults `sec-fetch-site: same-origin`); add 7 new route-level TCs.
  - files: `apps/server/app/manager/audit-log/export/route.ts`, `apps/server/app/manager/audit-log/export/route.test.ts`
  - depends: TASK-1
  - tests: TC-I-01, TC-I-02, TC-I-03, TC-I-04, TC-I-07a, TC-I-08, TC-I-10, TC-I-11

- [x] **TASK-3**: Wire guard into `teams/[id]/export/route.ts`; update `makeReq()` helper (defaults `sec-fetch-site: same-origin`); add 6 new route-level TCs. **Pattern**: mirror TASK-2. Verify the `route:` label in `logger.warn` is `/manager/teams/[id]/export` (NOT the audit-log path); the `route` string is the only literal that should differ between the two route handler wirings.
  - files: `apps/server/app/manager/teams/[id]/export/route.ts`, `apps/server/app/manager/teams/[id]/export/route.test.ts`
  - depends: TASK-1
  - tests: TC-I-05, TC-I-06, TC-I-07b, TC-I-09, TC-I-12, TC-I-13, TC-I-14

## Parallel Batches

Classification:

- TASK-1 has no deps (foundation).
- TASK-2 and TASK-3 both depend on TASK-1 but touch disjoint files (different route + test pairs). Safe to parallel.

```text
Batch 1: [TASK-1]                — helper module + unit tests
Batch 2: [TASK-2, TASK-3]         — parallel route wiring (disjoint files)
```

## Validation Criteria

- [ ] `pnpm typecheck` passes (apps/server).
- [ ] `pnpm lint` passes.
- [ ] `pnpm test --run` passes — anti-regression: existing 33+ CSV route TCs stay green via `makeReq()` injecting `sec-fetch-site: same-origin` by default.
- [ ] `pnpm build` passes.
- [ ] **Live validation**:
  - With dev server running (`pnpm dev` in apps/server), curl the audit-log export from a same-origin context (browser dev tools or curl with `Origin: http://localhost:3000` header) → 200 + CSV body.
  - curl WITHOUT any Sec-Fetch-Site/Origin/Referer headers → 403 + JSON error body.
  - curl with `Sec-Fetch-Site: cross-site` header → 403 + JSON.
  - curl with `Sec-Fetch-Site: same-site` header → 403 + JSON.
- [ ] **Privacy invariant verified**: `grep -n "logger\." apps/server/lib/auth/same-origin-get-guard.ts | grep -iE "origin|referer"` returns 0 matches — i.e., NO `logger.*` call references the Origin/Referer header values. (Structural reads like `const origin = request.headers.get('origin')` are expected outside logger calls and must NOT be flagged.)

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->

### TASK-1 (2026-05-12 14:17)
TDD: RED(0 tests collected — module not found) → GREEN(16/16). `same-origin-get-guard.ts` helper + 16 unit TCs (TC-U-01..15 + 1 defensive "unparseable Origin"). Pure helper, no IO, Edge-runtime safe.

### TASK-2 (2026-05-12 14:22)
Wired `checkSameOriginGet` into `exportAuditLogImpl` before `authFn()`. Updated `makeRequest()` to default `sec-fetch-site: same-origin` + added `makeRequestNoFetchSite()` for CSRF-specific tests. Migrated 3 inline `new Request(...)` callsites to `makeRequest(url)`. Added 7 new TCs (TC-I-01..04, 07a, 08, 10, 11). Final: 22/22.

### TASK-3 (2026-05-12 14:24)
Wired `checkSameOriginGet` into `exportTeamRosterImpl` before `authFn()`. Added `crossOriginBlocked()` JSON response helper matching audit-log envelope. Updated `makeReq()` + added `makeReqNoFetchSite()`. Added 7 new TCs (TC-I-05, 06, 07b, 09, 12, 13, 14). Final: 22/22.

### Integration test helper fixes (2026-05-12 14:28)
After Batch 2 merge, 10 testcontainers-backed integration tests failed because they constructed raw Request/NextRequest without the guard's required header. Updated `makeRequest` (audit-log-csv.test.ts) + `makeReq` (team-roster-csv.test.ts) to inject `sec-fetch-site: same-origin` by default. Both suites re-GREEN.

### Final validation (2026-05-12 14:28)
- typecheck: clean
- 1159 passed / 10 skipped / 1 pre-existing flake (`aggregate-team-outcomes.test.ts:233` TC-I-04b — unrelated)
- Privacy invariant: TC-I-07a/07b assert structured payload + no Origin/Referer in any log call.
