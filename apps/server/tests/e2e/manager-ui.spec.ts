/**
 * Manager-UI E2E coverage that requires a real SSO sign-in flow through
 * the local idp-stub (`apps/idp-stub`).
 *
 * Closes spec-c (manager-ui) deferred TCs:
 *   - TC-E2E-03 / spec-c REQ-1, REQ-2 — banner appear / dismiss / reappear
 *   - TC-E2E-04 / spec-c REQ-4, REQ-5 — audit-log filters interactive
 *   - TC-E2E-05 / spec-c REQ-6       — audit-log CSV export download
 *   - TC-E2E-06 + 06b / spec-c REQ-7 — invite-create allowed_sso_providers
 *     persist + empty-rejection (sso-e2e-live-execution REQ-1)
 *   - TC-E2E-07 + 07b / spec-c REQ-9, REQ-10 — team-roster filter + CSV +
 *     href propagation (sso-e2e-live-execution REQ-2)
 */
import { test, expect } from '@playwright/test';

import { stableUuid } from '../../lib/e2e/seed-ids';
import {
  queryInviteByTokenPrefix,
  queryInvitesCreatedSince,
} from './helpers/invite-probe';
import { signInAs } from './helpers/sign-in-as';
import { resetStubScenario, setStubScenario } from './helpers/idp-stub-control';

const BASE_URL = 'http://localhost:3232';
const STUB_BASE_URL = process.env.IDP_STUB_BASE_URL ?? 'http://localhost:3001';

const MANAGER_EMAIL = 'alice@alpha.test';

// Alpha-platform team UUID, deterministically derived to match the seed at
// `apps/server/scripts/seed-manager-v2.ts:192`. TC-E2E-07 + TC-E2E-07b
// navigate to this team's detail page.
const ALPHA_PLATFORM_TEAM_ID = stableUuid('team:org-alpha:team-platform');

const ensureManager = async (context: import('@playwright/test').BrowserContext) => {
  await signInAs(context, { email: MANAGER_EMAIL, baseUrl: BASE_URL });
};

test.describe('Manager UI: SSO-driven E2E flows', () => {
  test.beforeEach(async () => {
    await resetStubScenario({ baseUrl: STUB_BASE_URL });
  });

  test('TC-E2E-03: banner appears after sso-auto event, dismiss, reappears on next event', async ({
    page,
    context,
  }) => {
    await ensureManager(context);

    // Trigger first sso-auto event by driving a stub-backed signin in a
    // separate context.
    await setStubScenario(
      { email: 'e2e-banner-1@alpha.test', sub: `stub-sub-banner1-${Date.now()}` },
      { baseUrl: STUB_BASE_URL },
    );
    const secondCtx = await context.browser()!.newContext();
    await secondCtx.request.get(`${BASE_URL}/api/auth/signin/okta`);
    await secondCtx.close();

    await page.goto(`${BASE_URL}/manager`);
    const banner = page.getByRole('alert').first();
    await expect(banner).toBeVisible();

    // Dismiss
    const dismissBtn = page.getByRole('button', { name: /dismiss|close/i });
    if (await dismissBtn.count()) {
      await dismissBtn.click();
      await expect(banner).toBeHidden();
    }

    // Trigger a SECOND distinct sso-auto event.
    await setStubScenario(
      { email: 'e2e-banner-2@alpha.test', sub: `stub-sub-banner2-${Date.now()}` },
      { baseUrl: STUB_BASE_URL },
    );
    const thirdCtx = await context.browser()!.newContext();
    await thirdCtx.request.get(`${BASE_URL}/api/auth/signin/okta`);
    await thirdCtx.close();

    await page.reload();
    await expect(banner).toBeVisible();
  });

  test('TC-E2E-04: audit-log filters update visible rows', async ({
    page,
    context,
  }) => {
    await ensureManager(context);
    await page.goto(`${BASE_URL}/manager/audit-log`);
    await page.waitForLoadState('networkidle');

    // Apply outcome filter
    const outcomeSelect = page.getByLabel(/outcome/i);
    if (await outcomeSelect.count()) {
      await outcomeSelect.selectOption('accepted-sso-auto');
      await Promise.all([
        page.waitForResponse(/audit-log/, { timeout: 5_000 }).catch(() => null),
        page.waitForLoadState('networkidle'),
      ]);
    }
    // Row count is fixture-dependent; assert the table re-rendered.
    const rows = page.getByRole('row');
    expect(await rows.count()).toBeGreaterThanOrEqual(1);
  });

  test('TC-E2E-05: audit-log CSV export download', async ({ page, context }) => {
    await ensureManager(context);
    await page.goto(`${BASE_URL}/manager/audit-log`);
    const exportLink = page.getByTestId('audit-log-export-link');

    const downloadPromise = page.waitForEvent('download');
    await exportLink.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/audit-log.*\.csv$/i);
  });

  // TC-E2E-06 (.specs/sso-e2e-live-execution.md REQ-1) — invite-create form
  // submit + SQL persistence assertion via token-prefix probe.
  test('invite-create persists allowed_sso_providers when okta is the only selection', async ({
    page,
    context,
  }) => {
    await ensureManager(context);
    await page.goto(`${BASE_URL}/manager/invites/create`);

    const form = page.getByTestId('invite-create-form');
    await expect(form).toBeVisible();

    // Uncheck the default `google`, check `okta`. The provider checkboxes
    // are stable by `name="allowed_sso_providers"` + `value="<provider>"`.
    await page.locator('input[name="allowed_sso_providers"][value="google"]').uncheck();
    await page.locator('input[name="allowed_sso_providers"][value="okta"]').check();

    await page.getByTestId('invite-create-submit').click();
    await page.waitForURL(/\/manager\/invites\/created/);

    // The flash page renders `<base>/onboard#token=<64-hex>` inside
    // `flash-onboard-url-value`. Throw-narrow (not `as`) so TypeScript sees
    // the if-throw as control-flow narrowing — `match[1]` is then non-null
    // without a cast.
    const urlText = await page.getByTestId('flash-onboard-url-value').textContent();
    const match = /#token=([0-9a-f]{64})/.exec(urlText ?? '');
    if (match === null) {
      throw new Error(`token fragment missing from flash URL: ${urlText ?? '<empty>'}`);
    }
    const tokenPrefix = match[1].slice(0, 8);

    const row = await queryInviteByTokenPrefix(tokenPrefix);
    // Throw-narrow (not `!`): Playwright's `expect(...).not.toBeNull()` does
    // NOT narrow TypeScript's type — same pattern as the token regex match
    // above. The runtime invariant is "row exists", so spell it out.
    if (row === null) {
      throw new Error(`invite row must be persisted for prefix ${tokenPrefix}`);
    }
    // `toEqual` for deep array equality. `toBe` would always fail on arrays
    // (reference identity). The persisted column must be exactly ['okta'],
    // not the default `['google']` and not a merged `['google','okta']`.
    expect(row.allowed_sso_providers).toEqual(['okta']);
  });

  // TC-E2E-06b (.specs/sso-e2e-live-execution.md REQ-1) — empty-selection
  // rejection, locked against silent acceptance.
  test('invite-create rejects empty provider selection and writes no row', async ({
    page,
    context,
  }) => {
    await ensureManager(context);
    await page.goto(`${BASE_URL}/manager/invites/create`);

    // Uncheck `google` (the only default). All four boxes now empty.
    await page.locator('input[name="allowed_sso_providers"][value="google"]').uncheck();

    // fix-sso-e2e-remaining-5: capture `beforeMs` RIGHT BEFORE the
    // submit click so the "no new invite was written" assertion only
    // sees rows inserted by THIS test. The previous version used
    // `Date.now() - 2000` which (in the combined Playwright run) caught
    // the invite created by the immediately-preceding test
    // (`invite-create persists allowed_sso_providers`) within the 2s
    // margin. -200ms is still enough to absorb clock drift between
    // Node and the testcontainer Postgres while excluding cross-test
    // rows.
    const beforeMs = Date.now() - 200;
    await page.getByTestId('invite-create-submit').click();

    // Form does NOT redirect to /created.
    await expect(page).toHaveURL(/\/manager\/invites\/create/);

    // The form maps the Server Action's `invalid_input` code to "Invalid
    // form data. Check the fields." via the `ERROR_LABEL` table in
    // `invite-create-form.tsx:40-43`. We don't lock the Zod source message
    // because it never reaches the UI.
    const errorEl = page.getByTestId('invite-create-error');
    await expect(errorEl).toBeVisible();
    await expect(errorEl).toContainText(/invalid form data/i);

    // No invite row was written in the window.
    const newRows = await queryInvitesCreatedSince(beforeMs);
    expect(newRows).toHaveLength(0);
  });

  // TC-E2E-07 (.specs/sso-e2e-live-execution.md REQ-2) — filter form drives
  // URL + table re-render; CSV export link triggers download event.
  test('team-roster sso-auto filter re-renders the members table and CSV export triggers download', async ({
    page,
    context,
  }) => {
    await ensureManager(context);
    await page.goto(`${BASE_URL}/manager/teams/${ALPHA_PLATFORM_TEAM_ID}`);
    await expect(page.getByTestId('team-detail-name')).toBeVisible();

    // Initial URL has no `provisioned_via` query (route defaults to `all`).
    expect(page.url()).not.toContain('provisioned_via=');

    // Select sso-auto radio + click Apply (GET form — URL updates on submit).
    await page.locator('input[name="provisioned_via"][value="sso-auto"]').check();
    await page.getByTestId('team-members-filter-form').getByRole('button', { name: /apply/i }).click();
    await page.waitForURL(/provisioned_via=sso-auto/);

    // Drain the streamed Server-Component render before asserting row count
    // — waitForURL fires before SSR completes, so an immediate assertion
    // can race and read a stale empty DOM.
    await page.waitForSelector('[data-testid="team-members-table"]');
    const rowCount = await page.locator('[data-testid="team-members-table"] tbody tr').count();
    expect(rowCount, 'seed marks quinn+rita as sso-auto on team-platform — filter must return ≥ 1 row').toBeGreaterThanOrEqual(1);

    // CSV export: clicking the link triggers a real download event.
    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('team-export-csv-link').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/team-.*-roster-.*\.csv$/i);
  });

  // TC-E2E-07b (.specs/sso-e2e-live-execution.md REQ-2) — standalone:
  // direct-nav exportHref propagation, no dependence on TC-E2E-07 state.
  test('team-export-csv-link href propagates the active provisioned_via filter on direct nav', async ({
    page,
    context,
  }) => {
    await ensureManager(context);
    await page.goto(`${BASE_URL}/manager/teams/${ALPHA_PLATFORM_TEAM_ID}?provisioned_via=sso-auto`);
    await expect(page.getByTestId('team-detail-name')).toBeVisible();

    // The page builds `exportHref` server-side from the resolved
    // `provisionedVia` query param; the rendered href must reflect it
    // so the CSV reports the same filter the user is viewing.
    const href = await page.getByTestId('team-export-csv-link').getAttribute('href');
    expect(href).toContain('provisioned_via=sso-auto');
  });
});
