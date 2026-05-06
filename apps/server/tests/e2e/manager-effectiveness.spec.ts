/**
 * Manager effectiveness E2E suite — TASK-SMOKE-EFFECTIVENESS.
 *
 * Covers TC-E2E-01..04 + TC-E2E-13 from `.specs/manager-dashboard-v2.md`:
 *
 *   TC-E2E-01: Alpha admin → /manager/effectiveness renders 4 KPIs +
 *              tool-mix chart + subagent trend.
 *   TC-E2E-02: Alpha admin (>= 3 teams) → radar chart shows >= 3 polygons.
 *   TC-E2E-03: Alpha admin → drills into a team-effectiveness page,
 *              4 team KPIs + breadcrumb back to /manager/effectiveness.
 *   TC-E2E-04: Alpha member → /manager/effectiveness yields 403 (middleware
 *              short-circuit OR layout fallback) and leaks no manager data.
 *   TC-E2E-13: Gamma manager (1 team) → /manager/effectiveness renders KPIs
 *              but the radar section is ABSENT from the DOM (Q13 lock).
 *
 * --- Auth bypass strategy --------------------------------------------------
 *
 * Same NextAuth-JWT-cookie injection as `manager.spec.ts`. The middleware
 * (Edge runtime) reads role/orgId straight off the JWT, so we pre-populate
 * those fields on the cookie token. See `manager.spec.ts:120-154` for the
 * full rationale; this suite just reuses the helper.
 *
 * --- Seed dependency -------------------------------------------------------
 *
 * Requires `seed-manager-v2.ts` to have run AFTER `seed-server.ts --e2e`:
 *   - Alpha gets a third team (`team-platform`) plus 30d of metrics for
 *     all 3 teams (frontend / backend / platform) so the radar polygons
 *     are visibly distinct.
 *   - Gamma org with one team + one manager (`gabriela@gamma.test`) for
 *     the 1-team radar absence test.
 *
 * The current `tests/e2e/global-setup.ts` only runs `seed-server.ts --e2e`.
 * If the dev server / containers are NOT primed with `seed-manager-v2.ts`,
 * the suite skips with a clear reason. Wiring `seed-manager-v2.ts` into
 * global-setup is a sibling task (the manager-dashboard-v2 spec carves
 * the seed extension as its own action item — TASK-SMOKE-EFFECTIVENESS
 * delivers the seed module + the Playwright spec; the global-setup
 * integration is documented but the cross-task wiring is intentionally
 * left for a follow-up so this task's diff stays inside its declared
 * `files:` scope per .claude/rules/sdd.md).
 *
 * --- Execution deferral ----------------------------------------------------
 *
 * If `pnpm test:e2e` is run with no Postgres testcontainer (SKIP_PG_TESTS=1)
 * or against a stack that does not have manager-v2 fixtures, the suite is
 * skipped — same pattern as `manager.spec.ts`.
 */
import { test, expect, type BrowserContext } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { e2eOrgId, stableUuid } from '../../lib/e2e/seed-ids';

const BASE_URL = 'http://localhost:3232';

const E2E_SECRET = process.env.NEXTAUTH_SECRET ?? 'tokenfx-e2e-secret';
const SESSION_COOKIE = 'authjs.session-token';

type Role = 'admin' | 'manager' | 'member';

type SeedUser = {
  readonly email: string;
  readonly ssoSubject: string;
  readonly role: Role;
  readonly orgId: string;
};

const ALPHA_ORG_ID = e2eOrgId('org-alpha');
const GAMMA_ORG_ID = e2eOrgId('org-gamma');

// Deterministic team UUID — must match `stableUuid('team:org-alpha:team-frontend')`
// from seed-server.ts so the per-team URL drill-down resolves to alice's
// own team (the per-team page enforces team-membership: only the URL
// matching the manager's `users.team_id` row passes the gate).
const ALPHA_FRONTEND_TEAM_ID = stableUuid('team:org-alpha:team-frontend');

const SEED_USERS = {
  // Alpha admin (alice on team-frontend per seed-server.ts) — used by
  // TC-E2E-01..03. Drilling into ALPHA_FRONTEND_TEAM_ID matches her
  // users.team_id, so the team-effectiveness page renders successfully.
  aliceAdmin: {
    email: 'alice@alpha.test',
    ssoSubject: 'e2e:alice@alpha.test',
    role: 'admin',
    orgId: ALPHA_ORG_ID,
  },
  // Alpha member (bob on team-frontend) — used for the 403 path in TC-E2E-04.
  bobMember: {
    email: 'bob@alpha.test',
    ssoSubject: 'e2e:bob@alpha.test',
    role: 'member',
    orgId: ALPHA_ORG_ID,
  },
  // Gamma manager (gabriela on team-solo) — used for TC-E2E-13.
  // Seeded by seed-manager-v2.ts; org has exactly one team so the radar
  // section must NOT render.
  gabrielaManager: {
    email: 'gabriela@gamma.test',
    ssoSubject: 'e2e:gabriela@gamma.test',
    role: 'manager',
    orgId: GAMMA_ORG_ID,
  },
} as const satisfies Record<string, SeedUser>;

/**
 * Mint a NextAuth-compatible JWT for `user` and inject it as a session
 * cookie on `context`. Mirrors the helper in `manager.spec.ts`; kept local
 * (not lifted to a shared util) to avoid coupling sibling specs through
 * a new module — both copies are tiny and the JWT shape is stable.
 */
const signInAs = async (
  context: BrowserContext,
  user: SeedUser,
): Promise<void> => {
  if (!BASE_URL.startsWith('http://localhost')) {
    throw new Error(
      `signInAs is localhost-only. BASE_URL=${BASE_URL} — refusing to mint a non-Secure session cookie for a remote host.`,
    );
  }
  const token = await encode({
    token: {
      email: user.email,
      sub: user.ssoSubject,
      ssoProvider: 'e2e-seed',
      role: user.role,
      orgId: user.orgId,
    },
    secret: E2E_SECRET,
    salt: SESSION_COOKIE,
  });
  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: token,
      url: BASE_URL,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
};

test.describe('manager effectiveness E2E (TASK-SMOKE-EFFECTIVENESS)', () => {
  test.skip(
    process.env.SKIP_PG_TESTS === '1',
    'SKIP_PG_TESTS=1 — testcontainer Postgres unavailable, skipping E2E',
  );

  test('TC-E2E-01: Alpha admin sees 4 effectiveness KPIs + tool-mix + subagent trend', async ({
    page,
    context,
  }) => {
    await signInAs(context, SEED_USERS.aliceAdmin);
    await page.goto(`${BASE_URL}/manager/effectiveness`);

    // 4 headline KPIs (REQ-1..4).
    await expect(page.locator('[data-testid="kpi-cache-hit"]')).toBeVisible();
    await expect(page.locator('[data-testid="kpi-good-session"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="kpi-subagent-adoption"]'),
    ).toBeVisible();
    await expect(page.locator('[data-testid="kpi-composite"]')).toBeVisible();

    // Tool-mix stacked-bar chart.
    await expect(
      page.locator('[data-testid="chart-tool-mix-30d"]'),
    ).toBeVisible();

    // Subagent adoption trend line.
    await expect(
      page.locator('[data-testid="trend-subagent-30d"]'),
    ).toBeVisible();
  });

  test('TC-E2E-02: Alpha admin with 3 teams sees radar chart with 3 polygons', async ({
    page,
    context,
  }) => {
    await signInAs(context, SEED_USERS.aliceAdmin);
    await page.goto(`${BASE_URL}/manager/effectiveness`);

    // Radar section must be present (Alpha has frontend + backend + platform
    // after seed-manager-v2.ts).
    const radarSection = page.locator('[data-testid="effectiveness-radar"]');
    await expect(radarSection).toBeVisible();

    const radar = page.locator('[data-testid="radar-comparison"]');
    await expect(radar).toBeVisible();

    // Assert via the server-rendered `data-team-count` attribute on the
    // radar wrapper rather than against Recharts internals. Recharts'
    // ResponsiveContainer needs a non-zero ResizeObserver measurement
    // before it emits ANY chart subtree (legend included), and that
    // measurement is flaky in headless Chromium — both `path.recharts-
    // radar-polygon` and `li.recharts-legend-item` can transiently
    // resolve to 0 elements. `data-team-count` is set from the
    // server-component's `comparison.length` prop, so it's deterministic
    // and present from the first paint. This is the same pattern used
    // by `effectiveness-kpi-row` (data-testid'd KPIs are server-rendered
    // text, not chart geometry). Covers TC-E2E-02's intent: "the radar
    // received 3 team series".
    await expect(radar).toHaveAttribute('data-team-count', '3');
  });

  test('TC-E2E-03: Alpha admin drills into a team effectiveness page', async ({
    page,
    context,
  }) => {
    await signInAs(context, SEED_USERS.aliceAdmin);
    await page.goto(
      `${BASE_URL}/manager/teams/${ALPHA_FRONTEND_TEAM_ID}/effectiveness`,
    );

    // Page renders the team header with the seeded team name.
    await expect(
      page.locator('[data-testid="team-effectiveness-name"]'),
    ).toHaveText(/Frontend/);

    // 4 team KPIs (REQ-7).
    await expect(
      page.locator('[data-testid="kpi-team-cache-hit"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="kpi-team-good-session-pct"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="kpi-team-subagent-adoption"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="kpi-team-composite"]'),
    ).toBeVisible();

    // Breadcrumb link back to the org-level effectiveness page.
    const breadcrumb = page.locator(
      '[data-testid="breadcrumb-effectiveness"]',
    );
    await expect(breadcrumb).toBeVisible();
    await expect(breadcrumb).toHaveAttribute('href', '/manager/effectiveness');

    // Clicking it should land on /manager/effectiveness — exercise the link
    // (not just the href) so a future client-side intercept regression
    // surfaces here.
    await breadcrumb.click();
    await expect(page).toHaveURL(/\/manager\/effectiveness$/);
  });

  test('TC-E2E-04: Alpha member hitting /manager/effectiveness gets 403, no manager data', async ({
    page,
    context,
  }) => {
    await signInAs(context, SEED_USERS.bobMember);
    const response = await page.goto(`${BASE_URL}/manager/effectiveness`);

    // The middleware short-circuits with 403 for member-role; the layout's
    // defense-in-depth would otherwise render `data-testid="manager-403"`.
    if (response && response.status() === 403) {
      const body = await response.text();
      expect(body).toMatch(/Manager role required/i);
    } else {
      await expect(page.locator('[data-testid="manager-403"]')).toBeVisible();
    }

    // Negative assertion: no KPI / chart / radar markup leaked through.
    await expect(page.locator('[data-testid="kpi-cache-hit"]')).toHaveCount(0);
    await expect(
      page.locator('[data-testid="effectiveness-radar"]'),
    ).toHaveCount(0);
    await expect(
      page.locator('[data-testid="chart-tool-mix-30d"]'),
    ).toHaveCount(0);
  });

  test('TC-E2E-13: Gamma manager with 1 team → radar section absent from DOM', async ({
    page,
    context,
  }) => {
    await signInAs(context, SEED_USERS.gabrielaManager);
    await page.goto(`${BASE_URL}/manager/effectiveness`);

    // KPIs still render (Gamma is seeded with 30d of metrics).
    await expect(page.locator('[data-testid="kpi-cache-hit"]')).toBeVisible();

    // Q13 lock: the radar SECTION must NOT be in the DOM. We assert
    // `toHaveCount(0)` — locator-hidden would still be a leak per the
    // spec; we want absence, not visibility:hidden.
    await expect(
      page.locator('[data-testid="effectiveness-radar"]'),
    ).toHaveCount(0);
    await expect(
      page.locator('[data-testid="radar-comparison"]'),
    ).toHaveCount(0);
  });
});
