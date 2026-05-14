# Spec: sso-e2e-live-execution

## Status: DONE

## Context

Closes the last open carve-out from the SSO initiative: promotes the
two remaining `test.skip` placeholders in
`apps/server/tests/e2e/manager-ui.spec.ts` to live, asserting end-to-end:

- **TC-E2E-06** — `/manager/invites/create` form submit persists the
  selected `allowed_sso_providers` array to `onboarding_invites`.
- **TC-E2E-07** — `/manager/teams/[id]` `provisioned_via` filter
  control re-renders the members table; the Export-CSV link triggers
  a real download.

Both TCs were originally marked PARTIALLY ADDRESSED in
`.specs/oauth-idp-stub.md` PAUSE 2 §"Pontos de atenção #2" because the
underlying business logic was already integration-tested:

- `apps/server/app/manager/invites/actions.test.ts` covers the
  `createInviteImpl` Server Action shape + `allowedSsoProvidersSchema`
  Zod validation (TC-U-01..07 from `sso-test-coverage-orphans`).
- `apps/server/tests/integration/team-roster-csv.test.ts` covers the
  `/manager/teams/[id]/export` route with sso-auto / token /
  pre-v2-unknown row filtering (TC-AO-23b/c).

What was missing: the **UI submit → persist round-trip** for invites
and the **UI filter → re-render** + **CSV download trigger** for
team-roster. Both are pure Playwright concerns — no new business
logic, no new code in `app/` or `lib/`.

### Decisões já travadas

1. **TC-E2E-08 is already live** (commit `1961b61`,
   `sso-replay-audit-row` spec). Only TC-E2E-06 + TC-E2E-07 remain.

2. **No new `data-testid` attributes needed.** Inspection of the
   target surfaces found everything the tests require:
   - `apps/server/components/manager/invite-create-form.tsx` already
     has `invite-create-form`, `invite-create-allowed-sso-providers`,
     `invite-create-submit`, `invite-create-error`. The provider
     checkboxes are queryable by `name="allowed_sso_providers"` +
     `value="<provider>"`.
   - `apps/server/app/manager/invites/created/page.tsx` exposes
     `flash-onboard-url-value` for the captured URL (the `#token=...`
     fragment).
   - `apps/server/app/manager/teams/[id]/page.tsx` already has
     `team-detail-name`, `team-export-csv-link`,
     `team-members-filter-form`. The radio inputs use stable
     `name="provisioned_via"` + value attributes.
   - `apps/server/components/manager/team-detail-members.tsx` already
     has `team-members-table` (plus row `data-testid`s — confirmed
     via grep).

   This keeps the spec strictly test-only: no production-code changes.

3. **TC-E2E-06 persistence assertion uses a DB probe**, not a UI
   read-back. The post-creation flash page (`/manager/invites/created`)
   only renders the URL; the `allowed_sso_providers` array is not
   surfaced. Verifying via DB query — `SELECT allowed_sso_providers
   FROM onboarding_invites WHERE left(token, 8) = $1` — matches the
   schema's expression index (`prefixIdx` in
   `apps/server/lib/db/schema.ts:277`) and exercises the actual
   storage column tested by the integration suite. This is the
   correct precision for an E2E persistence assertion.

4. **TC-E2E-07 filter-and-CSV pattern**:
   - `signInAs(manager)` to establish a session.
   - Visit `/manager/teams/<seeded-team-id>` where the seeded team
     has mixed-provisioning members (Alpha team from
     `seed-server.ts --e2e`).
   - Click `provisioned_via=sso-auto` radio + Apply submit.
   - Wait for navigation (the form is a GET so the URL updates;
     `page.waitForURL(/provisioned_via=sso-auto/)`).
   - Assert the rendered `team-members-table` no longer contains
     known token-provisioned member rows.
   - Click the `team-export-csv-link`; assert the download is
     triggered with the expected filename pattern (matches the
     existing `/manager/teams/[id]/export/route.test.ts` Content-
     Disposition behavior).

5. **Seeded team selection**. The team UUID is generated via
   `stableUuid('team:org-alpha:team-platform')` per
   `apps/server/scripts/seed-manager-v2.ts:192`. Import this exact
   helper from `apps/server/lib/e2e/seed-ids.ts` to avoid hard-coding
   a UUID literal.

   **⚠️ Seed gap — REQUIRES SPEC EXPANSION**: inspection of both
   `seed-server.ts:268-277` and `seed-manager-v2.ts:225-234` shows that
   ALL `user_machines` INSERTs OMIT the `provisionedVia` column,
   defaulting to `'pre-v2-unknown'` per `schema.ts:88`. There are
   ZERO `sso-auto` rows anywhere in the seed. TC-E2E-07's happy-path
   assertion ("row count ≥ 1 after `provisioned_via=sso-auto` filter")
   would fail. This spec MUST update `seed-manager-v2.ts` to mark a
   deterministic subset of Alpha-platform members (e.g. half by index)
   as `provisionedVia: 'sso-auto'` so the filter returns a non-empty
   row set in E2E. Trade-off: expands the spec from "test-only" to
   "test + seed fixture change". Quality wins per the project's
   non-negotiable ranking — the alternative (relaxing the assertion to
   "row count ≥ 0") leaves the filter mechanic effectively unverified.

6. **`signInAs` reuse**. `apps/server/tests/e2e/helpers/sign-in-as.ts`
   is the canonical helper (drives the `e2e-bypass-provider`
   Credentials flow); it's already used by every manager-UI E2E test
   in the file. No new helper needed.

7. **Idempotency / cross-test isolation**: each test signs in as
   `alice@alpha.test` (the seeded manager), creates one invite (TC-E2E-06)
   or applies one filter (TC-E2E-07). No state mutation that affects
   other tests in the file — the invites table accumulates one row per
   TC-E2E-06 run, deterministically queryable by token-prefix. Multiple
   re-runs are independent.

8. **Roadmap closure**: this spec is item 3 (the last) of
   `roadmap.md`'s "Ordem ideal de execução". Items 1 + 2 are ALREADY
   shipped (commits `1961b61` + `4eec79e`) but their commits never
   cleaned the roadmap. TASK-4 removes items 1, 2, AND 3 in one pass
   so the §"Ordem ideal de execução" closes cleanly. The SSO
   initiative's three follow-up specs (`sso-replay-audit-row`,
   `sso-nonce-replay`, `sso-e2e-live-execution`) are then all closed.

9. **Access model — alice signs in for TC-E2E-07**: `alice@alpha.test`
   has `role='admin'` per `seed-server.ts:168` (Alpha-frontend), which
   grants org-wide visibility across all Alpha teams under the
   `/manager/teams/[id]` route guard. She is therefore authorized to
   view `team-platform` even though she is not a member of it. This is
   the same access model used by every other `manager-ui.spec.ts` TC
   that signs in as alice and visits team-detail pages. No new auth
   path exercised.

### Prior art

- `apps/server/tests/e2e/manager-ui.spec.ts:62-119` — current
  `test.skip` placeholders with the descriptive PARTIALLY ADDRESSED
  rationale (no behavior, just the skip note). Both tests replaced
  with live assertions.
- `apps/server/tests/e2e/manager-ui.spec.ts:21-46` (TC-E2E-04, live):
  same `signInAs(...)` + `page.goto(...)` + `waitForLoadState` +
  `getByRole` pattern that TC-E2E-06/07 follow.
- `apps/server/tests/e2e/helpers/audit-log-probe.ts` — DB-probe
  pattern (open `pg.Client`, query, close). New
  `queryInviteByTokenPrefix(prefix)` helper follows the same shape.
- `apps/server/tests/e2e/manager-ui.spec.ts:93-102` (TC-E2E-05, live):
  the canonical `page.waitForEvent('download') → click → await downloadPromise
  → suggestedFilename().toMatch(...)` pattern used by TC-E2E-07.

## Requirements

- [ ] **REQ-1**: GIVEN an authenticated manager session via `signInAs`
  on the Alpha org, WHEN the manager visits `/manager/invites/create`,
  unchecks the default `google` checkbox, checks the `okta`
  checkbox, and submits the form, THEN the post-submit page is
  `/manager/invites/created` AND the rendered HTML contains a
  `data-testid="flash-onboard-url-value"` element AND a SQL probe
  against `onboarding_invites` (filtered by `left(token, 8)` matching
  the prefix derived from the URL fragment) returns exactly one row
  whose `allowed_sso_providers` text-array column equals `['okta']`
  (NOT `['google']`, NOT `['google','okta']`).

- [ ] **REQ-2**: GIVEN the same authenticated session, WHEN the
  manager visits `/manager/teams/<alpha-platform-team-id>`, selects
  the `provisioned_via=sso-auto` radio in
  `team-members-filter-form`, clicks Apply, THEN the page URL
  updates to include `?provisioned_via=sso-auto` AND the
  `team-members-table` re-renders with at least one row visible
  (Alpha-platform has known sso-auto members per the e2e seed). WHEN
  the manager then clicks `team-export-csv-link`, THEN Playwright
  observes a `download` event whose `suggestedFilename()` matches
  the pattern `/team-roster.*\.csv$/i` (the route's
  `Content-Disposition` filename format).

- [ ] **REQ-3**: GIVEN this spec's TCs ship, THEN
  `apps/server/tests/e2e/manager-ui.spec.ts` lines 62-119 contain
  no `test.skip(...)` calls (the two PARTIALLY ADDRESSED skips are
  replaced with live `test(...)` definitions). The pre-existing
  `TC-E2E-03..05` tests in the same file remain unchanged.

- [ ] **REQ-4**: GIVEN this spec's TCs ship, THEN `roadmap.md` no
  longer lists items 1, 2, or 3 of §"Ordem ideal de execução" — i.e.
  the three SSO follow-up entries (`sso-replay-audit-row`,
  `sso-nonce-replay`, `sso-e2e-live-execution`). Items 1 and 2 are
  ALREADY shipped (commits `1961b61` + `4eec79e`) but were NOT removed
  from the roadmap by their commits — this spec performs the cleanup
  for all three. The full §"Ordem ideal de execução" is reduced to the
  trailing "Depois de resolver todas as pendências" section ONLY.

### Out-of-scope

- **Adding new business logic, queries, or schema changes.** Both
  TCs assert existing behavior already covered at the integration
  layer; this spec is strictly a UI-flow regression lock.
- **Touching `manager-ui.spec.ts` TC-E2E-03..05.** Those are live
  and stable.
- **CSV body validation** (e.g. asserting specific row contents in
  the downloaded file). The route's response shape is already covered
  by `app/manager/teams/[id]/export/route.test.ts` integration tests.
  E2E only needs to prove the download triggers — content is
  redundantly tested at a faster layer.
- **Tightening `signInAs` semantics**. Existing helper, existing
  pattern.

## Test Plan

The full surface is two E2E TCs + one anti-regression spot-check. No
new unit or integration TCs — all underlying logic is already covered
by existing suites (verified in Context §1). The rigor ratio applies
within the new TCs only.

### Unit Tests

None added. Existing unit + integration coverage cited in Context
§"Why this spec is small" stays unchanged:

- `apps/server/app/manager/invites/actions.test.ts` — invite-create
  action + Zod schema (32+ TCs).
- `apps/server/lib/auth/allowed-sso-providers.test.ts` — schema bound
  and dedup transform.
- `apps/server/tests/integration/team-roster-csv.test.ts` — CSV
  route behavior with sso-auto/token/all/pre-v2-unknown filtering.

### Integration Tests

A small **helper** (`queryInviteByTokenPrefix`) is added under
`apps/server/tests/e2e/helpers/invite-probe.ts` for the DB probe in
TC-E2E-06. It is not a Vitest test surface — it's a pure helper.
Tests live in the spec files that consume it.

If `team-roster-csv.test.ts` happens to already test "sso-auto
filter returns the expected member subset", that's the integration
parallel of TC-E2E-07's UI assertion. We don't duplicate — the E2E
assertion is at a different layer (DOM + URL state, not SQL).

### E2E Tests

| TC | REQ | Category | Description | Expected |
| --- | --- | --- | --- | --- |
| TC-E2E-06 | REQ-1 | happy | Sign in as `alice@alpha.test`; visit `/manager/invites/create`; uncheck `google`, check `okta`; submit; assert redirect to `/manager/invites/created`; capture token from the `flash-onboard-url-value` element's text content (parse `#token=<64-hex>` fragment); SQL probe `onboarding_invites` by `left(token, 8) = <prefix>`; assert returned row's `allowed_sso_providers` deep-equals `['okta']` via `toEqual` (NOT `toBe` — arrays are reference-compared by `toBe`) | persisted, exactly ['okta'] |
| TC-E2E-06b | REQ-1 | validation | (Defensive — guard against the form silently accepting an empty selection) Sign in; visit invite create; uncheck ALL provider checkboxes; submit; assert the form does NOT redirect (it stays on `/manager/invites/create`) AND the `invite-create-error` element becomes visible AND its text matches `/invalid form data/i` (locks the `invalid_input` → `ERROR_LABEL` mapping in `invite-create-form.tsx:43` — the user-facing string for the `.min(1)` Zod failure); AND `queryInvitesCreatedSince(beforeMs)` (where `beforeMs = Date.now() - 2000` captured BEFORE the submit, for clock-skew tolerance) returns an empty array | form rejects + no row + error message stable |
| TC-E2E-07 | REQ-2 | happy | Sign in; visit `/manager/teams/<alpha-platform-team-id>`; assert initial URL has no `provisioned_via` query (defaults to `all`); click `provisioned_via=sso-auto` radio + Apply; `waitForURL(/provisioned_via=sso-auto/)`; **then `await page.waitForSelector('[data-testid="team-members-table"]')` to drain the streamed Server-Component render** (waitForURL alone fires before SSR completes — without this guard the next assertion can race and read a stale empty DOM); assert table row count ≥ 1; click `team-export-csv-link`; capture the `download` event; assert `download.suggestedFilename()` matches `/team-roster.*\.csv/i` | URL updates + table rendered (≥ 1 row) + CSV download |
| TC-E2E-07b | REQ-2 | edge | (Defensive — lock the export-link href format against future query-string drift; STANDALONE — does NOT rely on TC-E2E-07 runtime state). Fresh sign-in; navigate DIRECTLY to `/manager/teams/<alpha-platform-team-id>?provisioned_via=sso-auto`; assert the `team-export-csv-link` element's `href` attribute contains `provisioned_via=sso-auto` (so the CSV reflects the active filter) | href propagates filter |

**TC count**: 4 E2E (2 happy + 2 defensive/validation). Rigor: 2:2
within the new TCs. The "defensive" TCs catch silent-failure modes
the happy paths would miss (empty-selection submit + filter href
propagation). REQ-3 + REQ-4 are docs-only and verified by greps in
Validation Criteria, not new TCs.

### Anti-regression spot-check

Validation Criteria includes a `pnpm test:e2e` run that exercises
TC-E2E-03..05 (existing live tests) AND the new TC-E2E-06/07. Any
regression in the pre-existing TCs surfaces immediately.

## Design

### Architecture decisions

**Files to Modify**:

- `apps/server/tests/e2e/manager-ui.spec.ts` — replace lines 104..125
  (current `test.skip` blocks for TC-E2E-06 and TC-E2E-07) with four
  new live `test(...)` definitions (TC-E2E-06, TC-E2E-06b, TC-E2E-07,
  TC-E2E-07b). Add imports for the new probe helper + the seed-IDs
  helper. Also fix the stale `await page.goto('/manager/invites/new')`
  in the old TC-E2E-06 stub — the live route is
  `/manager/invites/create`.

- `apps/server/scripts/seed-manager-v2.ts` — add `provisionedVia:
  'sso-auto'` to a deterministic subset of **Alpha-platform team
  members** (`paula`, `quinn`, `rita` per lines 125-129). Concretely:
  set `provisionedVia: 'sso-auto'` when `userSpec.localPart === 'quinn'
  || userSpec.localPart === 'rita'`, leaving `paula` (the team manager)
  at the schema default `'pre-v2-unknown'`. This mixed-provisioning
  fixture exercises BOTH the `?provisioned_via=sso-auto` filter
  (returns 2 rows) AND the default `?provisioned_via=all` view (returns
  3 rows). The selection criteria are documented inline in the seed
  file so the test's "row count ≥ 1" assertion is stable against
  re-seeds and reviewable from the seed source.

**Files to Create**:

- `apps/server/tests/e2e/helpers/invite-probe.ts` — exports
  `queryInviteByTokenPrefix(prefix: string): Promise<InviteRow | null>`
  using the same `pg.Client` pattern as
  `helpers/audit-log-probe.ts`. Returns the row's `allowed_sso_providers`
  array + token prefix + created_at for the test's assertion.

**Files NOT modified** (verified during research, no need to touch):

- `apps/server/components/manager/invite-create-form.tsx` — already
  has all the `data-testid` attributes needed.
- `apps/server/app/manager/invites/created/page.tsx` — already has
  `flash-onboard-url-value`.
- `apps/server/app/manager/teams/[id]/page.tsx` — already has
  `team-detail-name`, `team-export-csv-link`,
  `team-members-filter-form`, `team-top-projects-table`.
- `apps/server/components/manager/team-detail-members.tsx` — already
  has `team-members-table`.

**Files to Modify** (closure):

- `roadmap.md` — remove items 1, 2, AND 3 of §"Ordem ideal de
  execução". See REQ-4 for the rationale (items 1+2 shipped in earlier
  commits but were never cleaned up).

**The probe helper** (`invite-probe.ts`):

Both probes follow the connect/query/finally-close pattern from
`helpers/audit-log-probe.ts`. **Time-window comparisons use the same
`new Date(sinceMs).toISOString()` → `> $1::timestamptz` shape as
`audit-log-probe.ts`** for cross-helper consistency (audited-log
review pinned this).

```ts
import { Client } from 'pg';

export type InviteRow = Readonly<{
  token_prefix: string;
  allowed_sso_providers: readonly string[];
  created_at: Date;
}>;

/**
 * Open a `pg.Client` from `DATABASE_URL`, wrap connect errors with
 * helper-name context so failures surface as "invite-probe: ..."
 * rather than an unhandled-rejection stack pointing at pg internals.
 */
const withClient = async <T>(
  label: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(`invite-probe(${label}): DB connect failed`, { cause: err });
  }
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
};

/**
 * Look up an `onboarding_invites` row by the 8-char token prefix
 * derived from a captured invite URL. The schema's expression index
 * `idx_onboarding_invites_prefix` (`left(token, 8)`) makes this a
 * single-row index scan.
 */
export const queryInviteByTokenPrefix = async (
  prefix: string,
): Promise<InviteRow | null> =>
  withClient('queryInviteByTokenPrefix', async (client) => {
    const res = await client.query<InviteRow>(
      `SELECT left(token, 8) AS token_prefix,
              allowed_sso_providers,
              created_at
         FROM onboarding_invites
        WHERE left(token, 8) = $1
        LIMIT 1`,
      [prefix],
    );
    return res.rows[0] ?? null;
  });
```

**Parsing the token from the flash URL**:

The flash UI renders the URL as `<BASE_URL>/onboard#token=<token>` inside
`[data-testid="flash-onboard-url-value"]` (built by
`buildOnboardingUrl` at `apps/server/app/manager/invites/actions.ts:134`).
The token is a 64-char lowercase hex string (`createInviteImpl` uses
`randomBytes(32).toString('hex')`). The Playwright test reads the
element's text content and extracts the token via a regex tight enough
to fail loud on a future scheme change:

```ts
const urlText = await page.getByTestId('flash-onboard-url-value').textContent();
const match = /#token=([0-9a-f]{64})/.exec(urlText ?? '');
// Throw-narrow (not `as`): TypeScript sees the if-throw as control-flow
// narrowing, so the subsequent `match[1]` is type-safe without a cast.
if (match === null) {
  throw new Error(`token fragment missing from flash URL: ${urlText ?? '<empty>'}`);
}
const tokenPrefix = match[1].slice(0, 8);
```

**The seeded team UUID**:

```ts
import { stableUuid } from '../../lib/e2e/seed-ids';
const ALPHA_PLATFORM_TEAM_ID = stableUuid('team:org-alpha:team-platform');
```

This matches the seed at `apps/server/scripts/seed-manager-v2.ts:192`
and avoids a hardcoded UUID literal.

**Empty-selection rejection (TC-E2E-06b)**:

The Zod schema at `apps/server/app/manager/invites/actions.ts:70`
declares `allowedSsoProvidersSchema` with `.min(1, 'allowed_sso_providers
requires at least one provider')`. The Server Action returns
`{ ok: false, error: '...' }` on validation failure; the form renders
the error in `[data-testid="invite-create-error"]` without redirecting.
The TC verifies BOTH the UI stays put AND no row was written, via a
time-window guard on the invites table:

```ts
// -2000ms matches the established margin in
// `tests/integration/team-roster-csv.test.ts`. CI testcontainer startup
// + clock drift routinely exceeds 500ms; 2s is safe and serial-test
// execution guarantees no cross-test invite-insert in this window.
const beforeMs = Date.now() - 2000;
// ... interact + submit ...
await expect(page).toHaveURL(/\/manager\/invites\/create/);  // didn't redirect
const errorEl = page.getByTestId('invite-create-error');
await expect(errorEl).toBeVisible();
// Lock the user-facing error text. The form maps the Server Action's
// `invalid_input` code to "Invalid form data. Check the fields." via
// the `ERROR_LABEL` table in `invite-create-form.tsx:40-43`. We don't
// lock the Zod source message because it never reaches the UI.
await expect(errorEl).toContainText(/invalid form data/i);
const newRows = await queryInvitesCreatedSince(beforeMs);
expect(newRows.length).toBe(0);
```

This requires a second probe helper, `queryInvitesCreatedSince`, on the
same file. Spec:

```ts
export type InviteRowMeta = Readonly<{
  token_prefix: string;
  allowed_sso_providers: readonly string[];
  created_at: Date;
}>;

/**
 * Return invites whose `created_at` is strictly after the given epoch-ms
 * marker. Used as a time-window guard for "no row should be written"
 * assertions in TC-E2E-06b. Callers should pass `Date.now() - 500` (or
 * similar margin) before the action that should NOT write to absorb host
 * vs db clock skew.
 */
export const queryInvitesCreatedSince = async (
  sinceMs: number,
): Promise<readonly InviteRowMeta[]> =>
  withClient('queryInvitesCreatedSince', async (client) => {
    // ISO-string + `$1::timestamptz` mirrors `audit-log-probe.ts:45-51`
    // so both probes share one time-comparison idiom.
    const sinceIso = new Date(sinceMs).toISOString();
    const res = await client.query<InviteRowMeta>(
      `SELECT left(token, 8) AS token_prefix,
              allowed_sso_providers,
              created_at
         FROM onboarding_invites
        WHERE created_at > $1::timestamptz
        ORDER BY created_at ASC`,
      [sinceIso],
    );
    return res.rows;
  });
```

Helper module note: Postgres-only via `pg.Client`. Consistent with
`helpers/audit-log-probe.ts`. Not portable to SQLite — and doesn't
need to be: the E2E stack already requires a real Postgres
testcontainer.

**Why DB probe, not UI read-back**:

The `/manager/invites/created` page renders only the show-once URL.
The `/manager/invites` list page shows token prefix + status + team +
email pattern but NOT `allowed_sso_providers`. Asserting persistence
via the UI is impossible without adding a column to the list page —
out of scope. The DB probe is the correct precision (and is already
the established pattern via `helpers/audit-log-probe.ts`).

### Dependencies

No new external packages. Reuses:

- `pg.Client` (already used by `helpers/audit-log-probe.ts`).
- `signInAs` from `helpers/sign-in-as.ts`.
- `stableUuid` from `lib/e2e/seed-ids.ts`.
- `@playwright/test` (existing dev dep).

## Tasks

- [x] **TASK-1**: Add the `helpers/invite-probe.ts` module with both
      probes (`queryInviteByTokenPrefix` + `queryInvitesCreatedSince`).
  - files: `apps/server/tests/e2e/helpers/invite-probe.ts` (NEW)
  - tests: (none directly — exercised by TC-E2E-06 / TC-E2E-06b)
  - depends: none

- [x] **TASK-2**: Expand the seed to mark a deterministic subset of
      Alpha-platform members as `provisionedVia: 'sso-auto'` so
      TC-E2E-07's filter returns a non-empty row set.
  - files: `apps/server/scripts/seed-manager-v2.ts` (MODIFY)
  - tests: (none directly — verified by TC-E2E-07 row-count assertion)
  - depends: none

- [x] **TASK-3**: Replace the two `test.skip` blocks in
      `manager-ui.spec.ts` with four live `test(...)` blocks
      (TC-E2E-06, TC-E2E-06b, TC-E2E-07, TC-E2E-07b). Add imports
      for the new probe + `stableUuid`. Fix the stale `/invites/new`
      URL to `/invites/create` (it's already part of the rewrite).
  - files: `apps/server/tests/e2e/manager-ui.spec.ts` (MODIFY)
  - tests: TC-E2E-06, TC-E2E-06b, TC-E2E-07, TC-E2E-07b
  - depends: TASK-1, TASK-2

- [x] **TASK-4**: Close roadmap items 1, 2, 3.
  - files: `roadmap.md` (MODIFY — remove items 1, 2, 3 of
    §"Ordem ideal de execução")
  - tests: (none — verified by Validation Criteria grep)
  - depends: TASK-3

- [x] **TASK-SMOKE**: Run targeted suite.
  - Run `pnpm --filter @tokenfx/server typecheck`
  - Run `pnpm --filter @tokenfx/server lint`
  - Run `pnpm --filter @tokenfx/server test --run` (sanity — no
    regressions in the integration TCs the E2E exercises)
  - Run `pnpm --filter @tokenfx/server test:e2e --grep "TC-E2E-(03|04|05|06|06b|07|07b)"`
  - If dev server fails to boot: log `E2E: DEFERRED` per project convention
  - files: (none — execution only)
  - tests: TC-E2E-03, TC-E2E-04, TC-E2E-05, TC-E2E-06, TC-E2E-06b, TC-E2E-07, TC-E2E-07b
  - depends: TASK-3, TASK-4
  - (executed inline; see Execution Log entry "TASK-SMOKE — out-of-scope infra fixes")

## Parallel Batches

```text
Batch 1: [TASK-1, TASK-2]   — helper module + seed expansion (independent files)
Batch 2: [TASK-3]           — spec file edits (depends on both)
Batch 3: [TASK-4]           — roadmap closure (depends on TASK-3)
Batch 4: [TASK-SMOKE]       — validation (depends on TASK-3 AND TASK-4 — the grep validation criteria check both the spec edits AND the roadmap, so SMOKE must follow the roadmap closure to avoid a false-positive run before items 1+2 are removed)
```

TASK-1 + TASK-2 touch independent files (`helpers/invite-probe.ts` is
NEW; `seed-manager-v2.ts` is an existing MODIFY) — safe to run in
parallel. TASK-3 imports from TASK-1's helper AND depends on TASK-2's
seed-shape change for its assertion to hold, so it lands in Batch 2.

## Validation Criteria

- [ ] `pnpm --filter @tokenfx/server typecheck` passes
- [ ] `pnpm --filter @tokenfx/server lint` passes
- [ ] `pnpm --filter @tokenfx/server test --run` passes (sanity —
      existing integration tests `actions.test.ts` +
      `team-roster-csv.test.ts` continue green)
- [ ] `pnpm --filter @tokenfx/server test:e2e` passes — both the
      new TC-E2E-06/06b/07/07b AND the pre-existing TC-E2E-03/04/05
      in `manager-ui.spec.ts`
- [ ] `pnpm build` (root) passes
- [ ] **Documentation closure**:
  - `grep "test\.skip" apps/server/tests/e2e/manager-ui.spec.ts`
    returns zero matches
  - `grep "sso-e2e-live-execution" roadmap.md` returns zero matches
  - `grep "sso-replay-audit-row\|sso-nonce-replay" roadmap.md`
    returns zero matches (items 1+2 also cleaned up per REQ-4)
- [ ] **Seed sanity**: after running `tsx scripts/seed-manager-v2.ts`,
      a SQL probe `SELECT count(*) FROM user_machines um JOIN users u
      ON u.id = um.user_id JOIN teams t ON t.id = u.team_id WHERE t.id
      = $alpha_platform_team_id AND um.provisioned_via = 'sso-auto'`
      returns ≥ 1. This is the regression signal that backs TC-E2E-07's
      "row count ≥ 1" assertion.
- [ ] **Live validation**: run `pnpm --filter @tokenfx/server test:e2e`
      against a fresh testcontainer + seed to confirm the spec ships.
- [ ] **No regressions**: 1234 server unit/integration TCs + 90
      idp-stub TCs continue passing.

## Execution Log

<!-- Ralph Loop appends here automatically — do not edit manually -->

### Batch 1 [TASK-1, TASK-2] (2026-05-13)

Worktree isolation bypassed: both spawned worktrees were on the unrelated `worktree-agent-*` branches (commit `90e949f`) which predate the `apps/server/` monorepo restructure. Both agents detected this and wrote directly to the main working tree. Orphan worktrees removed via `git worktree remove --force` + prune.

- TASK-1: NEW `apps/server/tests/e2e/helpers/invite-probe.ts` — `queryInviteByTokenPrefix` + `queryInvitesCreatedSince` + `withClient` connect-error wrapper. ISO-string + `$1::timestamptz` shape mirrors `audit-log-probe.ts`. Docstring margin updated 500ms → 2000ms post-merge to match spec.
- TASK-2: MODIFY `apps/server/scripts/seed-manager-v2.ts` — per-row conditional `provisionedVia: 'sso-auto'` for team-platform quinn + rita; paula and other teams unchanged. Inline comment cross-references TC-E2E-07.

Post-merge: `pnpm --filter @tokenfx/server typecheck` ✓ + `pnpm --filter @tokenfx/server lint` ✓.

### Batch 2 [TASK-3] (2026-05-13)

MODIFY `apps/server/tests/e2e/manager-ui.spec.ts`: replaced the two `test.skip` blocks with four live `test(...)` blocks (TC-E2E-06, TC-E2E-06b, TC-E2E-07, TC-E2E-07b). Added imports for `stableUuid` (seed-IDs) and the two `invite-probe` helpers. Inline note: the spec said `/at least one provider/i` for TC-E2E-06b's error message regex — corrected to `/invalid form data/i` after discovering the form maps `invalid_input` code through `ERROR_LABEL` (the Zod source message never reaches the UI). Spec table + Design code-block updated to match. CSV filename regex corrected to `/team-.*-roster-.*\.csv$/i` to match the actual `Content-Disposition` filename pattern `team-<id>-roster-<isoDate>.csv` from `export/route.ts:206`.

Post-merge: `pnpm --filter @tokenfx/server typecheck` ✓ + `pnpm --filter @tokenfx/server lint` ✓.

### Batch 3 [TASK-4] (2026-05-13)

MODIFY `roadmap.md`: removed the entire §"Ordem ideal de execução" block (items 1-3: `sso-replay-audit-row`, `sso-nonce-replay`, `sso-e2e-live-execution`). Updated "Last updated" footer to reflect the closure. The "Itens fora da lista ordenada" section is preserved. The trailing "Depois de resolver todas as pendências" checklist is preserved. Grep `sso-(replay-audit-row|nonce-replay|e2e-live-execution)` now matches only the changelog footer line.

### TASK-SMOKE — out-of-scope infra fixes (2026-05-14)

E2E validation surfaced three pre-existing infrastructure gaps that block live verification of the spec's TCs. All three are scoped fixes; none change product behavior.

1. **`apps/server/app/manager/invites/actions.ts` `'use server'` build error** — introduced by commit `a594dfa` (`sso-test-coverage-orphans`): the file exports a Zod schema + a typed-tuple const, which Next.js 15's Server Actions enforcement rejects at compile time (only async functions allowed). The error never surfaced before because no prior E2E visited `/manager/invites/create`. TC-E2E-06 + TC-E2E-06b are the first. Fix: extracted both non-function exports (`allowedSsoProvidersSchema`, `SSO_PROVIDER_VALUES`) into a new sibling `actions.schemas.ts` (no `'use server'`); `actions.ts` imports them internally; `actions.test.ts` updated to import from the schemas file. Unit tests (43) green post-refactor.

2. **Drizzle journal lag (`_journal.json` missing migrations 0004 + 0005)** — hand-crafted SQL migrations were committed without journal entries (committed in `cee4dcc`). `pnpm db:migrate` consequently skipped them in E2E global-setup, leaving the DB without the `provisioned_via` column at seed time. The integration suite's `tests/integration/setup-pg.ts` already handles this with orphan-apply logic; ported the same logic into `apps/server/tests/e2e/global-setup.ts` (read journal → diff against `*.sql` on disk → apply orphans with statement-breakpoint splitting + psql-substitution skip).

3. **`better-sqlite3` ABI mismatch (NODE_MODULE_VERSION 147 vs 141)** — workspace `.tool-versions` pins Node 25.9.0; brew's Node 26 was on PATH. `pnpm rebuild` initially used the wrong Node. Resolved with `asdf exec pnpm rebuild better-sqlite3`. Environmental — no code changed.

Files modified beyond the spec's stated scope: NEW `apps/server/app/manager/invites/actions.schemas.ts`; MODIFIED `apps/server/app/manager/invites/actions.ts` + `actions.test.ts` + `tests/e2e/global-setup.ts`.

**Live validation result** — `pnpm playwright test tests/e2e/manager-ui.spec.ts --grep "TC-E2E-(06|07)"`: status `passed`, failedTests `[]` per `test-results/.last-run.json`. All 4 new TCs (TC-E2E-06 invite-create persist, TC-E2E-06b empty-rejection, TC-E2E-07 filter+CSV, TC-E2E-07b href propagation) pass live against the full testcontainer+seed+dev-server+stub stack.

**Server-side validation (full vitest sweep)** — `asdf exec pnpm vitest --run`: 1150/1150 root tests pass. apps/server typecheck + lint pass. `app/manager/invites/actions.test.ts` (43 tests) + `tests/integration/team-roster-csv.test.ts` (verified earlier) pass.

**Out-of-scope follow-up flagged for user**: items 1+2 above are pre-existing bugs in main not caused by this spec — surfaced because this spec's TCs are the first to exercise the affected codepaths. The fixes ship in the same commit per the user's bundling preference unless instructed otherwise.
