/**
 * Manager outcomes E2E suite — TASK-SMOKE for `manager-dashboard-v3-outcomes`.
 *
 * Covers TC-E2E-01..03 from `.specs/manager-dashboard-v3-outcomes.md`:
 *
 *   TC-E2E-01: Alpha admin → /manager/outcomes renders 4 outcome KPI cards
 *              + cost/LOC trend chart + per-team comparison table.
 *   TC-E2E-02: Gamma manager (1 team) → /manager/outcomes renders KPIs
 *              but the per-team comparison table is ABSENT from the DOM
 *              (REQ-14 mirrors Fase 4 REQ-13 1-team rule).
 *   TC-E2E-03: Dev (alice as admin doubles as a dev for /me view) →
 *              /me/visibility shows the 4 personal outcome KPI cards
 *              alongside the existing effectiveness KPIs.
 *
 * --- Auth bypass strategy --------------------------------------------------
 *
 * Same NextAuth-JWT-cookie injection as `manager-effectiveness.spec.ts`.
 * NOTE (deferred-execution status, mirrors Fase 4): the cookie-injection
 * pathway is currently failing under the running NextAuth v5 beta with
 * `ERR_TOO_MANY_REDIRECTS`. Roadmap entry: "fix-e2e-auth-bypass".
 * This spec compiles + matches the seed contract; execution will be re-run
 * once the underlying auth issue is resolved.
 *
 * --- Seed dependency -------------------------------------------------------
 *
 * Requires `seed-manager-v3-outcomes.ts` to have run AFTER
 * `seed-manager-v2.ts` AFTER `seed-server.ts --e2e`. The v3 seed:
 *   - Populates `team_outcomes_daily` for Alpha (3 teams × 7 days)
 *   - Populates ~5 `session_outcomes_agg` rows for alice (so /me/visibility
 *     shows non-zero personal outcome KPIs)
 *   - Leaves Gamma without outcome data → /manager/outcomes empty-state OR
 *     KPI rendering depending on the org-team count (TC-E2E-02 covers the
 *     1-team-no-comparison-table branch; the empty-state path is covered
 *     in lib-level integration TCs).
 *
 * Wiring into `tests/e2e/global-setup.ts` lands as a 1-line addition
 * after the v2 seed call (mirrors how v2 was wired in commit 328806d).
 */
import { test, expect } from '@playwright/test';
import { signInAs } from './helpers/sign-in-as';

import { e2eOrgId } from '../../lib/e2e/seed-ids';

const BASE_URL = 'http://localhost:3232';

type Role = 'admin' | 'manager' | 'member';

type SeedUser = {
  readonly email: string;
  readonly ssoSubject: string;
  readonly role: Role;
  readonly orgId: string;
};

const ALPHA_ORG_ID = e2eOrgId('org-alpha');
const GAMMA_ORG_ID = e2eOrgId('org-gamma');

const SEED_USERS = {
  aliceAdmin: {
    email: 'alice@alpha.test',
    ssoSubject: 'e2e:alice@alpha.test',
    role: 'admin',
    orgId: ALPHA_ORG_ID,
  },
  gabrielaManager: {
    email: 'gabriela@gamma.test',
    ssoSubject: 'e2e:gabriela@gamma.test',
    role: 'manager',
    orgId: GAMMA_ORG_ID,
  },
} as const satisfies Record<string, SeedUser>;

test.describe('manager outcomes E2E (TASK-SMOKE-OUTCOMES)', () => {
  test.skip(
    process.env.SKIP_PG_TESTS === '1',
    'SKIP_PG_TESTS=1 — testcontainer Postgres unavailable, skipping E2E',
  );

  test('TC-E2E-01: Alpha admin sees 4 outcome KPI cards + trend chart + per-team table', async ({
    page,
    context,
  }) => {
    await signInAs(context, { email: SEED_USERS.aliceAdmin.email });
    await page.goto(`${BASE_URL}/manager/outcomes`);

    // 4 headline KPIs (REQ-13).
    await expect(
      page.locator('[data-testid="kpi-cost-per-merged-loc"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="kpi-tokens-per-merged-loc"]'),
    ).toBeVisible();
    await expect(page.locator('[data-testid="kpi-revert-rate"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="kpi-avg-merged-prs"]'),
    ).toBeVisible();

    // Trend chart present (Recharts client component).
    await expect(
      page.locator('[data-testid="outcomes-trend-chart"]'),
    ).toBeVisible();

    // Per-team table present — Alpha has 3 teams seeded in v3 fixture.
    await expect(
      page.locator('[data-testid="per-team-outcomes-table"]'),
    ).toBeVisible();

    // Empty state is NOT present.
    await expect(
      page.locator('[data-testid="outcomes-empty-state"]'),
    ).toHaveCount(0);
  });

  test('TC-E2E-02: Gamma manager (1 team or empty) → per-team table absent from DOM', async ({
    page,
    context,
  }) => {
    await signInAs(context, { email: SEED_USERS.gabrielaManager.email });
    await page.goto(`${BASE_URL}/manager/outcomes`);

    // Positive presence assertion first — guarantees the page actually
    // rendered (not redirected, not blank, not 500). Without this, the
    // absence assertion below could pass for the wrong reason.
    await expect(
      page.locator('h1, [data-testid="outcomes-empty-state"]').first(),
    ).toBeVisible();

    // Gamma was deliberately left without outcome data in v3 seed —
    // the page should render the empty state OR the KPI cards (whichever
    // path the org's data lands on). Either way, the per-team comparison
    // table MUST be absent from the DOM (REQ-14).
    await expect(
      page.locator('[data-testid="per-team-outcomes-table"]'),
    ).toHaveCount(0);
  });

  test('TC-E2E-03: Dev /me/visibility shows 4 personal outcome KPI cards', async ({
    page,
    context,
  }) => {
    // Alice (admin) doubles as the dev under test — the v3 seed populates
    // her personal session_outcomes_agg rows so the page has data.
    await signInAs(context, { email: SEED_USERS.aliceAdmin.email });
    await page.goto(`${BASE_URL}/me/visibility`);

    // The new outcome KPI section.
    await expect(
      page.locator('[data-testid="me-visibility-outcomes"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="my-kpi-cost-per-merged-loc"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="my-kpi-tokens-per-merged-loc"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="my-kpi-revert-rate"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="my-kpi-avg-merged-prs"]'),
    ).toBeVisible();

    // The pre-existing effectiveness KPIs are still rendered alongside.
    await expect(
      page.locator('[data-testid="me-visibility-kpis"]'),
    ).toBeVisible();
  });
});
