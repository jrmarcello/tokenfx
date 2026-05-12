/**
 * Integration tests for `GET /manager/teams/[id]/export` (REQ-10 / TASK-21).
 *
 * Postgres-backed via the shared Testcontainers setup
 * (`tests/integration/setup-pg.ts`). Tests call `exportTeamRosterImpl`
 * directly with a hand-written stub `authFn` so we exercise the role
 * gate + cross-org guard without spinning up NextAuth. The
 * `getTeamDetail` dep is invoked for real against the seeded DB so the
 * end-to-end query → CSV path is validated.
 *
 * TC coverage:
 *   - TC-I-25  (happy):       roster CSV columns + order match spec;
 *                             CRLF line endings; one row per member.
 *   - TC-I-25b (edge):        user with NO accepted-sso-auto event →
 *                             `last_login_at` cell is empty string
 *                             (NOT the literal "null").
 *   - TC-I-26  (security):    CSV NEVER contains a plaintext email; only
 *                             the 8-char peppered SHA-256 hash prefix.
 *   - filter integration:     `?provisioned_via=sso-auto` → only the two
 *                             sso-auto-provisioned users appear in CSV.
 *   - cross-org:              `getTeamDetail` returns null for a team in
 *                             another org → route emits 404.
 *   - member-role:            session with role=member → 403 before the
 *                             query runs (no roster data touched).
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import { sql } from 'drizzle-orm';
import type { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import { closeDb, getDb } from '@/lib/db/client';
import {
  authEventLog,
  orgs,
  teams,
  userMachines,
  users,
} from '@/lib/db/schema';
import { hashEmail } from '@/lib/auth/email-hash';
import { getTeamDetail } from '@/lib/queries/teams';
import {
  exportTeamRosterImpl,
  type AuthFn,
} from '@/app/manager/teams/[id]/export/route';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

// Use the env-var the production hash function reads. Vitest's globalSetup
// runs before this file, so setting it here at import time is observed by
// every `hashEmail()` call in this suite.
process.env.ONBOARDING_EMAIL_HASH_PEPPER ??= 'team-roster-csv-test-pepper';

const stubAuth =
  (session: Session | null): AuthFn =>
  async () => session;

const makeSession = (
  role: 'manager' | 'admin' | 'member',
  userId: string,
  orgId: string,
): Session => ({
  user: { id: userId, email: `${role}@x`, role, orgId },
  expires: '2099-01-01',
});

const makeReq = (teamId: string, query = ''): NextRequest => {
  const url = `http://localhost/manager/teams/${teamId}/export${query}`;
  // CSRF-on-GET guard requires sec-fetch-site=same-origin (or `none`) for
  // a legitimate request. See `.specs/fix-sso-csv-export-csrf.md`.
  return new NextRequest(url, {
    headers: new Headers({ 'sec-fetch-site': 'same-origin' }),
  });
};

type SeedFixture = {
  orgAId: string;
  orgBId: string;
  teamAId: string;
  teamBId: string;
  managerAId: string;
  memberAId: string;
  /** Five users in teamA — mixed provisioning + login history. */
  fixtures: ReadonlyArray<{
    userId: string;
    email: string;
    provisionedVia: 'manual-token' | 'sso-auto' | null;
    hasLogin: boolean;
  }>;
};

const seedFixture = async (): Promise<SeedFixture> => {
  const db = getDb();

  const [orgA] = await db
    .insert(orgs)
    .values({ name: 'CsvOrgA' })
    .returning({ id: orgs.id });
  const [orgB] = await db
    .insert(orgs)
    .values({ name: 'CsvOrgB' })
    .returning({ id: orgs.id });

  const [teamA] = await db
    .insert(teams)
    .values({ orgId: orgA.id, name: 'CsvTeamA' })
    .returning({ id: teams.id });
  const [teamB] = await db
    .insert(teams)
    .values({ orgId: orgB.id, name: 'CsvTeamB' })
    .returning({ id: teams.id });

  const [managerA] = await db
    .insert(users)
    .values({
      orgId: orgA.id,
      teamId: teamA.id,
      email: 'mgr-a@example.com',
      ssoProvider: 'google',
      ssoSubject: 'sub-mgr-a',
      role: 'manager',
    })
    .returning({ id: users.id });

  const [memberA] = await db
    .insert(users)
    .values({
      orgId: orgA.id,
      teamId: teamA.id,
      email: 'mbr-a@example.com',
      ssoProvider: 'google',
      ssoSubject: 'sub-mbr-a',
      role: 'member',
    })
    .returning({ id: users.id });

  type FixtureRow = {
    email: string;
    provisionedVia: 'manual-token' | 'sso-auto' | null;
    hasLogin: boolean;
  };
  const fixtureSeeds: FixtureRow[] = [
    { email: 'alice@example.com', provisionedVia: 'manual-token', hasLogin: true },
    { email: 'bob@example.com', provisionedVia: 'manual-token', hasLogin: false },
    { email: 'charlie@example.com', provisionedVia: 'sso-auto', hasLogin: true },
    { email: 'david@example.com', provisionedVia: 'sso-auto', hasLogin: true },
    // eve has NO user_machines row + NO login event → pre-v2-unknown,
    // last_login_at NULL (exercises TC-I-25b).
    { email: 'eve@example.com', provisionedVia: null, hasLogin: false },
  ];

  const fixtures: SeedFixture['fixtures'] = await Promise.all(
    fixtureSeeds.map(async (fix) => {
      const [u] = await db
        .insert(users)
        .values({
          orgId: orgA.id,
          teamId: teamA.id,
          email: fix.email,
          ssoProvider: 'google',
          ssoSubject: `sub-${fix.email}`,
          role: 'member',
        })
        .returning({ id: users.id });
      if (fix.provisionedVia !== null) {
        await db.insert(userMachines).values({
          userId: u.id,
          machineId: '00000000-0000-4000-8000-000000000001',
          keyId: `key-${fix.email}`,
          secretHash: 'bcrypt-stub',
          provisionedVia: fix.provisionedVia,
        });
      }
      if (fix.hasLogin) {
        await db.insert(authEventLog).values({
          ssoProvider: 'google',
          iss: 'https://accounts.google.com',
          emailHash: hashEmail(fix.email),
          ssoSubjectHash: `hash-sub-${fix.email}`,
          ip: '203.0.113.1',
          city: 'somewhere',
          userAgent: 'test/1.0',
          outcome: 'accepted-sso-auto',
        });
      }
      return {
        userId: u.id,
        email: fix.email,
        provisionedVia: fix.provisionedVia,
        hasLogin: fix.hasLogin,
      };
    }),
  );

  return {
    orgAId: orgA.id,
    orgBId: orgB.id,
    teamAId: teamA.id,
    teamBId: teamB.id,
    managerAId: managerA.id,
    memberAId: memberA.id,
    fixtures,
  };
};

const parseCsv = (body: string): { header: string; rows: string[] } => {
  const lines = body.split('\r\n');
  // Trailing CRLF produces a final empty entry — drop it.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const [header, ...rows] = lines;
  return { header, rows };
};

skipDescribe('GET /manager/teams/[id]/export (integration)', () => {
  let f: SeedFixture;

  beforeAll(async () => {
    const db = getDb();
    await db.execute(sql`TRUNCATE TABLE
      manager_dismissed_anomalies, manager_anomalies, manager_drilldown_audit,
      manager_notifications, team_metrics_daily, cron_runs, org_settings,
      onboarding_redemption_log, onboarding_audit_log, onboarding_invites,
      ingestion_log, model_breakdown_agg, tool_count_agg, sessions_agg,
      cost_calibration_per_user, user_machines, auth_event_log, users,
      teams, orgs
      RESTART IDENTITY CASCADE`);
    f = await seedFixture();
  });

  afterAll(async () => {
    await closeDb();
  });

  // ---------------------------------------------------------------------------
  // TC-I-25 — happy: roster CSV columns + order match spec.
  // ---------------------------------------------------------------------------
  it('TC-I-25 exports roster as CSV for authenticated manager', async () => {
    const session = makeSession('manager', f.managerAId, f.orgAId);
    const res = await exportTeamRosterImpl(
      makeReq(f.teamAId),
      { params: { id: f.teamAId } },
      { authFn: stubAuth(session), getTeamDetailFn: getTeamDetail },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(
      new RegExp(`^attachment; filename="team-${f.teamAId}-roster-\\d{4}-\\d{2}-\\d{2}\\.csv"$`),
    );
    expect(res.headers.get('X-TokenFx-Truncated')).toBe('false');

    const body = await res.text();
    // Body must use CRLF — explicit assertion since a stray \n would survive
    // .split('\n') silently.
    expect(body.endsWith('\r\n')).toBe(true);
    const { header, rows } = parseCsv(body);
    expect(header).toBe('email_hash_prefix,provisioned_via,created_at,last_login_at');
    // 5 fixture seeds + managerA ('mgr-a@example.com') + memberA ('mbr-a@example.com')
    // = 7 users on teamA. getTeamDetail returns ALL team members regardless of role.
    expect(rows).toHaveLength(7);

    // Verify the alphabetical email order is preserved by checking each
    // hash prefix matches the expected user's peppered SHA-256.
    const expectedOrder = [
      'alice@example.com',
      'bob@example.com',
      'charlie@example.com',
      'david@example.com',
      'eve@example.com',
      'mbr-a@example.com',
      'mgr-a@example.com',
    ];
    for (let i = 0; i < expectedOrder.length; i += 1) {
      const expectedPrefix = hashEmail(expectedOrder[i]).slice(0, 8);
      const cells = rows[i].split(',');
      expect(cells[0]).toBe(expectedPrefix);
    }
  });

  // ---------------------------------------------------------------------------
  // TC-I-25b — edge: NULL last_login_at → empty cell (NOT the literal "null").
  // ---------------------------------------------------------------------------
  it('TC-I-25b omits last_login_at when user has never logged in', async () => {
    const session = makeSession('manager', f.managerAId, f.orgAId);
    const res = await exportTeamRosterImpl(
      makeReq(f.teamAId),
      { params: { id: f.teamAId } },
      { authFn: stubAuth(session), getTeamDetailFn: getTeamDetail },
    );
    const body = await res.text();
    const { rows } = parseCsv(body);

    // Find Eve's row (5th alphabetically, no auth_event_log row seeded).
    const evePrefix = hashEmail('eve@example.com').slice(0, 8);
    const eveRow = rows.find((r) => r.startsWith(evePrefix));
    expect(eveRow).toBeDefined();
    if (!eveRow) return;
    const cells = eveRow.split(',');
    expect(cells).toHaveLength(4);
    // last_login_at is the 4th column; serialized as empty string.
    expect(cells[3]).toBe('');
    // Equally important — the body MUST NOT contain the literal "null".
    expect(body.toLowerCase()).not.toContain('null');
  });

  // ---------------------------------------------------------------------------
  // TC-I-26 — security: CSV NEVER carries plaintext email.
  // ---------------------------------------------------------------------------
  it('TC-I-26 never contains plaintext email addresses', async () => {
    const session = makeSession('manager', f.managerAId, f.orgAId);
    const res = await exportTeamRosterImpl(
      makeReq(f.teamAId),
      { params: { id: f.teamAId } },
      { authFn: stubAuth(session), getTeamDetailFn: getTeamDetail },
    );
    const body = await res.text();
    for (const fix of f.fixtures) {
      expect(body).not.toContain(fix.email);
      expect(body).not.toContain(fix.email.split('@')[0]);
    }
    // The `@` character is the cleanest invariant — no email shape anywhere.
    expect(body).not.toContain('@');
  });

  // ---------------------------------------------------------------------------
  // Filter integration: ?provisioned_via=sso-auto → only sso-auto users.
  // ---------------------------------------------------------------------------
  it('filters by provisioned_via=sso-auto in the exported CSV', async () => {
    const session = makeSession('manager', f.managerAId, f.orgAId);
    const res = await exportTeamRosterImpl(
      makeReq(f.teamAId, '?provisioned_via=sso-auto'),
      { params: { id: f.teamAId } },
      { authFn: stubAuth(session), getTeamDetailFn: getTeamDetail },
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    const { rows } = parseCsv(body);

    // Only the two sso-auto users (charlie + david).
    expect(rows).toHaveLength(2);
    const expectedPrefixes = [
      hashEmail('charlie@example.com').slice(0, 8),
      hashEmail('david@example.com').slice(0, 8),
    ];
    for (const row of rows) {
      const cells = row.split(',');
      expect(expectedPrefixes).toContain(cells[0]);
      expect(cells[1]).toBe('sso-auto');
    }
  });

  it('filters by provisioned_via=token in the exported CSV (maps to manual-token)', async () => {
    const session = makeSession('manager', f.managerAId, f.orgAId);
    const res = await exportTeamRosterImpl(
      makeReq(f.teamAId, '?provisioned_via=token'),
      { params: { id: f.teamAId } },
      { authFn: stubAuth(session), getTeamDetailFn: getTeamDetail },
    );
    const body = await res.text();
    const { rows } = parseCsv(body);

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const cells = row.split(',');
      expect(cells[1]).toBe('manual-token');
    }
  });

  // ---------------------------------------------------------------------------
  // Auth/cross-org guards.
  // ---------------------------------------------------------------------------
  it('returns 403 when the caller is a member-role user', async () => {
    const session = makeSession('member', f.memberAId, f.orgAId);
    const res = await exportTeamRosterImpl(
      makeReq(f.teamAId),
      { params: { id: f.teamAId } },
      { authFn: stubAuth(session), getTeamDetailFn: getTeamDetail },
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 when the team belongs to a different org', async () => {
    // Manager in orgA tries to export teamB (orgB) → getTeamDetail returns
    // null → route emits 404. No CSV body, no team data leaked across orgs.
    const session = makeSession('manager', f.managerAId, f.orgAId);
    const res = await exportTeamRosterImpl(
      makeReq(f.teamBId),
      { params: { id: f.teamBId } },
      { authFn: stubAuth(session), getTeamDetailFn: getTeamDetail },
    );
    expect(res.status).toBe(404);
  });
});
