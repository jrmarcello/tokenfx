# Spec: sso-nonce-replay

## Status: IN_PROGRESS

## Context

Closes the **REQ-FU-2** carve-out documented in `.specs/oauth-idp-stub.md`
Out-of-scope §REQ-FU-2, and promotes spec-b's TC-I-45 from DEFERRED to
ADDRESSED.

### The gap

Spec-b's TC-I-45 (`.specs/central-server-onboarding-v2-sso.backend.md:397`):

> Replay-detection via nonce reuse: second callback with fresh state +
> reused nonce → rejected with NextAuth nonce error +
> `'rejected-replay'` audit row.

Two layered issues block this today:

1. **NextAuth's Okta provider defaults to `checks: ["pkce", "state"]`**
   (`@auth/core@0.37.2/src/providers/okta.ts:108`) — nonce validation
   is OFF by default. Even if the stub minted duplicate-nonce
   `id_token`s, NextAuth would never compare them.

2. **The IdP stub does not echo the OAuth `nonce` request parameter
   into the minted `id_token`**. NextAuth asserts
   `id_token.nonce === storedNonce` against the sealed nonce cookie.
   For a SUCCESSFUL callback (so we can isolate nonce failures from
   state failures in tests), the stub must mint a token whose `nonce`
   claim matches what NextAuth handed to `/authorize`.

### TASK-0 spike findings (in-source verification, no live run required)

Read of `@auth/core@0.37.2`:

- `src/lib/actions/callback/oauth/checks.ts:191-205` — the `nonce`
  check uses the same `useCookie("nonce", "nonce")` helper as the
  state check. Cookie missing OR id_token mismatch → throws
  `InvalidCheck` with `type='InvalidCheck'`. The check kind appears
  only in the message text (not as a typed field).
- `src/lib/actions/callback/oauth/checks.ts:90` — the union literal
  `"state" | "pkce" | "nonce"` is the only place the kind is named.
- `src/providers/okta.ts:108` — Okta defaults: `checks: ["pkce", "state"]`.
- The existing `auth.ts:writeReplayAuditRowOnInvalidCheck` hook from
  commit `1961b61` matches `error.type === 'InvalidCheck'` regardless
  of kind, so it ALREADY writes `outcome='rejected-replay'` rows on
  nonce failures — provided the nonce check actually runs.

### Architectural finding (load-bearing — drives test design)

Auth.js v5 runs the `state` check BEFORE the `nonce` check in the
callback handler (see ordering in
`@auth/core/src/lib/actions/callback/oauth/callback.ts:128-150`).
**Consequence**: replaying a previously-consumed callback URL fires the
**state** `InvalidCheck` first, never the nonce check. A "replay the
same URL twice" test cannot distinguish "nonce-check is enabled" from
"nonce-check is disabled" — the state failure fires either way.

To prove nonce validation is actually active end-to-end, the test
must drive a callback where:
- The state cookie is fresh + valid (state check passes), AND
- The id_token's `nonce` claim disagrees with NextAuth's sealed nonce
  cookie (so the nonce check is the failing branch).

The IdP stub already supports pinning a specific `id_token.nonce` via
`setStubScenario({ nonce: 'tampered' })`. With Okta nonce-checks
enabled, the first callback in a normal flow will FAIL on nonce
mismatch (NextAuth's cookie holds the auto-generated nonce; the
tampered id_token claim doesn't match). This isolates the nonce path
from the state path cleanly.

**Spec-b TC-I-45 wording revisited**: the literal "second callback
with fresh state + reused nonce" is not implementable with NextAuth
v5's cookie model — Auth.js binds state + nonce to the same
single-shot cookie lifecycle. The **operational guarantee** that
TC-I-45 was written to lock down is "nonce validation rejects bad
tokens AND the audit row is written" — which a tampered-nonce single
callback proves more precisely than a URL-replay would. The spec
makes this explicit in REQ-3 below and §Decisões já travadas #5.

### Decisões já travadas

1. **Enable nonce on the Okta provider**: `auth.config.ts` overrides
   the default `checks` array to `['pkce', 'state', 'nonce']`. One-
   line config change.

2. **`pendingNonceFromAuthorize` lives inside `createScenarioStore()`
   factory closure**: same `let` capture pattern as the existing
   `current: Scenario` variable. New methods on `ScenarioStore`
   interface: `setPendingNonce(value)`, `getPendingNonce()`. `reset()`
   clears BOTH the scenario and the pending-nonce slot. This
   preserves per-test isolation — every `createScenarioStore()` call
   in tests gets its own pending slot; the module-level
   `defaultScenarioStore` carries one for the production server.

3. **REMOVE the existing form-body nonce echo** in `server.ts:84-95`.
   That code reads `nonce` from the `/token` POST body and spreads
   it onto `scenario` before signing. Auth.js does NOT send `nonce`
   in the `/token` request body — the path is dead code under the
   real OAuth flow, and would conflict with the new
   pendingNonce-from-authorize wiring. Removed entirely; the existing
   `'echoes nonce from form body'` test is updated to verify the
   form-body field is now IGNORED (regression lock against re-introduction).

4. **`/authorize` query params get a Zod schema**. The handler
   currently uses hand-written `c.req.query()` reads with manual
   guards. Adding a third manual check (the 255-char nonce bound)
   would widen the gap with the security rule "Zod at every external
   input boundary". TASK-3 introduces
   `AuthorizeQuerySchema = z.object({ response_type, client_id,
   redirect_uri, state, scope, nonce })` with the existing
   missing-required + open-redirect guards re-expressed as
   `.refine()` calls. `nonce: z.string().max(255).optional()` is the
   new field; empty string is normalised to null in a post-parse
   step (NOT via `.min(1)` rejection — an empty `?nonce=` is a
   protocol-level no-op, not an error).

5. **Test design pivot from "replay URL" to "tampered nonce"**.
   TC-E2E-03 drives a SINGLE callback with `setStubScenario({nonce:
   'tampered-value'})`, so the id_token's `nonce` claim disagrees
   with NextAuth's cookie. This is the operationally-equivalent test
   spec-b TC-I-45 was written to demand — and it cleanly proves nonce
   validation is enabled (it cannot pass without REQ-1's config
   change). Documented in TC-E2E-03's prose.

6. **TC-E2E-04 captures the real generated nonce** via redirect
   interception. The Playwright `request` fixture hits
   `/api/auth/signin/okta` with `maxRedirects: 0`, reads the
   `Location` header (= the stub `/authorize` URL with the
   NextAuth-generated `nonce` query param), and stores that value in
   a local constant for the substring assertion at the end of the
   test. No synthetic-sentinel substitute.

7. **Extract `apps/server/tests/e2e/helpers/audit-log-probe.ts`
   NOW**, not later. The existing `queryReplayRowsSince` +
   `waitForReplayRow` helpers in
   `sso-replay-audit-row.spec.ts` are 44 LoC of test-only DB-probing
   logic that this spec needs verbatim. The original spec's
   "follow-up refactor" note becomes load-bearing: in this spec.
   Both specs import from the new helper; drift surface eliminated.

8. **Add a unit-level lock on TASK-4** (config change). New test
   `auth.config.test.ts` asserts that the resolved Okta provider's
   `options.checks` array includes `'nonce'`. Compile-time
   regression lock — if a future Auth.js upgrade changes the option
   API, this fails at typecheck OR at unit-test time, not silently
   at the E2E layer.

9. **Privacy invariants unchanged**. Same set as the prior spec:
   stub never logs the recorded nonce; no PII in `auth_event_log`;
   error responses use the `{error:{message}}` shape with no template
   interpolation; lint enforces no `console.log` in
   `apps/idp-stub/src/**` and `apps/server/{app,lib}/**`.

### Prior art

- `apps/server/lib/auth/auth.ts:logger.error` hook (commit `1961b61`)
  — reused unchanged.
- `apps/server/lib/auth/auth-event-log-writer.ts:writeReplayAuditRow`
  (commit `1961b61`) — reused unchanged.
- `apps/server/lib/auth/replay-detector.ts:isStateReplayAuthError`
  (commit `1961b61`) — reused unchanged; already matches any
  `InvalidCheck`.
- `apps/idp-stub/src/scenario.ts` — `ScenarioStore` factory pattern;
  new slot added inside the factory closure.
- `apps/idp-stub/src/fixtures.ts:signIdToken` — `SignInput` extended
  with optional `pendingNonce`.
- `apps/idp-stub/src/server.ts` — `/authorize` and `/token` handlers;
  `/token`'s form-body nonce echo removed.
- `apps/server/tests/e2e/sso-replay-audit-row.spec.ts` (commit
  `1961b61`) — `queryReplayRowsSince` + `waitForReplayRow` extracted
  to a shared helper module.

## Requirements

- [ ] **REQ-1**: GIVEN `auth.config.ts` configures the Okta provider
  with `checks: ['pkce', 'state', 'nonce']`, WHEN NextAuth initiates
  the OAuth flow (`/api/auth/signin/okta`), THEN the redirect to the
  stub's `/authorize` includes a non-empty `nonce` query param AND
  NextAuth sets a sealed cookie whose name matches
  `/^__Secure-(authjs|next-auth)\.nonce/` (Auth.js v5 at
  `@auth/core@0.37.2`).

- [ ] **REQ-2**: GIVEN the IdP stub receives `GET /authorize?nonce=N`
  (Zod-validated, ≤ 255 chars, non-empty), WHEN no scenario override
  pins `scenario.nonce`, THEN the next `id_token` minted by `/token`
  emits `nonce: N`. GIVEN the scenario DOES pin `nonce` (via
  `setStubScenario({nonce: 'X'})`), THEN the pinned value wins over
  the recorded one — preserving the existing tampered-nonce path
  required by the cross-IdP / mismatch tests. GIVEN `/authorize`
  is called without a `nonce` query param OR with an empty
  `?nonce=`, THEN no value is recorded AND the next `/token`'s
  `id_token` has the `nonce` claim absent (existing behaviour
  preserved).

- [ ] **REQ-3**: GIVEN the live stack (IdP stub + dev server with the
  REQ-1 config), WHEN a Playwright test sets the stub to pin a
  tampered nonce (`setStubScenario({ nonce: 'tampered-value' })`)
  AND drives a single OAuth callback round-trip, THEN NextAuth
  rejects the callback because `id_token.nonce !== cookieNonce`
  (this fires `InvalidCheck` on the nonce branch — provably
  distinct from state/PKCE branches because state + PKCE are
  fresh and valid) AND the existing `auth.ts:logger.error` hook
  writes exactly one `auth_event_log` row with
  `outcome='rejected-replay'` AND sentinel `email_hash`/`iss`.

- [ ] **REQ-4**: GIVEN the audit row from REQ-3, THEN NONE of its
  text columns (`sso_provider`, `iss`, `email_hash`, `ip`, `city`,
  `user_agent`) contain the full NextAuth-generated `nonce` value
  (captured upstream by Playwright via redirect interception) nor
  its first 16 characters. Privacy regression lock — the audit
  writer must never persist OAuth check material.

- [ ] **REQ-5**: GIVEN the work in REQs 1-4 ships, THEN:
  - `.specs/central-server-onboarding-v2-sso.backend.md` TC-I-45
    moves from DEFERRED to ADDRESSED with a link to this spec.
  - `.specs/oauth-idp-stub.md` Out-of-scope §REQ-FU-2 is rewritten
    to "CLOSED" with a link to this spec.

### Out-of-scope (deliberate carve-outs)

- **State-vs-nonce-vs-PKCE outcome discriminator in `auth_event_log`**:
  Auth.js uses a single `InvalidCheck` class for all three kinds.
  Splitting them in the audit log would require parsing
  `error.message` (fragile) and adds no operational value. Explicitly
  rejected.
- **PKCE-replay coverage**: covered by the same `InvalidCheck` hook
  for free. No dedicated TC.
- **Google provider nonce enablement**: not in scope. Same hook
  applies if it's enabled later.
- **Concurrent-callers nonce registry on the stub**: the stub is
  single-test-at-a-time by design (scenario singleton with per-test
  factory stores). Multi-request concurrency keyed by `state` is out
  of scope.
- **Pure URL-replay of a previously-consumed callback** (spec-b
  TC-I-45's literal wording): cannot isolate nonce vs. state failure
  because Auth.js runs the state check first. The tampered-nonce
  test in TC-E2E-03 is the operationally-equivalent verification.
  Documented in §Decisões #5.

## Test Plan

Coverage rules from `.claude/rules/sdd.md` §Test Plan are explicitly
checked. Every REQ has ≥ 1 TC, validation has both valid-max and
invalid-max+1 boundary TCs, and the rigor ratio comes out 12:7
(non-happy : happy) after restructuring.

### Unit Tests

`apps/idp-stub/src/scenario.test.ts` (MODIFY — append):

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-01 | REQ-2 | happy | `createScenarioStore()` then `store.setPendingNonce('abc')` then `store.getPendingNonce() === 'abc'`. Distinct from `store.get().nonce` (which stays null) | match |
| TC-U-02 | REQ-2 | happy | After `setPendingNonce('abc')` then `reset()`: `getPendingNonce() === null` AND `get()` returns `DEFAULT_SCENARIO` (one TC, two assertions) | both null/default |
| TC-U-03 | REQ-2 | edge | `setPendingNonce('first')` then `setPendingNonce('second')` → `getPendingNonce() === 'second'` (last-write-wins, no overwrite-guard regression) | `'second'` |
| TC-U-04 | REQ-2 | edge | `setPendingNonce(null)` clears the slot | null |
| TC-U-05 | REQ-2 | edge | Two independent `createScenarioStore()` instances do NOT share the pending-nonce slot (per-test isolation lock) | independent |

`apps/idp-stub/src/fixtures.test.ts` (MODIFY — append):

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-06 | REQ-2 | happy | `signIdToken({..., scenario:{...DEFAULT, nonce:null}, pendingNonce:'abc'})` → decoded `nonce === 'abc'` | match |
| TC-U-07 | REQ-2 | business | Pin wins: `signIdToken({..., scenario:{..., nonce:'pinned'}, pendingNonce:'abc'})` → `nonce === 'pinned'` | match |
| TC-U-08 | REQ-2 | edge | Both null: `signIdToken({..., scenario:{..., nonce:null}, pendingNonce:null})` → `'nonce' in decoded === false` (strict property absence) | absent |
| TC-U-09 | REQ-2 | edge | `pendingNonce` omitted (legacy callers) is treated identically to `pendingNonce: null` — claim absent | absent |

`apps/server/lib/auth/auth.config.test.ts` (NEW):

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-U-10 | REQ-1 | happy | `authConfig.providers` contains an Okta provider whose `options.checks` includes `'nonce'` (regression lock on the config) | includes |

### Integration Tests

`apps/idp-stub/src/server.test.ts` (MODIFY — append):

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-I-01 | REQ-2 | happy | `GET /authorize?...&nonce=abc&state=ST&...` → 302; subsequent POST `/token` mints `id_token.nonce === 'abc'` | match |
| TC-I-02 | REQ-2 | business | POST `/admin/scenario {nonce:'pinned'}` then `GET /authorize?nonce=abc` then POST `/token` → `id_token.nonce === 'pinned'`. Then reset only `scenario.nonce` to null and re-call `/token` → `id_token.nonce === 'abc'` (slot was set despite pin) | both phases match |
| TC-I-03 | REQ-2 | edge | `GET /authorize` WITHOUT `nonce` param then POST `/token` → `nonce` claim absent | absent |
| TC-I-04 | REQ-2 | edge | `GET /authorize?nonce=` (empty string) then POST `/token` → `nonce` claim absent (empty normalised to null, no Zod rejection) | absent |
| TC-I-05a | REQ-2 | validation | `GET /authorize?nonce=<255 chars>` → 302 (valid-max accepted) | 302 |
| TC-I-05b | REQ-2 | validation | `GET /authorize?nonce=<256 chars>` → 400 with `{error:{message}}` shape AND the `pendingNonce` slot is NOT poisoned (subsequent `/token` without further `/authorize` produces no `nonce` claim) | both |
| TC-I-06 | REQ-2 | regression | POST `/token` with form-body `nonce=fromBody` (real Auth.js never sends this; regression lock against the removed dead-code path) → `id_token` does NOT contain `'fromBody'` | absent |

### E2E Tests

`apps/server/tests/e2e/sso-nonce-replay.spec.ts` (NEW). Requires the
existing `global-setup.ts` stack.

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-E2E-01 | REQ-1 | happy | Capture: `request.get('/api/auth/signin/okta', { maxRedirects:0 })` → 302 to stub `/authorize`. Assert URL contains `?...&nonce=...&...`; extract nonce value. Assert response cookies include one whose name matches `/^__Secure-(authjs\|next-auth)\.nonce/` (regex pinned to `@auth/core@0.37.2`) | both |
| TC-E2E-02 | REQ-1 | regression | Drive a complete healthy callback (NO scenario override; stub echoes the URL nonce into the id_token); assert response is 302 to a non-`/auth/error` location AND a `authjs.session-token` cookie is present (positive session-established) AND no new `rejected-replay` row appears in `auth_event_log` since `testStartMs` (testStartMs captured as the FIRST line of the test, before any network call) | session + no audit row |
| TC-E2E-03 | REQ-3 | security | Pin a tampered nonce: `setStubScenario({nonce:'tampered-value-XYZ'})`. Drive a fresh OAuth callback with the test's own `request` context (fresh state cookie + fresh nonce cookie from `/api/auth/signin/okta`). Assert the callback response is 302 to a URL whose path matches `/auth/error`. Assert EXACTLY one new `auth_event_log` row appears with `outcome='rejected-replay' AND email_hash='replay:state-mismatch' AND occurred_at > testStartMs`. This is the load-bearing TC for REQ-3 — it cannot pass without REQ-1's config change AND TASK-3's stub wiring | both halves |
| TC-E2E-04 | REQ-4 | security | After TC-E2E-03's row write, capture the REAL nonce that NextAuth generated (intercepted in TC-E2E-03's signin redirect, NOT the tampered value). Query every text column of the new row and assert NONE contains the full nonce value NOR its first 16 chars | regex absence |

**TC count**: 10 unit + 7 integration + 4 e2e = **21 TCs**. Rigor:
14 non-happy (validation/edge/security/business/regression) vs 7
happy = **2:1** — comfortably above the floor. All REQs have ≥ 1
TC; the Zod-validated `nonce` field has both valid-max (TC-I-05a)
and invalid-max+1 (TC-I-05b) boundary TCs; the new dead-code
regression has its own TC (TC-I-06).

## Design

### Architecture decisions

**Files to Create**:

```
apps/server/
├── lib/auth/
│   └── auth.config.test.ts           (TC-U-10 — config regression lock)
├── tests/e2e/
│   ├── helpers/
│   │   └── audit-log-probe.ts        (extracted from sso-replay-audit-row.spec.ts)
│   └── sso-nonce-replay.spec.ts      (TC-E2E-01..04 — live stack)
```

**Files to Modify**:

- `apps/server/lib/auth/auth.config.ts` — extend the Okta provider
  constructor with `checks: ['pkce', 'state', 'nonce']`:

  ```ts
  Okta({
    clientId: process.env.OKTA_CLIENT_ID,
    clientSecret: process.env.OKTA_CLIENT_SECRET,
    issuer: process.env.OKTA_ISSUER,
    checks: ['pkce', 'state', 'nonce'],
  }),
  ```

- `apps/idp-stub/src/scenario.ts` — extend `ScenarioStore` interface
  AND the `createScenarioStore` factory closure:

  ```ts
  export interface ScenarioStore {
    get(): Scenario;
    set(patch: z.infer<typeof ScenarioOverrideSchema>): void;
    reset(): void;
    setPendingNonce(value: string | null): void;       // NEW
    getPendingNonce(): string | null;                  // NEW
  }

  export const createScenarioStore = (): ScenarioStore => {
    let current: Scenario = DEFAULT_SCENARIO;
    let pendingNonce: string | null = null;            // NEW: factory-closure slot
    return {
      get: () => current,
      set: (patch) => { current = { ...current, ...patch }; },
      reset: () => { current = DEFAULT_SCENARIO; pendingNonce = null; },
      setPendingNonce: (value) => { pendingNonce = value; },
      getPendingNonce: () => pendingNonce,
    };
  };
  ```

  The pending slot lives in the factory closure (NOT module level),
  so per-test isolation is preserved.

- `apps/idp-stub/src/scenario.test.ts` — append TC-U-01..05.

- `apps/idp-stub/src/fixtures.ts` — extend `SignInput` and the
  resolution order:

  ```ts
  export type SignInput = Readonly<{
    jwks: JwksKit;
    issuer: string;
    scenario: Scenario;
    pendingNonce?: string | null;                       // NEW
  }>;

  // Resolution order inside signIdToken:
  //   scenario.nonce ?? pendingNonce ?? <claim absent>
  // `??` handles both `null` and `undefined` identically — empty-
  // string callers must normalise to null upstream (server.ts
  // /authorize handler does this).
  ```

- `apps/idp-stub/src/fixtures.test.ts` — append TC-U-06..09.

- `apps/idp-stub/src/server.ts` — three changes:
  1. Introduce
     `AuthorizeQuerySchema = z.object({ response_type:
     z.string().optional(), client_id: z.string().optional(),
     redirect_uri: z.string(), state: z.string().min(1),
     scope: z.string().optional(), nonce:
     z.string().max(255).optional() })`. Replace the current
     hand-written `c.req.query()` reads in `/authorize` with a
     `safeParse` against this schema. Existing
     missing-redirect_uri / missing-state / open-redirect guards
     re-expressed inside this validation step.
  2. `/authorize` handler: after Zod parse, normalise empty-string
     nonce to null. If non-null, call
     `deps.scenario.setPendingNonce(nonce)`. Length boundary is
     enforced by Zod (no hand-check).
  3. `/token` handler: REMOVE the existing form-body nonce read
     at lines 84-95 (read of `body.nonce`, spread onto scenario).
     Pass `deps.scenario.getPendingNonce()` as the new
     `pendingNonce` arg to `signIdToken`. Form-body `nonce` is
     ignored — the regression-lock TC-I-06 enforces this.

- `apps/idp-stub/src/server.test.ts` — append TC-I-01..06; UPDATE
  the existing `'echoes nonce from form body into id_token claim'`
  test to assert the OPPOSITE (form-body nonce IGNORED — TC-I-06
  covers this).

- `apps/server/tests/e2e/sso-replay-audit-row.spec.ts` — replace
  the inline `queryReplayRowsSince` + `waitForReplayRow` + `ReplayRow`
  type with an import from `./helpers/audit-log-probe`. Existing TCs
  unchanged.

- `apps/server/tests/e2e/helpers/audit-log-probe.ts` — new file,
  exports `queryReplayRowsSince(sinceMs)`, `waitForReplayRow(sinceMs,
  timeoutMs?)`, and `type ReplayRow`. Pure extraction — no behaviour
  change.

- `.specs/central-server-onboarding-v2-sso.backend.md` — mark TC-I-45
  ADDRESSED with link.

- `.specs/oauth-idp-stub.md` §Out-of-scope §REQ-FU-2 — rewrite to
  "CLOSED" with link.

### Dependencies

No new external packages. Reuses:
- `next-auth` v5 `checks` config on Okta provider.
- Existing `auth.ts:logger.error` hook + `writeReplayAuditRow` +
  `isStateReplayAuthError` (commit `1961b61`).
- New shared helper at `apps/server/tests/e2e/helpers/audit-log-probe.ts`
  imported by both the existing and new E2E specs.

### Privacy / failure-safety

- The `pendingNonce` slot is in-memory per-process. Never written to
  disk, never logged, never echoed in error bodies.
- `console.log` forbidden in `apps/idp-stub/src/**` and
  `apps/server/{app,lib}/**` (lint enforced).
- `AuthorizeQuerySchema` errors return the standard `badRequest`
  helper shape `{error:{message}}` — Zod error message is the issue
  path + reason, never the raw user-supplied value.

## Tasks

- [ ] **TASK-1**: Stub — extend `scenario.ts` with factory-closure
      `pendingNonce` slot and `setPendingNonce`/`getPendingNonce` on
      `ScenarioStore`. RED state: existing tests pass; new TC-U-01..05
      compile-fail until production code lands.
  - files:
    - `apps/idp-stub/src/scenario.ts`
    - `apps/idp-stub/src/scenario.test.ts`
  - tests: TC-U-01, TC-U-02, TC-U-03, TC-U-04, TC-U-05
  - depends: none

- [ ] **TASK-2**: Stub — extend `signIdToken` (`fixtures.ts`) with
      `pendingNonce` resolution. Note `undefined` and `null` collapse
      via `??`.
  - files:
    - `apps/idp-stub/src/fixtures.ts`
    - `apps/idp-stub/src/fixtures.test.ts`
  - tests: TC-U-06, TC-U-07, TC-U-08, TC-U-09
  - depends: TASK-1

- [ ] **TASK-3**: Stub — Zod-schema-ify `/authorize` query params,
      record nonce into the pending slot, REMOVE the dead form-body
      nonce echo from `/token`, wire `getPendingNonce` into
      `signIdToken`. Update existing `'echoes nonce from form body'`
      test to assert form-body is IGNORED.
  - files:
    - `apps/idp-stub/src/server.ts`
    - `apps/idp-stub/src/server.test.ts`
  - tests: TC-I-01, TC-I-02, TC-I-03, TC-I-04, TC-I-05a, TC-I-05b, TC-I-06
  - depends: TASK-1, TASK-2

- [ ] **TASK-4**: Server — enable nonce on the Okta provider in
      `auth.config.ts` + unit-level config regression lock.
  - files:
    - `apps/server/lib/auth/auth.config.ts`
    - `apps/server/lib/auth/auth.config.test.ts` (NEW)
  - tests: TC-U-10
  - depends: none
  - **WARNING**: applied to a running stack BEFORE TASK-3 is complete,
    this breaks existing E2E SSO tests (the new nonce check requires
    the stub's pendingNonce wiring). Validate in the same batch as
    TASK-3.

- [ ] **TASK-5**: Extract the `audit-log-probe.ts` shared helper and
      migrate the existing `sso-replay-audit-row.spec.ts` to import
      from it. No behaviour change; pure refactor.
  - files:
    - `apps/server/tests/e2e/helpers/audit-log-probe.ts` (NEW)
    - `apps/server/tests/e2e/sso-replay-audit-row.spec.ts` (MODIFY — replace inline helpers with import)
  - tests: existing TC-E2E-09..11 continue passing as regression
  - depends: none

- [ ] **TASK-6**: E2E spec — `sso-nonce-replay.spec.ts` against the
      live stack. Uses the new shared helper.
  - files: `apps/server/tests/e2e/sso-nonce-replay.spec.ts`
  - tests: TC-E2E-01, TC-E2E-02, TC-E2E-03, TC-E2E-04
  - depends: TASK-3, TASK-4, TASK-5

- [ ] **TASK-7**: Close parent specs — mark TC-I-45 ADDRESSED;
      rewrite oauth-idp-stub §REQ-FU-2 to "CLOSED".
  - files:
    - `.specs/central-server-onboarding-v2-sso.backend.md`
    - `.specs/oauth-idp-stub.md`
  - tests: none
  - depends: TASK-6

- [ ] **TASK-SMOKE**: targeted Vitest + the new E2E.
  - Run `pnpm --filter @tokenfx/idp-stub test --run`
  - Run `pnpm --filter @tokenfx/server typecheck` + `lint`
  - Run `pnpm --filter @tokenfx/server test --run` (sanity — no
    regressions in existing TCs after the helper extraction)
  - Run `pnpm --filter @tokenfx/server test:e2e --grep "sso-nonce-replay|sso-replay-audit-row"`
  - If dev server fails to boot: log `E2E: DEFERRED`
  - files: (none — execution only)
  - tests: TC-U-01..10, TC-I-01..06, TC-E2E-01..04
  - depends: TASK-7

## Parallel Batches

```
Batch 1: [TASK-1, TASK-4, TASK-5]    — three independent tasks: scenario.ts (stub),
                                       auth.config.ts (server), audit-log-probe extraction
Batch 2: [TASK-2]                    — depends on TASK-1
Batch 3: [TASK-3]                    — depends on TASK-1 + TASK-2
Batch 4: [TASK-6]                    — depends on TASK-3 + TASK-4 + TASK-5
Batch 5: [TASK-7]                    — depends on TASK-6
Batch 6: [TASK-SMOKE]                — final
```

File-overlap analysis:
- TASK-1 (`apps/idp-stub/src/scenario.ts`), TASK-4 (`apps/server/lib/auth/auth.config.ts`),
  and TASK-5 (`apps/server/tests/e2e/helpers/audit-log-probe.ts` + edits to
  `sso-replay-audit-row.spec.ts`) touch disjoint paths → Batch 1 parallel-safe.
- TASK-2 modifies `fixtures.{ts,test.ts}` — disjoint from TASK-1's `scenario.{ts,test.ts}` but
  depends on TASK-1's API → serial.
- TASK-3 modifies `server.{ts,test.ts}` — depends on both helpers → serial.
- TASK-6 creates a new file; depends on TASKs 3/4/5.

## Validation Criteria

- [ ] `pnpm --filter @tokenfx/idp-stub typecheck` passes
- [ ] `pnpm --filter @tokenfx/idp-stub test --run` passes (74 existing + 9 new unit + 7 new integration; the body-form-nonce test now asserts the OPPOSITE)
- [ ] `pnpm --filter @tokenfx/server typecheck` passes
- [ ] `pnpm --filter @tokenfx/server lint` passes
- [ ] `pnpm --filter @tokenfx/server test --run` passes — including the new `auth.config.test.ts` (TC-U-10) and the updated `sso-replay-audit-row.spec.ts` (now imports from shared helper)
- [ ] `pnpm --filter @tokenfx/server test:e2e --grep "sso-nonce-replay|sso-replay-audit-row"` passes
- [ ] `pnpm build` (root) passes
- [ ] **Live validation**: with `pnpm idp-stub` + `pnpm --filter @tokenfx/server dev` running, hit `/api/auth/signin/okta` in a browser. Capture the `nonce` URL param + the `__Secure-...nonce` Set-Cookie header. Confirm a healthy first callback (`authjs.session-token` cookie set) AND no `rejected-replay` audit row. Re-run with `curl -X POST http://localhost:3001/admin/scenario -d '{"nonce":"tampered"}'` first, then drive a fresh signin; confirm a `rejected-replay` row appears in `auth_event_log`.
- [ ] **Privacy** (security.md §Data Protection):
  - The recorded `pendingNonce` value is NEVER logged.
  - No `console.log` in `apps/idp-stub/src/**` or `apps/server/{app,lib}/**` (lint enforced).
  - HTTP 400 responses never include the raw user-supplied query value (Zod error messages are the issue path + constraint, not the input).
- [ ] **Documentation closure** (TASK-7 enforcement):
  - `grep "ADDRESSED.*sso-nonce-replay" .specs/central-server-onboarding-v2-sso.backend.md` exits 0
  - `grep "CLOSED.*sso-nonce-replay" .specs/oauth-idp-stub.md` exits 0
- [ ] **No regressions**: 1233 server TCs + 74 idp-stub TCs + ~30 SSO E2E TCs continue passing after the helper extraction in TASK-5.

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->
