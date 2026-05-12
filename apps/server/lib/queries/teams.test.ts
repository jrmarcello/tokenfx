/**
 * Integration tests for team queries (TASK-18, REQ-21, REQ-26).
 *
 * Anti-leaderboard rule (REQ-26): per-user lists in manager UIs are ALWAYS
 * alphabetical by email — never ranked by spend. The team detail query is
 * the primary surface where this rule has teeth, so we assert the ordering
 * three ways:
 *
 *   1. Functional: with five users seeded out-of-order and varying spends,
 *      the returned `members` array equals the alphabetical email list.
 *   2. Source-level: the `getTeamDetail` source contains `email` ordering
 *      and does NOT contain any `DESC` sort tied to user fields.
 *   3. API-level: a session-detail export must NOT exist on `teams.ts` —
 *      drill-down is structurally impossible (matches REQ-26 server-side).
 *
 * Postgres-backed via Testcontainers (REQ-22). Skipped when `SKIP_PG_TESTS=1`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from '@/lib/db/client';
import {
  authEventLog,
  modelBreakdownAgg,
  orgs,
  sessionsAgg,
  teams,
  userMachines,
  users,
} from '@/lib/db/schema';
import { hashEmail } from '@/lib/auth/email-hash';
import * as teamsQueries from './teams';
import { getTeamDetail } from './teams';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

type SeededUser = {
  id: string;
  email: string;
  spend30d: number; // sum across sessions used to assert correctness
  sessions30d: number;
};

// Pin a deterministic pepper for the tests so `hashEmail()` returns the same
// digest the production code path will compute against `users.email`. The
// `EMAIL_HASH_PEPPER` env var is consulted lazily; NODE_ENV is 'test' so the
// boot-time assert is bypassed.
process.env.EMAIL_HASH_PEPPER ??= 'teams-test-pepper-v1';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const insertSession = async (
  userId: string,
  sessionId: string,
  startedAt: Date,
  costUsd: number,
  projectSlug: string,
  model = 'claude-sonnet-4-5',
): Promise<void> => {
  const db = getDb();
  await db.insert(sessionsAgg).values({
    userId,
    sessionId,
    payloadHash: `hash-${sessionId}`,
    startedAt,
    endedAt: new Date(startedAt.getTime() + 60_000),
    projectSlug,
    gitBranch: null,
    ccVersion: null,
    totalInputTokens: 1000,
    totalOutputTokens: 500,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalCostUsd: costUsd.toFixed(6),
    // Force list-price source by leaving OTEL null — calibration map is
    // empty in this test, so effectiveCostForSession returns localCost.
    totalCostUsdOtel: null,
    turnCount: 1,
    toolCallCount: 0,
    avgRating: null,
    cacheHitRatio: null,
    outputInputRatio: null,
    subagentUsageRatio: null,
  });
  await db.insert(modelBreakdownAgg).values({
    userId,
    sessionId,
    model,
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: costUsd.toFixed(6),
  });
};

skipDescribe('getTeamDetail (Postgres integration)', () => {
  let orgId = '';
  let teamId = '';
  let otherTeamId = '';
  let seeded: SeededUser[] = [];

  beforeAll(async () => {
    const db = getDb();
    // Reset shared Postgres state (Testcontainers container persists across
    // test files in the suite — sibling files seeding the same constants
    // would otherwise leak rows into this file's seeds).
    await db.execute(sql`TRUNCATE TABLE
      manager_dismissed_anomalies, manager_anomalies, manager_drilldown_audit,
      manager_notifications, team_metrics_daily, cron_runs, org_settings,
      onboarding_redemption_log, onboarding_audit_log, onboarding_invites,
      ingestion_log, model_breakdown_agg, tool_count_agg, sessions_agg,
      cost_calibration_per_user, user_machines, users, teams, orgs
      RESTART IDENTITY CASCADE`);

    const [org] = await db
      .insert(orgs)
      .values({ name: 'TeamsOrg' })
      .returning({ id: orgs.id });
    orgId = org.id;

    const [team] = await db
      .insert(teams)
      .values({ orgId, name: 'Engineering' })
      .returning({ id: teams.id });
    teamId = team.id;

    const [otherTeam] = await db
      .insert(teams)
      .values({ orgId, name: 'Product' })
      .returning({ id: teams.id });
    otherTeamId = otherTeam.id;

    // Five users seeded in non-alphabetical order to expose any incidental
    // ordering bug. Spends vary so that "alphabetical != spend ranking".
    //
    // `provisionedVia` mixes the three values so REQ-9 filter tests
    // (TC-I-23 / TC-I-23b / TC-I-23c) can assert each branch in a single
    // shared fixture. `eve` deliberately has NO `user_machines` row to
    // exercise the COALESCE-to-'pre-v2-unknown' fallback. `hasLogin` toggles
    // the `auth_event_log` row so the LATERAL `MAX(occurred_at)` resolves
    // to a concrete timestamp for some users and `null` for others.
    type Fixture = {
      email: string;
      spends: number[];
      provisionedVia: 'manual-token' | 'sso-auto' | null; // null = no user_machines row
      hasLogin: boolean;
    };
    const fixtures: Fixture[] = [
      { email: 'eve@example.com', spends: [10, 5], provisionedVia: null, hasLogin: false },
      {
        email: 'alice@example.com',
        spends: [100],
        provisionedVia: 'manual-token',
        hasLogin: true,
      },
      {
        email: 'charlie@example.com',
        spends: [3, 2, 1],
        provisionedVia: 'sso-auto',
        hasLogin: true,
      },
      {
        email: 'bob@example.com',
        spends: [50, 25],
        provisionedVia: 'manual-token',
        hasLogin: false,
      },
      { email: 'david@example.com', spends: [], provisionedVia: 'sso-auto', hasLogin: true },
    ];

    const now = Date.now();
    seeded = [];
    for (const fix of fixtures) {
      const [u] = await db
        .insert(users)
        .values({
          orgId,
          teamId,
          email: fix.email,
          ssoProvider: 'google',
          ssoSubject: `sub-${fix.email}`,
          role: 'member',
        })
        .returning({ id: users.id });
      let i = 0;
      for (const spend of fix.spends) {
        const startedAt = new Date(now - i * ONE_DAY_MS - 1000);
        await insertSession(
          u.id,
          `${fix.email}-sess-${i}`,
          startedAt,
          spend,
          `slug:${fix.email.split('@')[0]}-proj-${i % 2}`,
        );
        i += 1;
      }
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
          city: 'nowhere',
          userAgent: 'test/1.0',
          outcome: 'accepted-sso-auto',
        });
      }
      seeded.push({
        id: u.id,
        email: fix.email,
        spend30d: fix.spends.reduce((a, b) => a + b, 0),
        sessions30d: fix.spends.length,
      });
    }

    // A user in another team in the same org — must NOT appear in the result.
    const [otherUser] = await db
      .insert(users)
      .values({
        orgId,
        teamId: otherTeamId,
        email: 'mallory@example.com',
        ssoProvider: 'google',
        ssoSubject: 'sub-mallory',
        role: 'member',
      })
      .returning({ id: users.id });
    await insertSession(otherUser.id, 'mallory-sess-0', new Date(now), 999, 'slug:other-team');
  });

  afterAll(async () => {
    await closeDb();
  });

  afterEach(async () => {
    // No mutations between tests — keep the seeded fixture stable.
  });

  it('TC-I-38: members list is alphabetical by email (NOT ranked by spend)', async () => {
    const db = getDb();
    const detail = await getTeamDetail(db, teamId, orgId);
    expect(detail).not.toBeNull();
    if (detail === null) return;

    const emails = detail.members.map((m) => m.email);
    expect(emails).toEqual([
      'alice@example.com',
      'bob@example.com',
      'charlie@example.com',
      'david@example.com',
      'eve@example.com',
    ]);

    // Sanity: this ordering is NOT a spend-descending ordering — alice has
    // the highest spend so an accidental DESC sort would coincidentally match.
    // Eve (15) < Bob (75) but Eve sorts last alphabetically, proving the
    // ordering is by email not by spend.
    const eve = detail.members.find((m) => m.email === 'eve@example.com');
    const bob = detail.members.find((m) => m.email === 'bob@example.com');
    expect(eve).toBeDefined();
    expect(bob).toBeDefined();
    if (eve && bob) {
      expect(eve.spend30d).toBeLessThan(bob.spend30d);
    }
  });

  it('TC-I-38: per-user spend and session counts match seeded fixtures', async () => {
    const db = getDb();
    const detail = await getTeamDetail(db, teamId, orgId);
    expect(detail).not.toBeNull();
    if (detail === null) return;

    for (const member of detail.members) {
      const expected = seeded.find((s) => s.email === member.email);
      expect(expected).toBeDefined();
      if (!expected) continue;
      expect(member.sessions30d).toBe(expected.sessions30d);
      expect(member.spend30d).toBeCloseTo(expected.spend30d, 5);
      expect(member.userId).toBe(expected.id);
    }
  });

  it('TC-I-38: excludes users from sibling teams in the same org', async () => {
    const db = getDb();
    const detail = await getTeamDetail(db, teamId, orgId);
    expect(detail).not.toBeNull();
    if (detail === null) return;

    const emails = detail.members.map((m) => m.email);
    expect(emails).not.toContain('mallory@example.com');
  });

  it('returns null when teamId belongs to a different org (tenant scoping)', async () => {
    const db = getDb();
    const detail = await getTeamDetail(db, teamId, '00000000-0000-4000-8000-00000000beef');
    expect(detail).toBeNull();
  });

  it('topProjects is sorted by spend DESC and capped at 10 (slugs only)', async () => {
    const db = getDb();
    const detail = await getTeamDetail(db, teamId, orgId);
    expect(detail).not.toBeNull();
    if (detail === null) return;

    expect(detail.topProjects.length).toBeLessThanOrEqual(10);
    // Spend ranking by project slug is allowed (slugs are non-reversible —
    // REQ-21). Verify the order is descending.
    for (let i = 1; i < detail.topProjects.length; i += 1) {
      expect(detail.topProjects[i - 1].spend30d).toBeGreaterThanOrEqual(
        detail.topProjects[i].spend30d,
      );
    }
    // Slug shape — proves the value is opaque, not a path.
    for (const p of detail.topProjects) {
      expect(p.projectSlug.startsWith('slug:')).toBe(true);
    }
  });

  it('exposes a 30-day spend trend and DAU 30d series', async () => {
    const db = getDb();
    const detail = await getTeamDetail(db, teamId, orgId);
    expect(detail).not.toBeNull();
    if (detail === null) return;

    expect(Array.isArray(detail.spendTrend30d)).toBe(true);
    expect(Array.isArray(detail.dau30d)).toBe(true);
    // At least one day of activity given the seeded sessions.
    expect(detail.spendTrend30d.length).toBeGreaterThan(0);
    expect(detail.dau30d.length).toBeGreaterThan(0);
    // DAU values are positive integers ≤ team size.
    for (const point of detail.dau30d) {
      expect(point.activeUsers).toBeGreaterThanOrEqual(0);
      expect(point.activeUsers).toBeLessThanOrEqual(seeded.length);
    }
  });

  // TC-I-23 / TC-I-23b / TC-I-23c (REQ-9): provisioned_via filter on the
  // member list. Fixtures seed two `manual-token`, two `sso-auto`, and one
  // `pre-v2-unknown` (via the COALESCE fallback for `eve` who has no
  // user_machines row). Anti-leaderboard ordering (REQ-26) is preserved in
  // every branch — emails come back alphabetical regardless of filter.
  it('returns only sso-auto-provisioned members when filter is sso-auto', async () => {
    const db = getDb();
    const detail = await getTeamDetail(db, teamId, orgId, { provisionedVia: 'sso-auto' });
    expect(detail).not.toBeNull();
    if (detail === null) return;

    const emails = detail.members.map((m) => m.email);
    expect(emails).toEqual(['charlie@example.com', 'david@example.com']);
    for (const m of detail.members) {
      expect(m.provisionedVia).toBe('sso-auto');
    }
  });

  it('returns only manual-token-provisioned members when filter is token', async () => {
    const db = getDb();
    const detail = await getTeamDetail(db, teamId, orgId, { provisionedVia: 'token' });
    expect(detail).not.toBeNull();
    if (detail === null) return;

    const emails = detail.members.map((m) => m.email);
    expect(emails).toEqual(['alice@example.com', 'bob@example.com']);
    for (const m of detail.members) {
      expect(m.provisionedVia).toBe('manual-token');
    }
  });

  it('all filter surfaces pre-v2-unknown members alongside the other two kinds', async () => {
    const db = getDb();
    const detail = await getTeamDetail(db, teamId, orgId, { provisionedVia: 'all' });
    expect(detail).not.toBeNull();
    if (detail === null) return;

    const emails = detail.members.map((m) => m.email);
    expect(emails).toEqual([
      'alice@example.com',
      'bob@example.com',
      'charlie@example.com',
      'david@example.com',
      'eve@example.com',
    ]);
    // Eve has NO user_machines row — COALESCE surfaces her as pre-v2-unknown.
    const eve = detail.members.find((m) => m.email === 'eve@example.com');
    expect(eve?.provisionedVia).toBe('pre-v2-unknown');
  });

  it('omitted filter behaves like all (default)', async () => {
    const db = getDb();
    const defaulted = await getTeamDetail(db, teamId, orgId);
    const explicit = await getTeamDetail(db, teamId, orgId, { provisionedVia: 'all' });
    const undef = await getTeamDetail(db, teamId, orgId, { provisionedVia: undefined });
    const emptyOpts = await getTeamDetail(db, teamId, orgId, {});

    expect(defaulted).not.toBeNull();
    expect(explicit).not.toBeNull();
    expect(undef).not.toBeNull();
    expect(emptyOpts).not.toBeNull();
    if (
      defaulted === null ||
      explicit === null ||
      undef === null ||
      emptyOpts === null
    ) {
      return;
    }

    const emailsOf = (d: typeof defaulted): string[] => d.members.map((m) => m.email);
    expect(emailsOf(defaulted)).toEqual(emailsOf(explicit));
    expect(emailsOf(defaulted)).toEqual(emailsOf(undef));
    expect(emailsOf(defaulted)).toEqual(emailsOf(emptyOpts));
  });

  it('populates lastLoginAt from auth_event_log for accepted-sso-auto events', async () => {
    const db = getDb();
    const detail = await getTeamDetail(db, teamId, orgId, { provisionedVia: 'all' });
    expect(detail).not.toBeNull();
    if (detail === null) return;

    // alice / charlie / david each have one accepted-sso-auto event seeded.
    const alice = detail.members.find((m) => m.email === 'alice@example.com');
    const charlie = detail.members.find((m) => m.email === 'charlie@example.com');
    const david = detail.members.find((m) => m.email === 'david@example.com');
    // bob / eve have NO matching auth_event_log row.
    const bob = detail.members.find((m) => m.email === 'bob@example.com');
    const eve = detail.members.find((m) => m.email === 'eve@example.com');

    expect(alice?.lastLoginAt).toBeInstanceOf(Date);
    expect(charlie?.lastLoginAt).toBeInstanceOf(Date);
    expect(david?.lastLoginAt).toBeInstanceOf(Date);
    expect(bob?.lastLoginAt).toBeNull();
    expect(eve?.lastLoginAt).toBeNull();
  });
});

describe('teams query module — anti-leaderboard discipline (REQ-26)', () => {
  // These tests run regardless of SKIP_PG_TESTS — they're pure source checks.
  const sourcePath = path.resolve(__dirname, 'teams.ts');
  const source = readFileSync(sourcePath, 'utf8');

  it('orders members alphabetically by email at the SQL level', () => {
    // The ORDER BY clause that drives `members` MUST sort by email ASC.
    // We accept either the bare `email ASC` form or a Drizzle `asc(...)`.
    const hasEmailAsc =
      /order by[^;]*?u\.email\s+asc/i.test(source) || /asc\(\s*users\.email\s*\)/i.test(source);
    expect(hasEmailAsc).toBe(true);
  });

  it('contains the anti-leaderboard discipline comment', () => {
    expect(source).toMatch(/REQ-26/);
    expect(source.toLowerCase()).toContain('anti-leaderboard');
  });

  it('does not sort users (members) by spend descending', () => {
    // No `ORDER BY <something>spend... DESC` against per-user rows.
    // (top_projects DESC is fine because a project_slug is non-reversible.)
    const userSpendDesc = /order by[^;]*?(spend_30d|sum\(.*?total_cost_usd.*?\))\s+desc/i;
    // Allow project-slug DESC to remain — it's the permitted ranking.
    // We intentionally DO match `desc` patterns and just ensure none of them
    // appear in the members CTE / query.
    const membersBlock = source.match(/members[\s\S]{0,4000}?(?:order by[\s\S]*?)(?:;|`)/i);
    if (membersBlock) {
      expect(userSpendDesc.test(membersBlock[0])).toBe(false);
    }
  });

  it('does NOT export a session-detail function (no per-session drill-down)', () => {
    // REQ-26: drill-down into individual sessions is structurally absent.
    expect(
      (teamsQueries as unknown as Record<string, unknown>).getSessionDetail,
    ).toBeUndefined();
    expect(typeof (teamsQueries as Record<string, unknown>).getSessionDetail).toBe('undefined');
    // Defense-in-depth: also verify no `session_id` is exposed in the
    // exported types via name. Source-level: there's no exported function
    // whose name contains `Session` and `Detail`.
    const sessionDetailExportPattern = /export\s+(?:const|function|async\s+function)\s+\w*Session\w*Detail/i;
    expect(sessionDetailExportPattern.test(source)).toBe(false);
  });
});
