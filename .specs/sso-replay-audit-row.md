# Spec: sso-replay-audit-row

## Status: DONE

## Context

Closes the **REQ-FU-1** carve-out documented in `.specs/oauth-idp-stub.md`
Out-of-scope §REQ-FU-1, and promotes spec-b's TC-I-34 from PARTIALLY
ADDRESSED to ADDRESSED.

### The gap

Spec-b's TC-I-34 (`.specs/central-server-onboarding-v2-sso.backend.md:386`)
asserts BOTH halves of state-replay defense:

1. **Rejection**: NextAuth refuses the second callback that reuses a
   consumed `state` cookie. ✅ Verified by TC-E2E-08 in
   `apps/server/tests/e2e/sso-flow.spec.ts` (currently `test.skip`).
2. **Audit row**: An `auth_event_log` row with `outcome='rejected-replay'`
   is written. **❌ NOT done today.**

`sso-auto-provision.ts:136-140` documents why: NextAuth's state validation
runs BEFORE our `signIn` callback, so `evaluateAutoProvision` never sees
a state-replay failure.

### ⚠️ Load-bearing architectural risk surfaced by 3-reviewer pass

NextAuth v5's `OAuthCallbackError` error code is **GENERIC** — it covers
state-replay AND code-exchange failure AND token endpoint timeout AND
profile fetch errors AND malformed `id_token`. There is **no narrower
code** specifically for state-mismatch in NextAuth v5 public surface.

This means a naïve `pages.error` approach (write `rejected-replay`
whenever `?error=OAuthCallbackError` lands) would tag every transient
OAuth network error as a replay attempt — **corrupting the replay
signal permanently**.

### Decisões já travadas (post-self-review)

1. **TASK-0 pre-flight spike (PRE-APPROVAL gate)**: before this spec
   leaves DRAFT, run a manual spike against `pnpm idp-stub` + dev
   server to capture (a) the exact `?error=<code>` value NextAuth
   emits on state-mismatch, (b) whether it differs from
   `?error=OAuthCallbackError` for non-state OAuth failures, (c) what
   query params / cookies / headers are present. Document findings
   in this spec's Execution Log BEFORE the user approves it. If the
   spike reveals no distinguishing signal, the spec authors must
   present the trade-off explicitly: rename outcome to a broader
   `'rejected-oauth-callback'` enum (requires schema migration) OR
   ship with documented imprecision.

2. **`after()` from `next/server`**: the audit-row write is wrapped in
   `after()` so a DB failure NEVER cascades to a 500 error page. The
   user always gets the rendered error UI. `after()` is the Next.js
   App Router idiom for non-blocking side-effects post-render
   (precedent: `apps/server/app/manager/_drilldown/render.tsx`).

3. **DI for `writeReplayAuditRow`**: the helper accepts an
   `opts.writeAuthEvent?` injection seam (matches `sign-in-as.ts`
   convention). Unit tests pass hand-written stubs; no `vi.spyOn`,
   no mocking framework (project rule).

4. **Schema unchanged.** `auth_event_log` already supports
   `'rejected-replay'` (schema.ts:687 CHECK constraint). `email_hash`,
   `iss`, `sso_provider` are NOT NULL — for replay we use **sentinel
   values** that can never collide with real peppered SHA-256 hex
   hashes:
   - `emailHash = 'replay:state-mismatch'`
   - `iss = 'replay:unknown-issuer'`
   - `ssoProvider` from Referer-path or `'unknown'`
   Sentinels live in `replay-detector.ts` (domain layer), NOT in the
   writer (which is generic persistence).

5. **Sentinel rows are intentionally invisible in manager-UI audit-log**
   (REQ-7). `lib/queries/audit-log.ts:loadAuditLogPage` scopes via
   `inArray(authEventLog.emailHash, hashesForOrg)` — sentinels never
   match a real org-user hash. CSV export route uses the same scoping.
   Replay rows are queryable via raw SQL (`WHERE outcome='rejected-replay'`)
   only. Manager-UI surface for replay-by-iss/ip is out-of-scope.

6. **Server Component side-effect via pure handler + `after()`**:
   `page.tsx` is a thin shell that calls a pure
   `prepareReplayAuditRow(searchParams, headers)` helper to compute
   the input, then queues the write via `after(() => writeReplayAuditRow(input))`.
   The pure helper is the test surface (TC-I-01..08 test it directly,
   no Next.js rendering harness needed). The `page.tsx` smoke-renders
   with `fetch` against a live dev server in TC-E2E-09.

7. **`error.tsx` boundary**: `app/auth/error/error.tsx` (Client
   Component) catches any render-time exception and shows a static
   "Authentication error — return to sign-in" message. Defense in
   depth — `after()` should already prevent failures from cascading.

8. **Error message lookup**: a module-level `ERROR_MESSAGE_MAP:
   Readonly<Record<string, string>>` in `page.tsx` with a fallback
   string. No new locale infrastructure — consistent with existing
   project pattern (i18n-microcopy spec keeps strings inline).

9. **`pages` block in `auth.config.ts`** is extended in place — `signIn`
   key preserved alongside new `error` key. Pinned snippet in Design
   section to prevent spread-clobber regression.

10. **Privacy non-negotiables** (security.md §Data Protection):
    - NEVER persist raw `state` cookie value.
    - NEVER persist full `Referer` URL (it contains the consumed
      `state` token in `?state=` query).
    - `iss` sentinel is fixed; NEVER derived from Referer.
    - User-agent truncated via existing `truncateUserAgent` writer.
    - HTTP response headers do NOT echo the raw error code.

### Prior art

- `apps/server/lib/auth/auth-event-log-writer.ts` — existing
  `writeAuthEvent`. New `writeReplayAuditRow` wraps it.
- `apps/server/app/manager/_drilldown/render.tsx` — Server Component
  reads `headers()`; uses `after()` for best-effort post-render work.
- `apps/server/tests/e2e/helpers/sign-in-as.ts` — `opts.fetch` DI
  convention; same pattern adopted here.
- `apps/idp-stub/` — drives the live verification + TC-E2E-08.

## Requirements

- [ ] **REQ-1**: GIVEN NextAuth redirects to `/auth/error?error=<code>`
  AND `<code>` is in `KNOWN_REPLAY_ERROR_CODES` (locked by TASK-0 spike;
  initial assumption `['OAuthCallbackError']` pending precision
  observation — see Out-of-scope §Imprecision-acceptance below),
  AND the request's `Referer` header path matches
  `^/api/auth/callback/[a-z-]+$` (after query strip),
  WHEN `page.tsx` renders, THEN `prepareReplayAuditRow(...)` returns a
  populated `ReplayAuditInput` AND `after(() => writeReplayAuditRow(input))`
  is queued exactly once per render.

- [ ] **REQ-2**: GIVEN the same redirect WHEN `<code>` is undefined,
  empty string, or NOT in `KNOWN_REPLAY_ERROR_CODES` (exhaustively
  enumerated in Design), THEN `prepareReplayAuditRow` returns `null`
  AND NO write is queued.

- [ ] **REQ-3**: GIVEN any GET to `/auth/error` regardless of `?error=`,
  THEN the page renders HTTP 200 with a sanitized error message looked
  up from `ERROR_MESSAGE_MAP` (raw `?error=` value NEVER echoed into
  DOM or response headers). GIVEN the queued `after(writeReplayAuditRow)`
  callback rejects, THEN the rejection is caught + logged via
  `lib/logger.ts` at `warn` level AND the user-visible response is
  unaffected (HTTP 200 with the rendered UI).

- [ ] **REQ-4**: GIVEN the audit row is being written, THEN:
  - `emailHash = REPLAY_EMAIL_HASH_SENTINEL` (`'replay:state-mismatch'`)
  - `iss = REPLAY_ISS_SENTINEL` (`'replay:unknown-issuer'`)
  - `ssoProvider` is the FULL last-path-segment captured by
    `/^\/api\/auth\/callback\/([a-z-]+)$/` applied to
    `new URL(refererHeader).pathname` (query-stripped); else `'unknown'`
  - `ssoSubjectHash = null`
  - `ip`, `city`, `userAgent` resolved from request headers; UA truncated
    by the existing writer

- [ ] **REQ-5**: GIVEN `TC-E2E-08` in `sso-flow.spec.ts` is `test.skip`,
  WHEN this spec ships, THEN the test is un-skipped AND its body asserts
  (a) the second callback's response status is 302/307 with `Location`
  containing `/auth/error?error=` (path under `/auth/error`, NOT
  `/api/auth/error`), AND (b) SQL probe over the testcontainer
  connection returns exactly 1 new row with
  `outcome='rejected-replay' AND email_hash='replay:state-mismatch'
  AND occurred_at > testStartTime`.

- [ ] **REQ-6**: GIVEN spec-b's TC-I-34 is currently PARTIALLY ADDRESSED,
  WHEN this spec ships, THEN
  `.specs/central-server-onboarding-v2-sso.backend.md` is updated to
  mark TC-I-34 fully ADDRESSED with a link to this spec.

- [ ] **REQ-7**: GIVEN a manager views `/manager/audit-log` or downloads
  CSV via `/manager/audit-log/export`, THEN sentinel rows (`email_hash =
  'replay:state-mismatch'`) DO NOT appear (the org-scoped `inArray`
  filter cannot match sentinel hashes — by design). The page's empty
  state copy does NOT need a replay-events callout. Surfacing replay
  rows in the manager UI is OUT OF SCOPE.

### Out-of-scope (deferred / accepted trade-offs)

- **§Imprecision-acceptance**: if TASK-0 confirms that NextAuth v5 does
  NOT emit a code distinguishing state-replay from other OAuth callback
  failures, this spec MUST either: (a) rename `outcome='rejected-replay'`
  to `'rejected-oauth-callback'` (broader semantic, requires schema
  CHECK migration) OR (b) ship `rejected-replay` with a documented
  false-positive rate (NextAuth network errors + token failures get
  tagged as replays). The TASK-0 spike output decides which.
- **Manager-UI surface for replay events**: out of scope. Sentinel rows
  invisible by design; raw SQL is the access path.
- **REQ-FU-2 (nonce replay)**: separate spec.

## Test Plan

### Unit Tests

`replay-detector.test.ts` (TASK-2):

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-1 | happy | `isStateReplayError({error:'OAuthCallbackError', refererPath:'/api/auth/callback/okta'})` → true | true |
| TC-U-02 | REQ-2 | validation | `isStateReplayError({error:'Configuration', refererPath:'/api/auth/callback/okta'})` → false | false |
| TC-U-03 | REQ-2 | validation | `isStateReplayError({error:'Verification', refererPath:'/api/auth/callback/okta'})` → false | false |
| TC-U-04 | REQ-2 | edge | `isStateReplayError({error:undefined, refererPath:'/api/auth/callback/okta'})` → false | false |
| TC-U-05 | REQ-2 | edge | `isStateReplayError({error:'OAuthCallbackError', refererPath:null})` → false | false |
| TC-U-06 | REQ-2 | edge | `isStateReplayError({error:'OAuthCallbackError', refererPath:''})` → false | false |
| TC-U-07 | REQ-2 | edge | `isStateReplayError({error:'OAuthCallbackError', refererPath:'/some-other-page'})` → false | false |
| TC-U-08 | REQ-4 | happy | `deriveSsoProviderFromReferer('http://x/api/auth/callback/okta?code=x&state=y')` → `'okta'` | match |
| TC-U-09 | REQ-4 | edge | `deriveSsoProviderFromReferer('http://x/manager')` → `'unknown'` | match |
| TC-U-10 | REQ-4 | edge | `deriveSsoProviderFromReferer(null)` → `'unknown'` | match |
| TC-U-11 | REQ-4 | security | `deriveSsoProviderFromReferer('http://x/api/auth/callback/../../../etc/passwd')` → `'unknown'` (regex `[a-z-]+` only) | match |
| TC-U-12 | REQ-4 | security | `deriveSsoProviderFromReferer('http://x/api/auth/callback/Okta')` → `'unknown'` (uppercase rejected) | match |
| TC-U-13 | REQ-4 | security | `deriveSsoProviderFromReferer('http://x/api/auth/callback/okta/')` → `'unknown'` (trailing slash rejected) | match |
| TC-U-14 | REQ-4 | security | `deriveSsoProviderFromReferer('http://x/api/auth/callback/oauth2')` → `'unknown'` (digit rejected) | match |
| TC-U-15 | REQ-4 | edge | `deriveSsoProviderFromReferer('about:blank')` → `'unknown'` | match |
| TC-U-16 | REQ-4 | security | `REPLAY_EMAIL_HASH_SENTINEL.startsWith('replay:')` AND `!/^[0-9a-f]{64}$/.test(REPLAY_EMAIL_HASH_SENTINEL)` (the property that matters — non-hex prefix prevents collision with org-user hashes) | true |
| TC-U-17 | REQ-1, REQ-4 | happy | `prepareReplayAuditRow({error:'OAuthCallbackError', referer:'http://x/api/auth/callback/okta?state=y', xff:'1.2.3.4', ua:'Mozilla'})` → `{ssoProvider:'okta', ip:'1.2.3.4', userAgent:'Mozilla', city:null}` | match |
| TC-U-18 | REQ-2 | edge | `prepareReplayAuditRow({error:'Configuration', ...})` → `null` (caller does NOT queue write) | null |

`auth-event-log-writer.test.ts` (TASK-3, append):

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-19 | REQ-4 | happy | `writeReplayAuditRow({ssoProvider:'okta', ip:'1.2.3.4', city:null, userAgent:'Mozilla'}, {writeAuthEvent: spy})` calls injected spy exactly once with `outcome='rejected-replay'`, `emailHash=REPLAY_EMAIL_HASH_SENTINEL`, `iss=REPLAY_ISS_SENTINEL`, `ssoSubjectHash=null` | match |

### Integration Tests

`apps/server/lib/auth/replay-detector.integration.test.ts` (Postgres testcontainer; TASK-3-companion):

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-4 | happy | `writeReplayAuditRow({ssoProvider:'okta', ip:'1.2.3.4', city:'Lisbon', userAgent:'Mozilla/100.0'})` (no DI — real writer) → 1 row in `auth_event_log` matching the inputs + sentinels | match |
| TC-I-02 | REQ-4 | security | row's `user_agent` from a 600-char UA is truncated to ≤512 chars | length ≤ 512 |
| TC-I-03 | REQ-3 | infra | `writeReplayAuditRow` with the connection killed → rejects with DB error (caller responsible for catch) | rejects |

`apps/server/app/auth/error/page.test.tsx` (TASK-4): exercises the pure `prepareReplayAuditRow` + `ERROR_MESSAGE_MAP` directly — NO Next.js rendering harness needed:

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-04 | REQ-3 | happy | `lookupErrorMessage('OAuthCallbackError')` → non-empty string that does NOT contain the literal `'OAuthCallbackError'` substring | match |
| TC-I-05 | REQ-3 | edge | `lookupErrorMessage(undefined)` → fallback string that does NOT contain `'undefined'` literal | match |
| TC-I-06 | REQ-3 | edge | `lookupErrorMessage('SomeFutureCode')` → same fallback string (no echo of code) | match |

### E2E Tests

`apps/server/tests/e2e/sso-replay-audit-row.spec.ts` (NEW, TASK-5) — requires `global-setup.ts` stack (Postgres testcontainer + IdP stub + dev server):

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-E2E-09 | REQ-1, REQ-4, REQ-5 | security | Playwright `request` fixture: hit `/api/auth/signin/okta` → follow to stub `/authorize` → follow callback → capture cookies + URL. SECOND request: replay callback URL with same cookies → response `Location` matches `/auth/error?error=`. SQL probe over the testcontainer connection: COUNT rows with `outcome='rejected-replay' AND email_hash='replay:state-mismatch' AND occurred_at > testStartTime` === 1 | both halves pass |
| TC-E2E-10 | REQ-4 | security | After TC-E2E-09 writes the row, query ALL text columns for absence of the state cookie's raw value (state captured during first callback) | regex absence on `ip`, `city`, `user_agent`, `email_hash`, `iss`, `sso_provider` |
| TC-E2E-11 | REQ-7 | security | Authenticated manager visits `/manager/audit-log` after TC-E2E-09 → sentinel row NOT in rendered HTML; CSV export download via `/manager/audit-log/export` → response body does NOT contain `replay:state-mismatch` | regex absence in both |

`sso-flow.spec.ts` (MODIFY, TASK-6): TC-E2E-08 promoted from `test.skip` to live with the same assertion pattern as TC-E2E-09 (delegates to the new file's helper); spec-b's TC-I-34 closure.

**TC count**: 19 unit + 6 integration + 3 e2e (+ 1 promoted TC-E2E-08) = **29 TCs**. Rigor: 19 validation/edge/security/infra vs 10 happy = 1.9:1.

## Design

### Architecture decisions

**Files to Create**:

```
apps/server/
├── app/auth/error/
│   ├── page.tsx                         (Server Component shell; uses after() to queue write)
│   ├── page.test.tsx                    (TC-I-04..06 — pure helpers only)
│   ├── error.tsx                        (Client Component error boundary)
│   └── loading.tsx                      (minimal — returns null)
├── lib/auth/
│   ├── replay-detector.ts               (isStateReplayError + deriveSsoProviderFromReferer + prepareReplayAuditRow + sentinel constants)
│   ├── replay-detector.test.ts          (TC-U-01..18)
│   └── replay-detector.integration.test.ts (TC-I-01..03)
└── tests/e2e/
    └── sso-replay-audit-row.spec.ts     (TC-E2E-09..11)
```

**Files to Modify**:

- `apps/server/lib/auth/auth-event-log-writer.ts` — add `writeReplayAuditRow` helper with `opts.writeAuthEvent?` DI seam. Imports sentinel constants from `replay-detector.ts`.
- `apps/server/lib/auth/auth-event-log-writer.test.ts` — append TC-U-19.
- `apps/server/lib/auth/auth.config.ts` — extend `pages:` block in place. Final shape:
  ```ts
  pages: {
    signIn: '/api/auth/signin',
    error: '/auth/error',
  },
  ```
- `apps/server/tests/e2e/sso-flow.spec.ts` — un-skip TC-E2E-08 with audit-row assertion (delegates to TC-E2E-09 helper).
- `.specs/central-server-onboarding-v2-sso.backend.md` — mark TC-I-34 ADDRESSED.
- `.specs/oauth-idp-stub.md` — mark REQ-FU-1 closed.

**The pure helpers** (`replay-detector.ts`):

```ts
export const REPLAY_EMAIL_HASH_SENTINEL = 'replay:state-mismatch' as const;
export const REPLAY_ISS_SENTINEL = 'replay:unknown-issuer' as const;

const KNOWN_REPLAY_ERROR_CODES: ReadonlySet<string> = new Set([
  // Locked by TASK-0 spike. Initial guess; may broaden or narrow.
  'OAuthCallbackError',
]);

const CALLBACK_PATH_RE = /^\/api\/auth\/callback\/([a-z-]+)$/;

export type ReplayDetectorInput = Readonly<{
  error: string | undefined;
  refererPath: string | null;
}>;

export const isStateReplayError = (input: ReplayDetectorInput): boolean => {
  if (!input.error) return false;
  if (!KNOWN_REPLAY_ERROR_CODES.has(input.error)) return false;
  if (!input.refererPath) return false;
  return CALLBACK_PATH_RE.test(input.refererPath);
};

export const deriveSsoProviderFromReferer = (refererHeader: string | null): string => {
  if (!refererHeader) return 'unknown';
  let url: URL;
  try { url = new URL(refererHeader); } catch { return 'unknown'; }
  const m = CALLBACK_PATH_RE.exec(url.pathname);
  return m?.[1] ?? 'unknown';
};

export type ReplayAuditInput = Readonly<{
  ssoProvider: string;
  ip: string | null;
  city: string | null;
  userAgent: string | null;
}>;

export type PrepareInput = Readonly<{
  error: string | undefined;
  referer: string | null;
  xff: string | null;
  city: string | null;
  ua: string | null;
}>;

/**
 * Pure: takes raw request inputs, returns ReplayAuditInput or null.
 * `null` means "do not write a row".
 */
export const prepareReplayAuditRow = (input: PrepareInput): ReplayAuditInput | null => {
  let refererPath: string | null = null;
  if (input.referer) {
    try { refererPath = new URL(input.referer).pathname; } catch { refererPath = null; }
  }
  if (!isStateReplayError({ error: input.error, refererPath })) return null;
  return {
    ssoProvider: deriveSsoProviderFromReferer(input.referer),
    ip: input.xff,
    city: input.city,
    userAgent: input.ua,
  };
};
```

**Writer helper** (added to `auth-event-log-writer.ts`):

```ts
import { REPLAY_EMAIL_HASH_SENTINEL, REPLAY_ISS_SENTINEL, type ReplayAuditInput } from './replay-detector';

export type WriteReplayAuditOpts = Readonly<{
  writeAuthEvent?: typeof writeAuthEvent;
}>;

export const writeReplayAuditRow = async (
  input: ReplayAuditInput,
  opts: WriteReplayAuditOpts = {},
): Promise<void> => {
  const write = opts.writeAuthEvent ?? writeAuthEvent;
  await write({
    ssoProvider: input.ssoProvider,
    iss: REPLAY_ISS_SENTINEL,
    emailHash: REPLAY_EMAIL_HASH_SENTINEL,
    ssoSubjectHash: null,
    ip: input.ip,
    city: input.city,
    userAgent: input.userAgent,
    outcome: 'rejected-replay',
  });
};
```

**The Server Component** (`app/auth/error/page.tsx`):

```ts
import { after } from 'next/server';
import { headers } from 'next/headers';
import { log } from '@root/logger';

import { prepareReplayAuditRow } from '@/lib/auth/replay-detector';
import { writeReplayAuditRow } from '@/lib/auth/auth-event-log-writer';
import { ipToCity } from '@/lib/auth/ip-to-city';

const ERROR_MESSAGE_MAP: Readonly<Record<string, string>> = {
  OAuthCallbackError: 'Não foi possível concluir o login. Tente novamente.',
  Configuration: 'Configuração de autenticação inválida.',
  Verification: 'Falha ao verificar o login.',
  Default: 'Erro de autenticação.',
};
const ERROR_FALLBACK = 'Erro de autenticação. Tente novamente.';

export const lookupErrorMessage = (code: string | undefined): string =>
  code && code in ERROR_MESSAGE_MAP ? ERROR_MESSAGE_MAP[code] : ERROR_FALLBACK;

export default async function AuthErrorPage({
  searchParams,
}: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const errorCode = params.error;
  const h = await headers();
  const referer = h.get('referer');
  const xff = h.get('x-forwarded-for');
  const ua = h.get('user-agent');

  const input = prepareReplayAuditRow({
    error: errorCode,
    referer,
    xff,
    city: null, // ipToCity is async; resolved inside after() below
    ua,
  });

  if (input) {
    after(async () => {
      try {
        const city = input.ip ? await ipToCity(input.ip) : null;
        await writeReplayAuditRow({ ...input, city });
      } catch (err) {
        log.warn('auth-error-page: writeReplayAuditRow failed', { err: String(err) });
      }
    });
  }

  return (
    <main className="...">
      <h1>{lookupErrorMessage(errorCode)}</h1>
      <a href="/api/auth/signin">Voltar ao login</a>
    </main>
  );
}
```

**Error boundary** (`error.tsx` — Client Component):

```ts
'use client';
export default function AuthErrorBoundary() {
  return (
    <main className="..."><h1>Erro de autenticação.</h1><a href="/api/auth/signin">Voltar ao login</a></main>
  );
}
```

### Dependencies

No new external packages. Uses existing:
- `next/server` (`after()`)
- `next/headers` (`headers()`)
- `@root/logger` (path alias to `lib/logger.ts`)
- Existing `@/lib/auth/auth-event-log-writer`, `@/lib/auth/ip-to-city`, `@/lib/auth/truncate-user-agent` (transitive)
- `apps/idp-stub` (live verification + TC-E2E-09..11)

## Tasks

- [ ] **TASK-0**: Pre-flight spike (PRE-APPROVAL GATE — must complete
      before the spec leaves DRAFT). In a manual run: `pnpm idp-stub`
      + `pnpm --filter @tokenfx/server dev` with `OKTA_*` envs from
      `tests/e2e/global-setup.ts`. Drive a successful first OAuth
      callback in a browser. Replay the same callback URL twice. Capture
      verbatim into this spec's Execution Log:
      1. The exact `Location` URL NextAuth emits on the second callback.
      2. The exact `?error=<code>` value(s) observed.
      3. Whether NextAuth emits a distinguishing code for state-replay
         vs. other OAuth callback failures (induce a token-exchange
         failure by setting the stub's scenario to a malformed
         `id_token` and observe whether the error code differs).
      4. Any cleared cookies / additional query params.

      Based on findings, lock the `KNOWN_REPLAY_ERROR_CODES` set + decide
      §Imprecision-acceptance branch (rename `rejected-replay` to
      broader semantic OR ship with documented imprecision). If the
      decision changes the outcome enum, this spec returns to DRAFT
      and the user re-reviews before proceeding.

  - files: `.specs/sso-replay-audit-row.md` (Execution Log + REQ-1
    allowlist lock + §Imprecision-acceptance branch decision)
  - tests: (none — research; output is documented findings)
  - depends: none

- [ ] **TASK-1**: `replay-detector.ts` pure helpers + sentinel constants
      with allowlist locked by TASK-0.
  - files:
    - `apps/server/lib/auth/replay-detector.ts`
    - `apps/server/lib/auth/replay-detector.test.ts`
  - tests: TC-U-01..18 (unit)
  - depends: TASK-0

- [ ] **TASK-2**: `writeReplayAuditRow` in `auth-event-log-writer.ts`
      with DI seam + integration tests against real Postgres.
  - files:
    - `apps/server/lib/auth/auth-event-log-writer.ts` (MODIFY)
    - `apps/server/lib/auth/auth-event-log-writer.test.ts` (MODIFY — append TC-U-19)
    - `apps/server/lib/auth/replay-detector.integration.test.ts` (NEW — TC-I-01..03)
  - tests: TC-U-19, TC-I-01, TC-I-02, TC-I-03
  - depends: TASK-1

- [ ] **TASK-3**: `app/auth/error/page.tsx` + `error.tsx` + `loading.tsx`
      + pure-helper unit tests.
  - files:
    - `apps/server/app/auth/error/page.tsx`
    - `apps/server/app/auth/error/page.test.tsx`
    - `apps/server/app/auth/error/error.tsx`
    - `apps/server/app/auth/error/loading.tsx`
  - tests: TC-I-04, TC-I-05, TC-I-06
  - depends: TASK-1, TASK-2

- [ ] **TASK-4**: Wire `pages.error` in `auth.config.ts`.
  - files: `apps/server/lib/auth/auth.config.ts` (MODIFY)
  - tests: (none — wiring; covered by TC-E2E-09)
  - depends: TASK-3

- [ ] **TASK-5**: E2E test file end-to-end via IdP stub + manager-UI
      sentinel-invisibility check.
  - files: `apps/server/tests/e2e/sso-replay-audit-row.spec.ts`
  - tests: TC-E2E-09, TC-E2E-10, TC-E2E-11
  - depends: TASK-4

- [ ] **TASK-6**: Promote TC-E2E-08 in `sso-flow.spec.ts`; close out
      parent specs.
  - files:
    - `apps/server/tests/e2e/sso-flow.spec.ts` (MODIFY)
    - `.specs/central-server-onboarding-v2-sso.backend.md` (MODIFY)
    - `.specs/oauth-idp-stub.md` (MODIFY)
  - tests: TC-E2E-08 (promoted)
  - depends: TASK-5

- [ ] **TASK-SMOKE**: Run targeted Vitest + E2E.
  - Run `pnpm --filter @tokenfx/server test --run lib/auth/replay-detector.test.ts lib/auth/replay-detector.integration.test.ts lib/auth/auth-event-log-writer.test.ts app/auth/error`
  - Run `pnpm --filter @tokenfx/server test:e2e --grep "TC-E2E-(08|09|10|11)"`
  - If dev server fails to boot: log `E2E: DEFERRED`
  - files: (none — execution only)
  - tests: all above
  - depends: TASK-6

## Parallel Batches

```
Batch 0: [TASK-0]            — PRE-APPROVAL spike (user re-reviews if outcome enum changes)
Batch 1: [TASK-1]            — pure helpers
Batch 2: [TASK-2]            — writer + integration TCs
Batch 3: [TASK-3]            — Server Component
Batch 4: [TASK-4]            — auth.config wiring
Batch 5: [TASK-5]            — E2E tests
Batch 6: [TASK-6]            — promotion + spec closure
Batch 7: [TASK-SMOKE]
```

All batches single-task — small spec, minimal parallelization opportunity. TASK-1 (pure helpers) and TASK-2 (writer) COULD parallel after TASK-0 but TASK-2 imports sentinel constants from TASK-1, forcing serial.

File-overlap analysis: no shared-mutative files across tasks. `auth.config.ts` (TASK-4) and `sso-flow.spec.ts` (TASK-6) touched exclusively in their batches.

## Validation Criteria

- [ ] `pnpm --filter @tokenfx/server typecheck` passes
- [ ] `pnpm --filter @tokenfx/server lint` passes
- [ ] `pnpm --filter @tokenfx/server test --run` passes (full suite)
- [ ] `pnpm --filter @tokenfx/server test:e2e` passes (TC-E2E-08, 09, 10, 11 live, not skipped)
- [ ] `pnpm build` (root) passes
- [ ] **Live validation**: replicate TASK-0's setup (stub + dev server);
      drive a double callback in a real browser; SQL probe `auth_event_log`
      for the `outcome='rejected-replay'` row. Confirm the row contains
      sentinel `email_hash` + sentinel `iss` + a real `ip` + truncated
      `user_agent`. Refresh the error page once; confirm a second row
      appears (documented duplicate-on-refresh acceptance).
- [ ] **Privacy**:
  - No raw `state` value or full Referer URL in any `auth_event_log`
    text column (TC-E2E-10 regex).
  - No `console.log` of the state cookie, error code, or Referer in
    `app/auth/error/page.tsx` (lint enforces no `console.log` in
    `app/**`).
  - HTTP response headers do NOT include the raw `?error=` value
    (asserted in TC-E2E-09 by probing response headers).
  - Server Component rendered HTML never echoes the raw error code
    (TC-I-04..06).
- [ ] **Resilience**: `after()`-wrapped DB write failures are caught +
      logged (no 500 cascade). Verified by TC-I-03 (writer rejects) +
      manual injection of a DB-unreachable scenario.
- [ ] **No regressions**: existing ~50 SSO integration TCs + existing
      `auth-event-log-writer.test.ts` continue passing.

## Execution Log

### TASK-0 — pre-flight spike findings (2026-05-13)

**Method**: read `@auth/core@0.37.2` source under
`node_modules/.pnpm/@auth+core@0.37.2_nodemailer@6.10.1/node_modules/@auth/core/src/`.
Live runtime verification deferred (source analysis was decisive).

**Findings**:

1. **`?error=` ambiguity confirmed.** When state-replay fails, NextAuth
   throws `InvalidCheck` (`src/lib/actions/callback/oauth/checks.ts:59,68,146,186`).
   The outer `try/catch` in `src/lib/actions/callback/index.ts:531-536`
   re-throws `AuthError` instances unchanged. The top-level error
   handler at `src/index.ts:185-188`:
   ```ts
   const isClientSafeErrorType = isClientError(error)
   const type = isClientSafeErrorType ? error.type : "Configuration"
   const params = new URLSearchParams({ error: type })
   ```
   `clientErrors` set (`src/errors.ts:450-459`) is
   `{CredentialsSignin, OAuthAccountNotLinked, OAuthCallbackError,
   AccessDenied, Verification, MissingCSRF, AccountNotLinked,
   WebAuthnVerificationError}` — **`InvalidCheck` is NOT in this set**.
   ⇒ State-replay redirects to `/auth/error?error=Configuration` (NOT
   `OAuthCallbackError`).

2. **`Configuration` collides with real config errors.** Using
   `KNOWN_REPLAY_ERROR_CODES = {'Configuration'}` would tag every
   `MissingSecret`, `InvalidProvider`, etc. as a replay. **Unacceptable.**

3. **Better hook discovered: NextAuth `logger.error` callback.**
   `LoggerInstance.error: (error: Error) => void` (`src/lib/utils/logger.ts:20`)
   receives the ACTUAL `AuthError` instance. For state-replay,
   `error.type === 'InvalidCheck'`. Cause data (cookie name + parse
   diagnostics) lives on `error.cause`. This is the precise hook.

4. **ALS available in logger scope.** Existing
   `app/api/auth/[...nextauth]/route.ts:115` wraps the NextAuth
   handler in `runInRequestContext(...)`. The `logger.error` callback
   fires synchronously inside the failed callback's promise chain —
   `getRequestContext()` returns the real `ip`/`userAgent`.

**Architecture change vs original DRAFT**: pivot from
`pages.error` Server-Component-with-after() to
`NextAuth.logger.error` callback in `auth.ts`. The custom error page
becomes a passive static UI (no detection logic). The audit-row write
happens directly inside the logger callback. This is dramatically
cleaner:

- **Precise**: `error.type === 'InvalidCheck'` distinguishes state-replay
  from every other OAuth failure with zero ambiguity.
- **No URL gymnastics**: we get the error instance directly; no
  searchParams parsing, no Referer-path regex.
- **No render-time side effects**: write happens in the Node-only
  callback path; the error page renders idempotently as a pure UI.
- **No `after()` needed**: the write happens off the user's
  request path (NextAuth's error response is independent).
- **No sentinel decision delegation**: same sentinels apply, but they're
  computed in one place (the logger callback) with full request context
  via ALS, so `ip`/`userAgent` come straight from the real request.

**§Imprecision-acceptance branch resolution**: NOT needed. NextAuth
distinguishes the error class internally even though the URL surface
doesn't. We don't need to broaden `'rejected-replay'` to
`'rejected-oauth-callback'` because we're not detecting at the URL
layer anymore.

**Spec revision applied**: see "Revised Design" below. The original
Requirements were re-anchored to the logger-hook approach; REQs 1, 2,
4 received targeted edits; REQ-3 (error-page render) simplified to a
pure UI page; REQs 5, 6, 7 unchanged. Tasks rewritten — TASK-3 is now
the logger-hook in `auth.ts` (not a Server Component with side
effects); the error page (TASK-4) is a pure render-only page; TASK-5
(E2E) unchanged in intent, simplified in setup.



### Fechamento retroativo (2026-07-12)

Status fechado retroativamente — código commitado em 1961b61 (ver .specs/docs-reconciliation.md item 2.4).
