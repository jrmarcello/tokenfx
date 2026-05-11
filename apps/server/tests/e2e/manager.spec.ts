/**
 * Manager UI Playwright E2E suite — TASK-SMOKE.
 *
 * Covers TC-E2E-01..05 (REQ-17, REQ-18, REQ-20, REQ-21, REQ-28). Runs against
 * the deterministic fixture seeded by `apps/server/scripts/seed-server.ts --e2e`
 * inside the Postgres testcontainer started by `global-setup.ts`.
 *
 * --- Auth bypass strategy ----------------------------------------------------
 *
 * NextAuth v5 in production drives sessions via Google/Okta OAuth. Wiring an
 * end-to-end OAuth dance into Playwright is non-portable (requires real
 * provider credentials) so we instead mint the same JWT NextAuth would emit
 * after a successful sign-in and inject it as a cookie via Playwright's
 * `context.addCookies`. The server's `session` callback re-loads role + orgId
 * from the DB on every request (see `apps/server/lib/auth/auth.ts:113-122`),
 * so the JWT only has to carry `email`, `sub`, and `ssoProvider` — the
 * `users` row seeded by `--e2e` (ssoProvider = 'e2e-seed') populates the
 * rest. Secret is read from `NEXTAUTH_SECRET` (matched server-side at
 * startup); we provide a deterministic fallback for local runs where the
 * env var is unset.
 *
 * This avoids:
 *   (a) shipping a Credentials-provider gate inside production auth.ts;
 *   (b) maintaining a separate `E2E_AUTH_BYPASS` middleware branch.
 *
 * The cost is one tiny coupling: cookie name + encode args must match what
 * NextAuth uses internally. Both come straight from the `next-auth/jwt`
 * public export, so library-version drift surfaces as a typecheck failure.
 *
 * --- TC-E2E-05 (empty-org) ---------------------------------------------------
 *
 * The `--e2e` seed (TASK-22) creates two NON-EMPTY orgs (Alpha + Beta). It
 * does not produce a third "admin user, zero pushed sessions" fixture, which
 * is what REQ-28's empty-org branch exercises. Implementing it in this file
 * would require either:
 *   (a) extending TASK-22's seed with an `--e2e-empty-org` flag, OR
 *   (b) a transactional truncate of one org's sessions/users from inside the
 *       test, which would couple this E2E spec to the server's drizzle
 *       client + open transactional bleed if the test crashes mid-run.
 *
 * Both are out of scope for TASK-SMOKE per the spec text. The REQ-28
 * rendering branch (`isEmptyOrg → <OnboardingCard />`) is exercised by the
 * unit-level overview integration tests; we mark this E2E case `test.skip`
 * with a clear reason so the suite passes once the auth flow is unblocked
 * upstream. Re-enable when seed-server.ts grows the empty-org variant.
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
const BETA_ORG_ID = e2eOrgId('org-beta');

const SEED_USERS = {
  // Alpha admin — has full manager access, used by TC-E2E-01..03.
  aliceAdmin: {
    email: 'alice@alpha.test',
    ssoSubject: 'e2e:alice@alpha.test',
    role: 'admin',
    orgId: ALPHA_ORG_ID,
  },
  // Alpha member — used for the 403 path in TC-E2E-04.
  bobMember: {
    email: 'bob@alpha.test',
    ssoSubject: 'e2e:bob@alpha.test',
    role: 'member',
    orgId: ALPHA_ORG_ID,
  },
  // Beta admin — used for the empty-org path in TC-E2E-05 after we clear
  // beta's sessions/users.
  frankAdmin: {
    email: 'frank@beta.test',
    ssoSubject: 'e2e:frank@beta.test',
    role: 'admin',
    orgId: BETA_ORG_ID,
  },
} as const satisfies Record<string, SeedUser>;

test.describe('manager UI E2E (TASK-SMOKE)', () => {
  test.skip(
    process.env.SKIP_PG_TESTS === '1',
    'SKIP_PG_TESTS=1 — testcontainer Postgres unavailable, skipping E2E',
  );

  test('TC-E2E-01: manager overview renders KPIs, team table, trend chart', async ({
    page,
    context,
  }) => {
    await signInAs(context, { email: SEED_USERS.aliceAdmin.email });
    await page.goto(`${BASE_URL}/manager`);

    // Spend KPI per spec (data-testid="kpi-spend-30d").
    await expect(page.locator('[data-testid="kpi-spend-30d"]')).toBeVisible();

    // Team breakdown table with Frontend + Backend rows (alpha org seed).
    const teamTable = page.locator('[data-testid="team-breakdown-table"]');
    await expect(teamTable).toBeVisible();
    await expect(teamTable.getByRole('link', { name: 'Frontend' })).toBeVisible();
    await expect(teamTable.getByRole('link', { name: 'Backend' })).toBeVisible();

    // Trend chart visible — TrendChart's outer wrapper carries the testId.
    await expect(page.locator('[data-testid="trend-spend-30d"]')).toBeVisible();
  });

  test('TC-E2E-02: DAU/WAU/MAU KPIs visible on overview', async ({
    page,
    context,
  }) => {
    await signInAs(context, { email: SEED_USERS.aliceAdmin.email });
    await page.goto(`${BASE_URL}/manager`);

    await expect(page.locator('[data-testid="kpi-dau"]')).toBeVisible();
    await expect(page.locator('[data-testid="kpi-wau"]')).toBeVisible();
    await expect(page.locator('[data-testid="kpi-mau"]')).toBeVisible();

    // Sanity-check: all three render numeric content (not NaN / blank). The
    // seed pushes 30 sessions across 7 days, so MAU ≥ 1 for the alpha org.
    const mauText = await page.locator('[data-testid="kpi-mau"]').innerText();
    expect(mauText).toMatch(/\b\d+\b/);
  });

  test('TC-E2E-03: team detail lists members alphabetically with project slugs', async ({
    page,
    context,
  }) => {
    await signInAs(context, { email: SEED_USERS.aliceAdmin.email });
    await page.goto(`${BASE_URL}/manager`);

    // Click into Frontend team via the breakdown table link.
    const teamTable = page.locator('[data-testid="team-breakdown-table"]');
    await teamTable.getByRole('link', { name: 'Frontend' }).click();
    await expect(page).toHaveURL(/\/manager\/teams\/[^/]+/);

    // Team detail header carries the team name.
    await expect(page.locator('[data-testid="team-detail-name"]')).toHaveText(
      'Frontend',
    );

    // Members table emails must be alphabetical (REQ-26 anti-leaderboard).
    // Frontend team seed: alice@, bob@, carol@.
    const memberEmails = await page
      .locator('[data-testid="team-members-table"] tbody tr td:first-child')
      .allTextContents();
    expect(memberEmails.length).toBeGreaterThanOrEqual(3);
    const sorted = [...memberEmails].sort((a, b) => a.localeCompare(b));
    expect(memberEmails).toEqual(sorted);

    // Top projects table must surface project slugs (seed creates
    // proj-org-alpha-{0,1,2}).
    const topProjects = page.locator('[data-testid="team-top-projects-table"]');
    await expect(topProjects).toBeVisible();
    const projectSlugs = await topProjects
      .locator('tbody tr td:first-child')
      .allTextContents();
    expect(projectSlugs.length).toBeGreaterThan(0);
    expect(projectSlugs.some((s) => s.startsWith('proj-org-alpha'))).toBe(true);
  });

  test('TC-E2E-04: member-role user hitting /manager gets 403', async ({
    page,
    context,
  }) => {
    await signInAs(context, { email: SEED_USERS.bobMember.email });
    const response = await page.goto(`${BASE_URL}/manager`);

    // Middleware short-circuits with 403 for member-role; the layout's
    // defense-in-depth would otherwise render `data-testid="manager-403"`.
    // Whichever path fires, the page must not leak manager data.
    if (response && response.status() === 403) {
      // Middleware path — body is plain "Manager role required".
      const body = await response.text();
      expect(body).toMatch(/Manager role required/i);
    } else {
      // Layout fallback — rendered HTML carries the manager-403 testid.
      await expect(page.locator('[data-testid="manager-403"]')).toBeVisible();
    }

    // Negative assertion: KPI tiles never reached the client.
    await expect(page.locator('[data-testid="kpi-spend-30d"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="team-breakdown-table"]')).toHaveCount(0);
  });

  test('TC-E2E-05: empty org renders onboarding card without crashing', async ({
    page,
    context,
  }) => {
    // Per spec, the `--e2e` seed creates 2 non-empty orgs. A separate
    // empty-org fixture is not part of TASK-22, so per the spec hint we
    // either implement against an additional setup hook OR document as
    // deferred. We choose the latter: clearing org Beta's sessions safely
    // requires DB access from inside the test runner, which would couple
    // this E2E spec to the server's drizzle client. Instead we exercise the
    // onboarding query path via the `getOrgOverview` integration test
    // covering the same REQ-28 branch (TC-I-* in overview.test.ts) and mark
    // this E2E case as deferred with a clear reason — the rendering branch
    // is exercised by the unit/integration layer, the only thing we lose
    // is the live HTTP path, which is mechanically identical to the other
    // four E2Es here.
    test.skip(
      true,
      'empty-org seed not produced by TASK-22 (only 2 populated orgs); REQ-28 covered by overview integration tests. Re-enable when seed-server.ts grows an --e2e-empty-org flag.',
    );
    await signInAs(context, { email: SEED_USERS.frankAdmin.email });
    await page.goto(`${BASE_URL}/manager`);
    await expect(page.locator('[data-testid="onboarding-card"]')).toBeVisible();
  });
});
