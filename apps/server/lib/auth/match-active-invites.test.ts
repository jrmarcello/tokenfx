/**
 * Integration tests for `matchActiveInvitesByEmail()` — REQ-5
 * (central-server-onboarding-v2-sso).
 *
 * Verifies:
 *   - Pattern matching parity with `matchEmailPattern` (delegation): domain
 *     wildcard + case-insensitive + non-match.
 *   - SQL activity filter: revoked / expired / exhausted invites are
 *     excluded.
 *   - Multi-org: the helper does not collapse by org_id; every matching
 *     active invite is returned (the caller decides what "exactly one"
 *     means).
 *   - Normalization: trailing whitespace + mixed-case emails normalize.
 *   - IDN-via-punycode equivalence is preserved through the helper.
 *
 * Postgres-backed via Testcontainers (shared via setup-pg.ts). Each test
 * deletes its own writes in `afterEach` so cases stay order-independent.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from '@/lib/db/client';
import { onboardingInvites, orgs, teams } from '@/lib/db/schema';
import { matchActiveInvitesByEmail } from './match-active-invites';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

type SeedOrg = { orgId: string; teamId: string };

const seedOrg = async (name: string): Promise<SeedOrg> => {
  const db = getDb();
  const [org] = await db.insert(orgs).values({ name }).returning({ id: orgs.id });
  const [team] = await db
    .insert(teams)
    .values({ orgId: org.id, name: `${name}-team` })
    .returning({ id: teams.id });
  return { orgId: org.id, teamId: team.id };
};

const make64HexToken = (label: string): string => {
  const seed = label.padEnd(32, 'x');
  return Buffer.from(seed).toString('hex').padEnd(64, '0').slice(0, 64);
};

type SeedInviteOpts = {
  orgId: string;
  teamId?: string | null;
  token: string;
  emailPattern: string | null;
  maxUses?: number;
  usedCount?: number;
  expiresInMs?: number;
  revokedAt?: Date | null;
  allowedSsoProviders?: string[];
};

const seedInvite = async (opts: SeedInviteOpts): Promise<void> => {
  const db = getDb();
  await db.insert(onboardingInvites).values({
    token: opts.token,
    orgId: opts.orgId,
    teamId: opts.teamId ?? null,
    emailPattern: opts.emailPattern,
    maxUses: opts.maxUses ?? 1,
    usedCount: opts.usedCount ?? 0,
    expiresAt: new Date(Date.now() + (opts.expiresInMs ?? 8 * 60 * 60 * 1000)),
    revokedAt: opts.revokedAt ?? null,
    allowedSsoProviders: opts.allowedSsoProviders ?? [],
  });
};

skipDescribe('matchActiveInvitesByEmail (REQ-5)', () => {
  beforeAll(async () => {
    const db = getDb();
    await db.execute(sql`TRUNCATE TABLE
      onboarding_redemption_log, onboarding_audit_log, onboarding_invites,
      ingestion_log, model_breakdown_agg, tool_count_agg, sessions_agg,
      cost_calibration_per_user, user_machines, users, teams, orgs
      RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    await closeDb();
  });

  let primary: SeedOrg;

  beforeEach(async () => {
    primary = await seedOrg('MatchActive-Primary');
  });

  afterEach(async () => {
    const db = getDb();
    await db.delete(onboardingInvites);
    await db.delete(teams);
    await db.delete(orgs);
  });

  // -----------------------------------------------------------------------
  // Happy path — domain wildcard match (TC-U-16).
  // -----------------------------------------------------------------------
  it('matches dev+tag@x.com against *@x.com pattern (plus-tag preserved)', async () => {
    const token = make64HexToken('match-plus-tag');
    await seedInvite({
      orgId: primary.orgId,
      teamId: primary.teamId,
      token,
      emailPattern: '*@x.com',
    });

    const results = await matchActiveInvitesByEmail('dev+tag@x.com');
    expect(results).toHaveLength(1);
    expect(results[0].token).toBe(token);
    expect(results[0].orgId).toBe(primary.orgId);
    expect(results[0].teamId).toBe(primary.teamId);
    expect(results[0].emailPattern).toBe('*@x.com');
  });

  // -----------------------------------------------------------------------
  // Case-insensitive match (TC-U-17).
  // -----------------------------------------------------------------------
  it('matches DEV@X.COM against *@x.com pattern (case-insensitive)', async () => {
    const token = make64HexToken('match-case-insens');
    await seedInvite({
      orgId: primary.orgId,
      teamId: primary.teamId,
      token,
      emailPattern: '*@x.com',
    });

    const results = await matchActiveInvitesByEmail('DEV@X.COM');
    expect(results).toHaveLength(1);
    expect(results[0].token).toBe(token);
  });

  // -----------------------------------------------------------------------
  // Wrong domain → no match (TC-U-18).
  // -----------------------------------------------------------------------
  it('does not match dev@y.com against *@x.com', async () => {
    const token = make64HexToken('match-wrong-domain');
    await seedInvite({
      orgId: primary.orgId,
      teamId: primary.teamId,
      token,
      emailPattern: '*@x.com',
    });

    const results = await matchActiveInvitesByEmail('dev@y.com');
    expect(results).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Excludes revoked invites (TC-I-18, activity filter — revoked branch).
  // -----------------------------------------------------------------------
  it('excludes invites with revoked_at set', async () => {
    const liveToken = make64HexToken('match-revoke-live');
    const revokedToken = make64HexToken('match-revoke-dead');
    await seedInvite({
      orgId: primary.orgId,
      teamId: primary.teamId,
      token: liveToken,
      emailPattern: '*@x.com',
    });
    await seedInvite({
      orgId: primary.orgId,
      teamId: primary.teamId,
      token: revokedToken,
      emailPattern: '*@x.com',
      revokedAt: new Date(Date.now() - 60_000),
    });

    const results = await matchActiveInvitesByEmail('dev@x.com');
    expect(results).toHaveLength(1);
    expect(results[0].token).toBe(liveToken);
  });

  // -----------------------------------------------------------------------
  // Excludes expired invites (TC-I-18, activity filter — expired branch).
  // -----------------------------------------------------------------------
  it('excludes invites with expires_at in the past', async () => {
    const liveToken = make64HexToken('match-expire-live');
    const expiredToken = make64HexToken('match-expire-dead');
    await seedInvite({
      orgId: primary.orgId,
      teamId: primary.teamId,
      token: liveToken,
      emailPattern: '*@x.com',
    });
    await seedInvite({
      orgId: primary.orgId,
      teamId: primary.teamId,
      token: expiredToken,
      emailPattern: '*@x.com',
      expiresInMs: -60_000,
    });

    const results = await matchActiveInvitesByEmail('dev@x.com');
    expect(results).toHaveLength(1);
    expect(results[0].token).toBe(liveToken);
  });

  // -----------------------------------------------------------------------
  // Excludes exhausted invites (TC-I-18, activity filter — exhausted branch).
  // -----------------------------------------------------------------------
  it('excludes invites with used_count >= max_uses', async () => {
    const liveToken = make64HexToken('match-exhaust-live');
    const exhaustedToken = make64HexToken('match-exhaust-dead');
    await seedInvite({
      orgId: primary.orgId,
      teamId: primary.teamId,
      token: liveToken,
      emailPattern: '*@x.com',
      maxUses: 2,
      usedCount: 0,
    });
    await seedInvite({
      orgId: primary.orgId,
      teamId: primary.teamId,
      token: exhaustedToken,
      emailPattern: '*@x.com',
      maxUses: 1,
      usedCount: 1,
    });

    const results = await matchActiveInvitesByEmail('dev@x.com');
    expect(results).toHaveLength(1);
    expect(results[0].token).toBe(liveToken);
  });

  // -----------------------------------------------------------------------
  // Multi-org: helper returns ALL matching active invites — the caller is
  // responsible for the "exactly one" business decision (REQ-7) (TC-I-19).
  // -----------------------------------------------------------------------
  it('returns multiple matching invites across different orgs', async () => {
    const secondary = await seedOrg('MatchActive-Secondary');
    const tokenA = make64HexToken('match-multi-a');
    const tokenB = make64HexToken('match-multi-b');
    await seedInvite({
      orgId: primary.orgId,
      teamId: primary.teamId,
      token: tokenA,
      emailPattern: '*@x.com',
    });
    await seedInvite({
      orgId: secondary.orgId,
      teamId: secondary.teamId,
      token: tokenB,
      emailPattern: '*@x.com',
    });

    const results = await matchActiveInvitesByEmail('dev@x.com');
    expect(results).toHaveLength(2);
    const orgIds = results.map((r) => r.orgId).sort();
    expect(orgIds).toEqual([primary.orgId, secondary.orgId].sort());
  });

  // -----------------------------------------------------------------------
  // No-match returns empty (defensive).
  // -----------------------------------------------------------------------
  it('returns empty array when no patterns match', async () => {
    const token = make64HexToken('match-empty');
    await seedInvite({
      orgId: primary.orgId,
      teamId: primary.teamId,
      token,
      emailPattern: '*@other.com',
    });

    const results = await matchActiveInvitesByEmail('dev@x.com');
    expect(results).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // IDN domain support — `matchEmailPattern` canonicalizes both sides via
  // `domainToASCII` (punycode), so an IDN pattern matches an IDN email.
  // -----------------------------------------------------------------------
  it('IDN domain: matches dev@münchen.de against *@münchen.de', async () => {
    const token = make64HexToken('match-idn');
    await seedInvite({
      orgId: primary.orgId,
      teamId: primary.teamId,
      token,
      emailPattern: '*@münchen.de',
    });

    const results = await matchActiveInvitesByEmail('dev@münchen.de');
    expect(results).toHaveLength(1);
    expect(results[0].token).toBe(token);
  });

  // -----------------------------------------------------------------------
  // Whitespace-trimmed email — the helper calls `.trim()` before matching
  // so callers do not have to pre-normalize.
  // -----------------------------------------------------------------------
  it('whitespace-trimmed email: "  dev@x.com  " matches *@x.com', async () => {
    const token = make64HexToken('match-trim');
    await seedInvite({
      orgId: primary.orgId,
      teamId: primary.teamId,
      token,
      emailPattern: '*@x.com',
    });

    const results = await matchActiveInvitesByEmail('  dev@x.com  ');
    expect(results).toHaveLength(1);
    expect(results[0].token).toBe(token);
  });
});
