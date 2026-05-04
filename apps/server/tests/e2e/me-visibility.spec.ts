/**
 * `/me/visibility` Playwright E2E suite — TASK-SMOKE-VISIBILITY
 * (manager-dashboard-v2 spec, REQ-17 + REQ-18).
 *
 * Covers:
 *   - TC-E2E-11 (REQ-17, happy): a dev (member role) logs in, visits
 *     `/me/visibility` after a manager has performed a drilldown on them.
 *     Page shows aggregated KPIs (cache_hit, good-session %, subagent
 *     adoption, tool mix) AND an audit log row with the manager's display
 *     label, reason, and timestamp. Per Anti-surveillance principle 5
 *     (LOCKED) the audit row continues to surface even if
 *     `org_settings.drilldown_notification_enabled` is later flipped off —
 *     this test flips it OFF in `beforeAll` and asserts the row still
 *     renders, exercising the principle in production.
 *
 *   - TC-E2E-12 (REQ-18, security): any rendered list of team members must
 *     be alphabetical by display label (COALESCE(display_name,
 *     split_part(email, '@', 1))). The DOM order has to match
 *     `display_name ASC`.
 *
 * --- Auth bypass strategy ----------------------------------------------------
 *
 * Reuses the NextAuth JWT cookie injection pattern from `manager.spec.ts`.
 * See that file's header for the full rationale; in short: we mint the same
 * JWT NextAuth would emit after sign-in and inject it as a cookie. The dev
 * server's `session` callback re-loads role + orgId from the seed each
 * request. Local-only — `signInAs` refuses to fire if BASE_URL ever drifts
 * off `localhost` (defense against a copy-paste landing an unsafe Set-Cookie
 * on a remote host).
 *
 * --- Drilldown audit fixture ------------------------------------------------
 *
 * The TASK-22 `--e2e` seed (`seed-server.ts --e2e`) does NOT pre-write
 * drilldown audit rows; that's owned by the manager-dashboard-v2 drilldown
 * route, which only fires on a real HTTP visit. Rather than couple this E2E
 * to the route, we INSERT a deterministic row directly via Drizzle in
 * `beforeAll`. The insert is idempotent: `manager_drilldown_audit` has a
 * UNIQUE on (manager_user_id, target_user_id, viewed_on, reason), so a
 * re-run of the suite is a no-op (existing row keeps the same `viewed_at`).
 *
 * Manager: alice@alpha.test (role 'admin', has manager scope on team
 * Frontend per the seed).
 * Target dev: bob@alpha.test (role 'member' on team Frontend).
 *
 * --- TC-E2E-12 — `/manager/teams/[id]/effectiveness` does not list members
 *
 * The spec text for TC-E2E-12 reads "any rendered list of team members".
 * The current `/manager/teams/[id]/effectiveness` page renders 4 KPI cards
 * + 4 trend charts and intentionally does NOT include a member roster
 * (member-level data on that page would itself be a leaderboard, contrary
 * to REQ-18). The closest existing alphabetical members table lives on
 * `/manager/teams/[id]` (the team detail page) and is rendered by
 * `team-detail-members.tsx` with `data-testid="team-members-table"`.
 *
 * Per the spec author's hint we exercise the actual member list there
 * AND keep a `test.skip()` placeholder for the effectiveness-page variant
 * with a documented reason, so the original TC-E2E-12 intent (effectiveness
 * page) is visibly deferred until that page grows a member list (or the
 * spec is amended to drop the requirement).
 *
 * --- Execution deferral ------------------------------------------------------
 *
 * Like `manager.spec.ts`, we honour `SKIP_PG_TESTS=1` so the suite is a
 * no-op when the testcontainer Postgres can't boot (CI runners without
 * Docker, etc.). We do NOT attempt to start the dev server from inside the
 * test — `global-setup.ts` owns that lifecycle.
 */
import { test, expect, type BrowserContext } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '../../lib/db/client';
import {
  managerDrilldownAudit,
  orgSettings,
} from '../../lib/db/schema';
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

// User IDs are derived from `seed-server.ts:stableUuid('user:<orgSlug>:<localPart>')`.
// We mirror the formula here so the audit-row INSERT references the same
// rows the seed writes.
const seedUserId = (orgSlug: string, localPart: string): string =>
  stableUuid(`user:${orgSlug}:${localPart}`);

const ALICE_USER_ID = seedUserId('org-alpha', 'alice');
const BOB_USER_ID = seedUserId('org-alpha', 'bob');

const SEED_USERS = {
  // Alpha admin — used as the "manager" who triggered the drilldown.
  aliceAdmin: {
    email: 'alice@alpha.test',
    ssoSubject: 'e2e:alice@alpha.test',
    role: 'admin',
    orgId: ALPHA_ORG_ID,
  },
  // Alpha member — the target dev whose `/me/visibility` we render.
  bobMember: {
    email: 'bob@alpha.test',
    ssoSubject: 'e2e:bob@alpha.test',
    role: 'member',
    orgId: ALPHA_ORG_ID,
  },
} as const satisfies Record<string, SeedUser>;

const DRILLDOWN_REASON = 'cost-investigation';
// Locked human-readable label rendered by `audit-log-table.tsx`'s
// `REASON_HUMAN` map. Kept in sync here so a label drift fails this test
// loudly instead of silently passing on a stale fixture.
const DRILLDOWN_REASON_LABEL = 'Cost investigation';
const DRILLDOWN_REASON_TEXT =
  'TC-E2E-11 fixture — investigating recent spend spike';

/**
 * Build a NextAuth-compatible session JWT for `user` and inject it on
 * `context`. Mirrors `manager.spec.ts:signInAs` — see that file for the
 * full rationale on why role/orgId are pre-populated on the cookie.
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

/**
 * Insert a deterministic drilldown audit row + flip the org's
 * `drilldown_notification_enabled` to `false` so we exercise principle 5
 * (the dev still sees historical rows even after the org disables
 * notifications).
 *
 * Idempotent: `manager_drilldown_audit` has a UNIQUE on
 * (manager_user_id, target_user_id, viewed_on, reason); `org_settings.org_id`
 * is a primary key so the org_settings upsert is also a no-op on re-run.
 */
const seedAuditFixture = async (): Promise<void> => {
  if (process.env.SKIP_PG_TESTS === '1') return;
  const db = getDb();

  // 1. Ensure org_settings row exists with notifications DISABLED. The
  //    audit row must still appear on /me/visibility regardless of this
  //    flag (REQ-17 + Design principle 5).
  await db
    .insert(orgSettings)
    .values({
      orgId: ALPHA_ORG_ID,
      drilldownNotificationEnabled: false,
    })
    .onConflictDoUpdate({
      target: orgSettings.orgId,
      set: {
        drilldownNotificationEnabled: false,
        updatedAt: sql`now()`,
      },
    });

  // 2. Insert (or no-op re-insert) the audit row that TC-E2E-11 asserts
  //    against. We bind every value via Drizzle's parameterized API
  //    (REQ-19) — never string-concat into SQL.
  await db
    .insert(managerDrilldownAudit)
    .values({
      orgId: ALPHA_ORG_ID,
      managerUserId: ALICE_USER_ID,
      targetUserId: BOB_USER_ID,
      reason: DRILLDOWN_REASON,
      reasonText: DRILLDOWN_REASON_TEXT,
      sourceRoute: '/manager/teams/frontend/devs/bob',
      // /24 IPv4 truncated CIDR; matches REQ-15 storage shape.
      ipAddressTrunc: '127.0.0.0/24',
      // viewed_on / viewed_at default to the server's CURRENT_DATE / now(),
      // but we pin them so the assertion doesn't drift on re-runs that
      // straddle a UTC midnight. `viewed_on` is a `date` column — Drizzle
      // accepts a YYYY-MM-DD string.
      viewedOn: '2026-05-01',
      viewedAt: new Date('2026-05-01T12:00:00Z'),
    })
    .onConflictDoNothing({
      target: [
        managerDrilldownAudit.managerUserId,
        managerDrilldownAudit.targetUserId,
        managerDrilldownAudit.viewedOn,
        managerDrilldownAudit.reason,
      ],
    });
};

/**
 * Restore the org's notification flag to its default `true` so other tests
 * (and re-runs of THIS file) start from the seed's expected state. The
 * audit row stays — append-only by design.
 */
const restoreOrgSettings = async (): Promise<void> => {
  if (process.env.SKIP_PG_TESTS === '1') return;
  const db = getDb();
  await db
    .update(orgSettings)
    .set({
      drilldownNotificationEnabled: true,
      updatedAt: sql`now()`,
    })
    .where(eq(orgSettings.orgId, ALPHA_ORG_ID));
};

test.describe('/me/visibility E2E (TASK-SMOKE-VISIBILITY)', () => {
  test.skip(
    process.env.SKIP_PG_TESTS === '1',
    'SKIP_PG_TESTS=1 — testcontainer Postgres unavailable, skipping E2E',
  );

  test.beforeAll(async () => {
    await seedAuditFixture();
  });

  test.afterAll(async () => {
    await restoreOrgSettings();
  });

  test('TC-E2E-11: dev sees aggregated KPIs + manager drilldown audit row (notifications OFF)', async ({
    page,
    context,
  }) => {
    await signInAs(context, SEED_USERS.bobMember);
    await page.goto(`${BASE_URL}/me/visibility`);

    // Page header — confirms we landed on the right route (member role
    // can reach /me/visibility per middleware matcher).
    await expect(
      page.locator('[data-testid="me-visibility-page"]'),
    ).toBeVisible();

    // Aggregated KPI tiles (REQ-17(a)). All four must be visible regardless
    // of underlying values — empty/zero data still renders the tiles per
    // the page's null-safe formatters.
    await expect(page.locator('[data-testid="kpi-cache-hit"]')).toBeVisible();
    await expect(page.locator('[data-testid="kpi-good-session"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="kpi-subagent-adoption"]'),
    ).toBeVisible();
    await expect(page.locator('[data-testid="kpi-tool-mix"]')).toBeVisible();

    // Audit log section + table (REQ-17(b)). With our seeded row, the
    // empty state must NOT render.
    await expect(
      page.locator('[data-testid="me-visibility-audit"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="audit-empty"]'),
    ).toHaveCount(0);

    const auditTable = page.locator('[data-testid="audit-log-table"]');
    await expect(auditTable).toBeVisible();

    // At least one audit row visible. We assert >= 1 (not exactly 1) so
    // future tests that legitimately seed extra rows for the same dev
    // don't false-fail this case — the principle being tested is
    // "the dev's drilldown shows up", not "exactly one drilldown ever".
    const rows = auditTable.locator('[data-testid="audit-row"]');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThanOrEqual(1);

    // The seeded row carries Alice's display label as the manager. Alice
    // has no `display_name` set in the E2E seed, so the COALESCE fallback
    // yields the email local-part ('alice'). REQ-18's display-label rule
    // covers this case — the audit query joins via the same COALESCE
    // expression.
    const aliceRow = rows.filter({ hasText: 'alice' }).first();
    await expect(aliceRow).toBeVisible();

    // Reason is rendered via the `REASON_HUMAN` map in audit-log-table.tsx
    // — 'cost-investigation' → 'Cost investigation'.
    await expect(aliceRow).toContainText(DRILLDOWN_REASON_LABEL);

    // Reason text (free-form note) renders in the last column verbatim.
    await expect(aliceRow).toContainText(DRILLDOWN_REASON_TEXT);

    // Timestamp formatting per `audit-log-table.tsx:formatViewedAt` —
    // `YYYY-MM-DD HH:MM UTC` (locale-free for stable SSR/CSR output).
    // We pinned the seed row to 2026-05-01T12:00:00Z.
    await expect(aliceRow).toContainText('2026-05-01 12:00 UTC');

    // Newest-first ordering: when there are multiple rows, the first row
    // must have the most recent timestamp. With a single seeded row this
    // collapses to "the seeded row IS the first row" — both shapes are
    // valid for REQ-17. We assert the first visible row contains Alice's
    // label rather than parsing every timestamp (cheaper + still
    // discriminating: a regression that flips to ASC order would put
    // future rows ahead of the 2026-05-01 fixture).
    const firstRow = rows.first();
    await expect(firstRow).toContainText('alice');

    // Pagination control renders the seeded total. Shape only — exact
    // count drifts if other tests seed more rows for this user.
    const paginationLabel = page.locator('[data-testid="audit-pagination"]');
    await expect(paginationLabel).toContainText(/Page \d+ of \d+/);
  });

  test('TC-E2E-12: team detail members table is alphabetical (REQ-18)', async ({
    page,
    context,
  }) => {
    // The original TC-E2E-12 spec text targets `/manager/teams/[id]/effectiveness`,
    // but that page intentionally renders no per-member roster (a roster
    // there would itself BE a leaderboard — the page is KPI/trend-only).
    // We exercise the requirement against the closest existing rendered
    // member list: `/manager/teams/[id]` → `team-members-table` (rendered
    // by `team-detail-members.tsx`, alphabetical per
    // `getTeamDetail` query, TC-I-33 covers the SQL ORDER BY clause
    // directly). See file header for the full deferral rationale.
    await signInAs(context, SEED_USERS.aliceAdmin);

    // Navigate via the org overview's team breakdown table to avoid
    // hardcoding a teamId UUID — the E2E seed uses deterministic IDs but
    // the team detail link round-trips through the rendered URL, which
    // is the path a real manager would take.
    await page.goto(`${BASE_URL}/manager`);
    const teamTable = page.locator('[data-testid="team-breakdown-table"]');
    await expect(teamTable).toBeVisible();
    await teamTable.getByRole('link', { name: 'Frontend' }).click();
    await expect(page).toHaveURL(/\/manager\/teams\/[^/]+/);

    // Members table emails — the first column renders the display label,
    // which for the seed users (no display_name set) collapses to the
    // email local-part via COALESCE(display_name, split_part(email,'@',1)).
    // Rendered values are full emails (e.g. 'alice@alpha.test') in
    // `team-detail-members.tsx`.
    const memberCells = await page
      .locator('[data-testid="team-members-table"] tbody tr td:first-child')
      .allTextContents();

    // Frontend team seed: alice@, bob@, carol@. With more users added
    // later this assertion stays valid as long as the order is alphabetical.
    expect(memberCells.length).toBeGreaterThanOrEqual(3);

    const sorted = [...memberCells].sort((a, b) => a.localeCompare(b));
    expect(memberCells).toEqual(sorted);

    // Negative assertion: the seed-known emails are present in the
    // expected alpha order (alice → bob → carol). This catches a
    // pathological case where every cell happens to be identical (which
    // would also pass `[].sort()` equality but isn't actually testing
    // ordering).
    expect(memberCells[0]).toContain('alice');
    expect(memberCells[memberCells.length - 1]).toContain('carol');
  });

  test.skip('TC-E2E-12 (effectiveness page variant): deferred — page renders no member list', () => {
    // `/manager/teams/[id]/effectiveness` is KPI/trend-only by design
    // (REQ-18 anti-leaderboard principle: a per-member roster on that
    // page would itself be a ranking surface). The spec text mentions
    // the effectiveness page as the example surface but the requirement
    // is scoped to "any rendered list of team members" — covered
    // directly above against `/manager/teams/[id]`'s `team-members-table`.
    // Re-enable if the effectiveness page ever grows a member list.
  });
});
