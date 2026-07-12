/**
 * Integration tests for `redeemInvite()` — happy path (TASK-6a) +
 * token-rejection branches (TASK-6b). Both suites live in this single file
 * so the shared seed helpers / cleanup hooks aren't duplicated.
 *
 * Happy path (TASK-6a, REQ-28):
 *   - TC-I-02: redeem with createInviteRow's plaintext → 200 (hash round-trip; security-hardening-lowsev)
 *   - TC-I-03: redeem with the stored token_hash value → 401 (a DB dump is not a credential)
 *   - TC-I-51: valid token + matching email → 200, user_machines row, bcrypt hash
 *   - TC-I-52: re-redeem same token (max_uses=2) by different machine → 2 rows
 *   - TC-I-52b: same machine_id with 2 distinct invites → 2 user_machines rows
 *   - TC-I-52c: existing user (team_id=null) + invite team_id=X → user.team_id = X
 *   - TC-I-52d: existing user (team_id=A) + invite team_id=B → user.team_id stays A
 *   - TC-I-53: new user inserted with sso_provider=NULL + team_id from invite
 *   - TC-I-55: bcrypt hash stored, NOT plaintext
 *   - TC-I-56: case-insensitive email match (`Alice@X.COM` reuses `alice@x.com`)
 *   - TC-I-57: redemption_log stores email_domain + email_hash, never claimed_email
 *   - TC-I-59: redemption_log token_prefix length === 8
 *
 * Token-rejection branches (TASK-6b, REQ-27 steps 3–7):
 *   - TC-I-44: non-existent token → 401, outcome='token-invalid', log row written
 *   - TC-I-45: revoked token → 401, outcome='token-revoked'
 *   - TC-I-46: expired token (expires_at in past) → 401, outcome='token-expired'
 *   - TC-I-47: exhausted (used_count = max_uses) → 401, outcome='token-exhausted'
 *   - TC-I-48: email_pattern mismatch → 401, outcome='email-mismatch'
 *   - TC-I-49: each Result.error.kind matches its specific outcome (sanity)
 *   - TC-I-50: redemption_log row's email_domain + email_hash populated on rejections
 *   - TC-I-58: email_hash reproducible across two calls with same email + invalid token
 *
 * Out-of-scope here (deferred):
 *   - TASK-6c: rate limiting + concurrency + bcrypt-throw rollback (TC-I-65)
 *
 * Convention: Postgres-backed via Testcontainers, shared instance from
 * `setup-pg.ts`. Each test cleans up writes in `afterEach` so cases stay
 * order-independent.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import bcrypt from 'bcrypt';
import { eq, sql } from 'drizzle-orm';
import { closeDb, getDb } from '@/lib/db/client';
import {
  onboardingInvites,
  onboardingRedemptionLog,
  orgs,
  teams,
  userMachines,
  users,
} from '@/lib/db/schema';
import { emailDomain, hashEmail } from '@/lib/auth/email-hash';
import { hashInviteToken } from '@/lib/auth/tokens';
import { createInviteRow } from './invites';
import { redeemInvite } from './redeem';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

const MACHINE_A = '11111111-1111-4111-8111-111111111111';
const MACHINE_B = '22222222-2222-4222-8222-222222222222';

const make64HexToken = (label: string): string => {
  // Deterministic per-test 64-hex tokens. Pad the label, then xor a constant.
  // Implementation detail: the only invariant `redeemInvite` cares about is
  // length + hex; collision avoidance is the test's responsibility.
  const seed = label.padEnd(32, 'x');
  return Buffer.from(seed).toString('hex').padEnd(64, '0').slice(0, 64);
};

type SeedOrgs = { orgId: string; teamAId: string; teamBId: string };

const seedOrgs = async (): Promise<SeedOrgs> => {
  const db = getDb();
  const [org] = await db
    .insert(orgs)
    .values({ name: 'RedeemHappyOrg' })
    .returning({ id: orgs.id });
  const [teamA] = await db
    .insert(teams)
    .values({ orgId: org.id, name: 'Alpha' })
    .returning({ id: teams.id });
  const [teamB] = await db
    .insert(teams)
    .values({ orgId: org.id, name: 'Beta' })
    .returning({ id: teams.id });
  return { orgId: org.id, teamAId: teamA.id, teamBId: teamB.id };
};

type SeedInviteOpts = {
  orgId: string;
  teamId?: string | null;
  token: string;
  maxUses?: number;
  emailPattern?: string | null;
  expiresInMs?: number;
};

const seedInvite = async (opts: SeedInviteOpts): Promise<void> => {
  const db = getDb();
  await db.insert(onboardingInvites).values({
    tokenHash: hashInviteToken(opts.token),
    tokenPrefix: opts.token.slice(0, 8),
    orgId: opts.orgId,
    teamId: opts.teamId ?? null,
    emailPattern: opts.emailPattern ?? null,
    maxUses: opts.maxUses ?? 1,
    usedCount: 0,
    expiresAt: new Date(Date.now() + (opts.expiresInMs ?? 8 * 60 * 60 * 1000)),
  });
};

skipDescribe('redeemInvite (happy path — TASK-6a)', () => {
  let seeded: SeedOrgs;

  beforeAll(async () => {
    const db = getDb();
    // Wipe the world before this suite — sibling suites also TRUNCATE so
    // ordering is independent. List mirrors `cleanup.test.ts` plus future
    // onboarding-redeem suites.
    await db.execute(sql`TRUNCATE TABLE
      onboarding_redemption_log, onboarding_audit_log, onboarding_invites,
      ingestion_log, model_breakdown_agg, tool_count_agg, sessions_agg,
      cost_calibration_per_user, user_machines, users, teams, orgs
      RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    await closeDb();
  });

  beforeEach(async () => {
    seeded = await seedOrgs();
  });

  afterEach(async () => {
    const db = getDb();
    // Order matters: child rows before parents (FK).
    await db.delete(onboardingRedemptionLog);
    await db.delete(userMachines);
    await db.delete(onboardingInvites);
    await db.delete(users);
    await db.delete(teams);
    await db.delete(orgs);
  });

  // -----------------------------------------------------------------------
  // TC-I-51: happy path — new user, valid token, matching email → 200
  // -----------------------------------------------------------------------
  it('TC-I-51: valid token + matching email → ok with key_id, secret, central_url, user_email', async () => {
    const db = getDb();
    const token = make64HexToken('tc51-happy-path-new-user');
    await seedInvite({ orgId: seeded.orgId, teamId: seeded.teamAId, token });

    const result = await redeemInvite(db, {
      token,
      machineId: MACHINE_A,
      hostname: 'laptop-tc51',
      claimedEmail: 'alice@example.com',
      requestIp: '203.0.113.0/24',
    });

    if (!result.ok) {
      throw new Error(`expected ok, got ${result.error.kind}`);
    }
    expect(result.value.keyId).toMatch(/^k_[0-9a-f]{16}$/);
    // 32-byte hex secret
    expect(result.value.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(result.value.userEmail).toBe('alice@example.com');
    expect(typeof result.value.centralUrl).toBe('string');

    const machines = await db
      .select({
        keyId: userMachines.keyId,
        secretHash: userMachines.secretHash,
        machineId: userMachines.machineId,
      })
      .from(userMachines);
    expect(machines).toHaveLength(1);
    expect(machines[0].keyId).toBe(result.value.keyId);
    // bcrypt prefix
    expect(machines[0].secretHash).toMatch(/^\$2[ab]\$10\$/);
    // bcrypt verifies the plaintext we returned
    expect(await bcrypt.compare(result.value.secret, machines[0].secretHash)).toBe(true);
    expect(machines[0].machineId).toBe(MACHINE_A);
  });

  // -----------------------------------------------------------------------
  // TC-I-02 / TC-I-03: hash-at-rest round-trip (security-hardening-lowsev REQ-2)
  // -----------------------------------------------------------------------
  it('TC-I-02: redeem with the plaintext returned by createInviteRow → 200 (hash round-trip)', async () => {
    const db = getDb();
    // Use the PRODUCTION create path (which hashes at rest) instead of the
    // local seedInvite helper, so this proves create + redeem agree on the
    // hash of the same plaintext.
    const created = await createInviteRow(db, {
      orgId: seeded.orgId,
      teamId: seeded.teamAId,
      emailPattern: null,
      maxUses: 1,
      expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
      createdBy: null,
    });

    const result = await redeemInvite(db, {
      token: created.token, // the plaintext, surfaced exactly once by create
      machineId: MACHINE_A,
      hostname: 'laptop-tc02',
      claimedEmail: 'alice@example.com',
      requestIp: null,
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.error.kind}`);
    expect(result.value.keyId).toMatch(/^k_[0-9a-f]{16}$/);

    // The at-rest column holds the hash, never the plaintext we just redeemed.
    const [row] = await db
      .select({ tokenHash: onboardingInvites.tokenHash })
      .from(onboardingInvites)
      .where(eq(onboardingInvites.tokenHash, hashInviteToken(created.token)));
    expect(row.tokenHash).toBe(hashInviteToken(created.token));
    expect(row.tokenHash).not.toBe(created.token);
  });

  it('TC-I-03: redeem with the stored hash (DB column value) as the token → 401 (a DB dump is not a credential)', async () => {
    const db = getDb();
    const created = await createInviteRow(db, {
      orgId: seeded.orgId,
      teamId: seeded.teamAId,
      emailPattern: null,
      maxUses: 1,
      expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
      createdBy: null,
    });

    // What a read-only DB dump exposes: the at-rest token_hash. Replaying it
    // as the redeem token hashes it AGAIN (sha256 of the hash), which cannot
    // match the stored value — so it is rejected as token-invalid.
    const storedHash = hashInviteToken(created.token);
    const result = await redeemInvite(db, {
      token: storedHash,
      machineId: MACHINE_A,
      hostname: 'laptop-tc03',
      claimedEmail: 'alice@example.com',
      requestIp: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('token-invalid');

    // No machine provisioned from a hash replay.
    const machines = await db.select({ keyId: userMachines.keyId }).from(userMachines);
    expect(machines).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // TC-I-52: re-redeem same token (max_uses=2) by different machines → 2 rows
  // -----------------------------------------------------------------------
  it('TC-I-52: same token max_uses=2, two different machines → 2 user_machines rows, used_count=2', async () => {
    const db = getDb();
    const token = make64HexToken('tc52-multi-use-same-token');
    await seedInvite({
      orgId: seeded.orgId,
      teamId: seeded.teamAId,
      token,
      maxUses: 2,
    });

    const r1 = await redeemInvite(db, {
      token,
      machineId: MACHINE_A,
      hostname: 'host-a',
      claimedEmail: 'eve@example.com',
      requestIp: null,
    });
    const r2 = await redeemInvite(db, {
      token,
      machineId: MACHINE_B,
      hostname: 'host-b',
      claimedEmail: 'eve@example.com',
      requestIp: null,
    });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    const machines = await db.select({ keyId: userMachines.keyId }).from(userMachines);
    expect(machines).toHaveLength(2);

    const [invite] = await db
      .select({ usedCount: onboardingInvites.usedCount })
      .from(onboardingInvites)
      .where(eq(onboardingInvites.tokenHash, hashInviteToken(token)));
    expect(invite.usedCount).toBe(2);
  });

  // -----------------------------------------------------------------------
  // TC-I-52b: same machine_id, two distinct invites → 2 user_machines rows
  // -----------------------------------------------------------------------
  it('TC-I-52b: same machine_id, two distinct invites → 2 user_machines rows (no UNIQUE on machine_id)', async () => {
    const db = getDb();
    const tokenA = make64HexToken('tc52b-token-a');
    const tokenB = make64HexToken('tc52b-token-b');
    await seedInvite({ orgId: seeded.orgId, teamId: seeded.teamAId, token: tokenA });
    await seedInvite({ orgId: seeded.orgId, teamId: seeded.teamAId, token: tokenB });

    const r1 = await redeemInvite(db, {
      token: tokenA,
      machineId: MACHINE_A,
      hostname: 'reused-machine',
      claimedEmail: 'alice@example.com',
      requestIp: null,
    });
    const r2 = await redeemInvite(db, {
      token: tokenB,
      machineId: MACHINE_A, // same machine
      hostname: 'reused-machine',
      claimedEmail: 'alice@example.com',
      requestIp: null,
    });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    const rows = await db
      .select({ keyId: userMachines.keyId, machineId: userMachines.machineId })
      .from(userMachines);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.machineId === MACHINE_A)).toBe(true);
    // key_ids are distinct (UNIQUE constraint enforces this).
    expect(new Set(rows.map((r) => r.keyId)).size).toBe(2);
  });

  // -----------------------------------------------------------------------
  // TC-I-52c: existing user with team_id=NULL + invite has team_id=X → fill
  // -----------------------------------------------------------------------
  it('TC-I-52c: existing user team_id=NULL redeems invite with team_id=X → user.team_id ← X', async () => {
    const db = getDb();
    // Pre-create a user with team_id=NULL (e.g. SSO-bootstrapped user that
    // never got assigned to a team).
    const [pre] = await db
      .insert(users)
      .values({
        orgId: seeded.orgId,
        teamId: null,
        email: 'unassigned@example.com',
        ssoProvider: null,
        ssoSubject: null,
        role: 'member',
      })
      .returning({ id: users.id });

    const token = make64HexToken('tc52c-fill-team-id');
    await seedInvite({ orgId: seeded.orgId, teamId: seeded.teamBId, token });

    const r = await redeemInvite(db, {
      token,
      machineId: MACHINE_A,
      hostname: 'h',
      claimedEmail: 'unassigned@example.com',
      requestIp: null,
    });
    expect(r.ok).toBe(true);

    const [u] = await db
      .select({ id: users.id, teamId: users.teamId })
      .from(users)
      .where(eq(users.id, pre.id));
    expect(u.teamId).toBe(seeded.teamBId);
  });

  // -----------------------------------------------------------------------
  // TC-I-52d / TC-I-54: existing user team_id=A + invite team_id=B → preserve A
  //
  // The spec lists TC-I-54 as the dedicated label for the "preserve
  // existing team assignment" invariant; TC-I-52d covers the same
  // behavior under the machine-re-onboarding theme. Single test asserts
  // both — the post-condition is identical (user.team_id stays = A
  // regardless of invite payload).
  // -----------------------------------------------------------------------
  it('TC-I-52d / TC-I-54: existing user team_id=A redeems invite with team_id=B → user.team_id stays A', async () => {
    const db = getDb();
    const [pre] = await db
      .insert(users)
      .values({
        orgId: seeded.orgId,
        teamId: seeded.teamAId,
        email: 'placed@example.com',
        ssoProvider: 'google',
        ssoSubject: 'sub-placed',
        role: 'member',
      })
      .returning({ id: users.id });

    const token = make64HexToken('tc52d-preserve-team-id');
    await seedInvite({ orgId: seeded.orgId, teamId: seeded.teamBId, token });

    const r = await redeemInvite(db, {
      token,
      machineId: MACHINE_A,
      hostname: 'h',
      claimedEmail: 'placed@example.com',
      requestIp: null,
    });
    expect(r.ok).toBe(true);

    const [u] = await db
      .select({ teamId: users.teamId })
      .from(users)
      .where(eq(users.id, pre.id));
    expect(u.teamId).toBe(seeded.teamAId); // unchanged
  });

  // -----------------------------------------------------------------------
  // TC-I-53: new user gets sso_provider=NULL + team_id from invite + role=member
  // -----------------------------------------------------------------------
  it('TC-I-53: new user inserted with sso_provider=NULL, team_id from invite, role=member', async () => {
    const db = getDb();
    const token = make64HexToken('tc53-new-user-shape');
    await seedInvite({ orgId: seeded.orgId, teamId: seeded.teamBId, token });

    const r = await redeemInvite(db, {
      token,
      machineId: MACHINE_A,
      hostname: 'h',
      claimedEmail: 'newcomer@example.com',
      requestIp: null,
    });
    expect(r.ok).toBe(true);

    const [u] = await db
      .select({
        teamId: users.teamId,
        ssoProvider: users.ssoProvider,
        ssoSubject: users.ssoSubject,
        role: users.role,
        orgId: users.orgId,
      })
      .from(users)
      .where(eq(users.email, 'newcomer@example.com'));
    expect(u.teamId).toBe(seeded.teamBId);
    expect(u.ssoProvider).toBeNull();
    expect(u.ssoSubject).toBeNull();
    expect(u.role).toBe('member');
    expect(u.orgId).toBe(seeded.orgId);
  });

  // -----------------------------------------------------------------------
  // TC-I-55: bcrypt hash stored, NOT plaintext secret
  // -----------------------------------------------------------------------
  it('TC-I-55: secret_hash starts with bcrypt prefix and does NOT equal plaintext', async () => {
    const db = getDb();
    const token = make64HexToken('tc55-bcrypt-at-rest');
    await seedInvite({ orgId: seeded.orgId, teamId: seeded.teamAId, token });

    const r = await redeemInvite(db, {
      token,
      machineId: MACHINE_A,
      hostname: 'h',
      claimedEmail: 'alice@example.com',
      requestIp: null,
    });
    if (!r.ok) throw new Error('expected ok');
    const plaintext = r.value.secret;

    const [m] = await db
      .select({ secretHash: userMachines.secretHash })
      .from(userMachines)
      .where(eq(userMachines.keyId, r.value.keyId));
    expect(m.secretHash).toMatch(/^\$2[ab]\$10\$/);
    expect(m.secretHash).not.toBe(plaintext);
    expect(m.secretHash).not.toContain(plaintext);
  });

  // -----------------------------------------------------------------------
  // TC-I-56: case-insensitive email match
  // -----------------------------------------------------------------------
  it('TC-I-56: redeem with Alice@X.COM reuses existing alice@x.com user', async () => {
    const db = getDb();
    const [pre] = await db
      .insert(users)
      .values({
        orgId: seeded.orgId,
        teamId: seeded.teamAId,
        email: 'alice@x.com', // canonical lowercase
        ssoProvider: 'google',
        ssoSubject: 'sub-alice',
        role: 'member',
      })
      .returning({ id: users.id });

    const token = make64HexToken('tc56-case-insensitive');
    await seedInvite({ orgId: seeded.orgId, teamId: seeded.teamAId, token });

    const r = await redeemInvite(db, {
      token,
      machineId: MACHINE_A,
      hostname: 'h',
      claimedEmail: 'Alice@X.COM', // mixed case input
      requestIp: null,
    });
    expect(r.ok).toBe(true);

    const allUsers = await db.select({ id: users.id, email: users.email }).from(users);
    expect(allUsers).toHaveLength(1);
    expect(allUsers[0].id).toBe(pre.id);
    expect(allUsers[0].email).toBe('alice@x.com');
  });

  // -----------------------------------------------------------------------
  // TC-I-57: redemption_log stores email_domain + email_hash, never claimed_email
  // -----------------------------------------------------------------------
  it('TC-I-57: redemption_log row contains email_domain and email_hash, never the raw email', async () => {
    const db = getDb();
    const token = make64HexToken('tc57-no-pii-in-log');
    await seedInvite({ orgId: seeded.orgId, teamId: seeded.teamAId, token });

    const claimedEmail = 'sensitive.user@private-domain.com';
    const r = await redeemInvite(db, {
      token,
      machineId: MACHINE_A,
      hostname: 'h',
      claimedEmail,
      requestIp: null,
    });
    expect(r.ok).toBe(true);

    const rows = await db.select().from(onboardingRedemptionLog);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.outcome).toBe('accepted');
    expect(row.emailDomain).toBe('private-domain.com');
    expect(row.emailHash).toBe(hashEmail(claimedEmail));

    // Defense-in-depth: dump every column value to a string and assert no
    // substring of the raw email exists anywhere in the log row.
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(claimedEmail);
    expect(serialized).not.toContain('sensitive.user');
  });

  // -----------------------------------------------------------------------
  // TC-I-59: redemption_log token_prefix length === 8
  // -----------------------------------------------------------------------
  it('TC-I-59: redemption_log token_prefix has length 8 and matches first 8 chars of token', async () => {
    const db = getDb();
    const token = make64HexToken('tc59-prefix-length');
    await seedInvite({ orgId: seeded.orgId, teamId: seeded.teamAId, token });

    const r = await redeemInvite(db, {
      token,
      machineId: MACHINE_A,
      hostname: 'h',
      claimedEmail: 'alice@example.com',
      requestIp: null,
    });
    expect(r.ok).toBe(true);

    const [row] = await db.select().from(onboardingRedemptionLog);
    expect(row.tokenPrefix).toHaveLength(8);
    expect(row.tokenPrefix).toBe(token.slice(0, 8));
  });
});

// ---------------------------------------------------------------------------
// TASK-6b — token-rejection branches (REQ-27 steps 3–7).
// ---------------------------------------------------------------------------
//
// Every rejection MUST:
//   1. Return `{ok:false, error:{kind: <matching kind>}}` so the route layer
//      can stamp the uniform 401 body (REQ-27 last paragraph).
//   2. Write exactly one row to `onboarding_redemption_log` with the
//      corresponding `outcome`, `machine_id=NULL`, populated `email_domain`
//      + `email_hash`, and the `request_ip` passed through unchanged.
//   3. Leave NO rows in `users` or `user_machines` (no side effects on
//      partial failure — the unaccepted call must not provision anything).
//
// The shared `expectRejection` helper consolidates these assertions so the
// individual cases stay focused on the input setup that triggers their
// specific branch.
// ---------------------------------------------------------------------------

skipDescribe('redeemInvite (rejection branches — TASK-6b)', () => {
  let seeded: SeedOrgs;

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

  beforeEach(async () => {
    seeded = await seedOrgs();
  });

  afterEach(async () => {
    const db = getDb();
    await db.delete(onboardingRedemptionLog);
    await db.delete(userMachines);
    await db.delete(onboardingInvites);
    await db.delete(users);
    await db.delete(teams);
    await db.delete(orgs);
  });

  // -------------------------------------------------------------------------
  // Shared assertion helper for the 5 rejection branches.
  // -------------------------------------------------------------------------
  type RejectionOutcome =
    | 'token-invalid'
    | 'token-revoked'
    | 'token-expired'
    | 'token-exhausted'
    | 'email-mismatch';

  const expectRejection = async (
    result: Awaited<ReturnType<typeof redeemInvite>>,
    expectedKind: RejectionOutcome,
    args: { tokenPrefix: string; claimedEmail: string; requestIp: string | null },
  ): Promise<void> => {
    const db = getDb();
    expect(result.ok).toBe(false);
    if (result.ok) return; // type narrowing
    expect(result.error.kind).toBe(expectedKind);

    // Side-effect invariants: no user, no machine.
    const u = await db.select({ id: users.id }).from(users);
    const m = await db.select({ keyId: userMachines.keyId }).from(userMachines);
    expect(u).toHaveLength(0);
    expect(m).toHaveLength(0);

    // Audit row: exactly one, with the matching outcome and the privacy
    // columns populated (TC-I-50).
    const logs = await db.select().from(onboardingRedemptionLog);
    expect(logs).toHaveLength(1);
    const row = logs[0];
    expect(row.outcome).toBe(expectedKind);
    expect(row.machineId).toBeNull();
    expect(row.tokenPrefix).toBe(args.tokenPrefix);
    expect(row.tokenPrefix).toHaveLength(8);
    expect(row.emailDomain).toBe(emailDomain(args.claimedEmail));
    expect(row.emailHash).toBe(hashEmail(args.claimedEmail));
    expect(row.requestIp).toBe(args.requestIp);
  };

  // -------------------------------------------------------------------------
  // TC-I-44: non-existent token → outcome='token-invalid'
  // -------------------------------------------------------------------------
  it("TC-I-44: non-existent token → 401-shape result with outcome='token-invalid' logged", async () => {
    const db = getDb();
    // No invite seeded — the token simply does not exist.
    const token = make64HexToken('tc44-no-such-token');
    const claimedEmail = 'nobody@nowhere.invalid';
    const requestIp = '203.0.113.0/24';

    const result = await redeemInvite(db, {
      token,
      machineId: MACHINE_A,
      hostname: 'h-tc44',
      claimedEmail,
      requestIp,
    });
    await expectRejection(result, 'token-invalid', {
      tokenPrefix: token.slice(0, 8),
      claimedEmail,
      requestIp,
    });
  });

  // -------------------------------------------------------------------------
  // TC-I-45: revoked token (revoked_at IS NOT NULL) → 'token-revoked'
  // -------------------------------------------------------------------------
  it("TC-I-45: revoked token → outcome='token-revoked' logged", async () => {
    const db = getDb();
    const token = make64HexToken('tc45-revoked');
    await seedInvite({ orgId: seeded.orgId, teamId: seeded.teamAId, token });
    // Revoke it after seeding — mirrors the real-world flow where the
    // manager revokes via the admin UI.
    await db
      .update(onboardingInvites)
      .set({ revokedAt: new Date(Date.now() - 60_000) })
      .where(eq(onboardingInvites.tokenHash, hashInviteToken(token)));

    const claimedEmail = 'alice@example.com';
    const result = await redeemInvite(db, {
      token,
      machineId: MACHINE_A,
      hostname: 'h-tc45',
      claimedEmail,
      requestIp: null,
    });
    await expectRejection(result, 'token-revoked', {
      tokenPrefix: token.slice(0, 8),
      claimedEmail,
      requestIp: null,
    });
  });

  // -------------------------------------------------------------------------
  // TC-I-46: expired token (expires_at in past) → 'token-expired'
  // -------------------------------------------------------------------------
  it("TC-I-46: expired token → outcome='token-expired' logged", async () => {
    const db = getDb();
    const token = make64HexToken('tc46-expired');
    // Negative `expiresInMs` puts expires_at in the past.
    await seedInvite({
      orgId: seeded.orgId,
      teamId: seeded.teamAId,
      token,
      expiresInMs: -60_000,
    });

    const claimedEmail = 'alice@example.com';
    const result = await redeemInvite(db, {
      token,
      machineId: MACHINE_A,
      hostname: 'h-tc46',
      claimedEmail,
      requestIp: null,
    });
    await expectRejection(result, 'token-expired', {
      tokenPrefix: token.slice(0, 8),
      claimedEmail,
      requestIp: null,
    });
  });

  // -------------------------------------------------------------------------
  // TC-I-47: exhausted token (used_count >= max_uses) → 'token-exhausted'
  // -------------------------------------------------------------------------
  it("TC-I-47: exhausted token (used_count = max_uses) → outcome='token-exhausted' logged", async () => {
    const db = getDb();
    const token = make64HexToken('tc47-exhausted');
    await seedInvite({
      orgId: seeded.orgId,
      teamId: seeded.teamAId,
      token,
      maxUses: 1,
    });
    // Bring used_count up to max_uses without going through the redeem
    // flow — keeps this test focused on just the exhaustion branch.
    await db
      .update(onboardingInvites)
      .set({ usedCount: 1 })
      .where(eq(onboardingInvites.tokenHash, hashInviteToken(token)));

    const claimedEmail = 'alice@example.com';
    const result = await redeemInvite(db, {
      token,
      machineId: MACHINE_A,
      hostname: 'h-tc47',
      claimedEmail,
      requestIp: null,
    });
    await expectRejection(result, 'token-exhausted', {
      tokenPrefix: token.slice(0, 8),
      claimedEmail,
      requestIp: null,
    });
  });

  // -------------------------------------------------------------------------
  // TC-I-48: email pattern mismatch → 'email-mismatch'
  // -------------------------------------------------------------------------
  it("TC-I-48: email_pattern domain mismatch → outcome='email-mismatch' logged", async () => {
    const db = getDb();
    const token = make64HexToken('tc48-email-mismatch');
    await seedInvite({
      orgId: seeded.orgId,
      teamId: seeded.teamAId,
      token,
      emailPattern: '*@allowed.com', // only allowed.com
    });

    const claimedEmail = 'mallory@evil.com'; // does NOT match `*@allowed.com`
    const result = await redeemInvite(db, {
      token,
      machineId: MACHINE_A,
      hostname: 'h-tc48',
      claimedEmail,
      requestIp: null,
    });
    await expectRejection(result, 'email-mismatch', {
      tokenPrefix: token.slice(0, 8),
      claimedEmail,
      requestIp: null,
    });
  });

  // -------------------------------------------------------------------------
  // TC-I-49: error.kind values are distinct across the 5 rejection branches
  // (sanity — guarantees the caller's switch on `kind` doesn't silently
  // collapse two branches into one because of a typo).
  // -------------------------------------------------------------------------
  it('TC-I-49: each rejection branch returns a distinct error.kind matching its outcome', async () => {
    const db = getDb();

    // Token-invalid: no seed.
    const tInvalid = make64HexToken('tc49-invalid');

    // Token-revoked.
    const tRevoked = make64HexToken('tc49-revoked');
    await seedInvite({ orgId: seeded.orgId, teamId: seeded.teamAId, token: tRevoked });
    await db
      .update(onboardingInvites)
      .set({ revokedAt: new Date(Date.now() - 1_000) })
      .where(eq(onboardingInvites.tokenHash, hashInviteToken(tRevoked)));

    // Token-expired.
    const tExpired = make64HexToken('tc49-expired');
    await seedInvite({
      orgId: seeded.orgId,
      teamId: seeded.teamAId,
      token: tExpired,
      expiresInMs: -1_000,
    });

    // Token-exhausted.
    const tExhausted = make64HexToken('tc49-exhausted');
    await seedInvite({
      orgId: seeded.orgId,
      teamId: seeded.teamAId,
      token: tExhausted,
      maxUses: 1,
    });
    await db
      .update(onboardingInvites)
      .set({ usedCount: 1 })
      .where(eq(onboardingInvites.tokenHash, hashInviteToken(tExhausted)));

    // Email-mismatch.
    const tMismatch = make64HexToken('tc49-mismatch');
    await seedInvite({
      orgId: seeded.orgId,
      teamId: seeded.teamAId,
      token: tMismatch,
      emailPattern: '*@only.com',
    });

    const baseInput = {
      machineId: MACHINE_A,
      hostname: 'h-tc49',
      requestIp: null as string | null,
    };

    const [rInvalid, rRevoked, rExpired, rExhausted, rMismatch] = await Promise.all([
      redeemInvite(db, { ...baseInput, token: tInvalid, claimedEmail: 'a@b.com' }),
      redeemInvite(db, { ...baseInput, token: tRevoked, claimedEmail: 'a@b.com' }),
      redeemInvite(db, { ...baseInput, token: tExpired, claimedEmail: 'a@b.com' }),
      redeemInvite(db, { ...baseInput, token: tExhausted, claimedEmail: 'a@b.com' }),
      redeemInvite(db, { ...baseInput, token: tMismatch, claimedEmail: 'mallory@evil.com' }),
    ]);

    const kinds = [rInvalid, rRevoked, rExpired, rExhausted, rMismatch].map((r) => {
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('unreachable');
      return r.error.kind;
    });
    expect(kinds).toEqual([
      'token-invalid',
      'token-revoked',
      'token-expired',
      'token-exhausted',
      'email-mismatch',
    ]);
    // 5 distinct values — no two branches collide.
    expect(new Set(kinds).size).toBe(5);

    // And the persisted log shows the SAME 5 outcomes — the audit trail
    // and the in-memory Result agree.
    const logs = await db
      .select({ outcome: onboardingRedemptionLog.outcome })
      .from(onboardingRedemptionLog);
    expect(logs.map((l) => l.outcome).sort()).toEqual(
      [
        'email-mismatch',
        'token-exhausted',
        'token-expired',
        'token-invalid',
        'token-revoked',
      ].sort(),
    );
  });

  // -------------------------------------------------------------------------
  // TC-I-50: privacy invariant — email_domain + email_hash populated on
  // rejection (and never the raw email anywhere in the row).
  // -------------------------------------------------------------------------
  it("TC-I-50: redemption_log row's email_domain and email_hash are populated on rejections (no raw email anywhere)", async () => {
    const db = getDb();
    const token = make64HexToken('tc50-no-pii-on-reject');
    // No seed — exercise the `token-invalid` branch, which is the most
    // dangerous path for PII leakage (we never even saw a real invite row,
    // so it would be tempting to skip the privacy fields). The function
    // computes them up front specifically to avoid that mistake.
    const claimedEmail = 'sensitive.user@private-domain.com';
    const requestIp = '198.51.100.0/24';

    const result = await redeemInvite(db, {
      token,
      machineId: MACHINE_A,
      hostname: 'h-tc50',
      claimedEmail,
      requestIp,
    });
    expect(result.ok).toBe(false);

    const rows = await db.select().from(onboardingRedemptionLog);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.outcome).toBe('token-invalid');
    expect(row.emailDomain).toBe('private-domain.com');
    expect(row.emailHash).toBe(hashEmail(claimedEmail));
    expect(row.emailHash).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
    expect(row.machineId).toBeNull();
    expect(row.requestIp).toBe(requestIp);

    // Defense-in-depth: serialize the entire row and assert no fragment of
    // the raw email leaked into ANY column (including request_ip,
    // token_prefix, etc.).
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(claimedEmail);
    expect(serialized).not.toContain('sensitive.user');
    expect(serialized).not.toContain('private-domain.com'.replace('.', '_'));
  });

  // -------------------------------------------------------------------------
  // TC-I-58: email_hash is reproducible — same email + invalid token twice
  // → identical hash on both log rows.
  // -------------------------------------------------------------------------
  it('TC-I-58: same email + invalid token called twice → both log rows have identical email_hash', async () => {
    const db = getDb();
    const tokenA = make64HexToken('tc58-call-a');
    const tokenB = make64HexToken('tc58-call-b'); // distinct token, same email
    const claimedEmail = 'reproducible@example.com';

    const r1 = await redeemInvite(db, {
      token: tokenA,
      machineId: MACHINE_A,
      hostname: 'h-tc58-a',
      claimedEmail,
      requestIp: null,
    });
    const r2 = await redeemInvite(db, {
      token: tokenB,
      machineId: MACHINE_B,
      hostname: 'h-tc58-b',
      claimedEmail,
      requestIp: null,
    });
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);

    const rows = await db
      .select({
        emailHash: onboardingRedemptionLog.emailHash,
        outcome: onboardingRedemptionLog.outcome,
      })
      .from(onboardingRedemptionLog);
    expect(rows).toHaveLength(2);
    expect(rows[0].emailHash).toBe(rows[1].emailHash);
    expect(rows[0].emailHash).toBe(hashEmail(claimedEmail));
    // Both are the same outcome (token-invalid) — the test isn't sensitive
    // to ordering, but pinning the value here catches any future regression
    // that routes one call through a different rejection branch.
    expect(rows.every((r) => r.outcome === 'token-invalid')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TASK-6c — concurrency (REQ-29) + atomicity (rollback on DB / bcrypt failure).
// ---------------------------------------------------------------------------
//
// Two distinct invariants under test:
//   1. **Concurrency** (TC-I-62, TC-I-63). N parallel redeems of an invite with
//      `max_uses=K` → exactly K acceptances and (N-K) `token-exhausted`
//      rejections. Postgres' SELECT ... FOR UPDATE on the invite row plus the
//      transactional used_count bump are what serialize the contenders.
//   2. **Rollback on transaction failure** (TC-I-64, TC-I-65). When a write
//      inside the redeem transaction throws — whether the failure looks like
//      a DB connection blip or a bcrypt internal error — the entire
//      transaction MUST roll back: zero user rows, zero user_machines rows,
//      used_count untouched. The function returns
//      `{ok:false, error:{kind:'infra', cause}}` so the route layer can
//      surface a 500.
//
// Injection seam: `redeemInvite()` accepts an optional `hashFn` (REQ-28
// final paragraph). Throwing from this stub fires INSIDE the transaction
// (after user upsert, before user_machines INSERT) — exactly the "mid-
// transaction" failure mode both TCs describe.
// ---------------------------------------------------------------------------

skipDescribe('redeemInvite (concurrency + atomicity — TASK-6c)', () => {
  let seeded: SeedOrgs;

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

  beforeEach(async () => {
    seeded = await seedOrgs();
  });

  afterEach(async () => {
    const db = getDb();
    await db.delete(onboardingRedemptionLog);
    await db.delete(userMachines);
    await db.delete(onboardingInvites);
    await db.delete(users);
    await db.delete(teams);
    await db.delete(orgs);
  });

  // -------------------------------------------------------------------------
  // TC-I-62: 5 parallel redeems on max_uses=1 → exactly 1 acceptance.
  // -------------------------------------------------------------------------
  it('TC-I-62: 5 parallel redeems on max_uses=1 → exactly 1 accepted, 4 token-exhausted (used_count=1)', async () => {
    const db = getDb();
    const token = make64HexToken('tc62-max-uses-1-x5');
    await seedInvite({
      orgId: seeded.orgId,
      teamId: seeded.teamAId,
      token,
      maxUses: 1,
    });

    // Each call uses a distinct machine_id so the only contention is the
    // invite row itself. Parallelism is `Promise.all` — Drizzle's pool
    // handles connection-per-transaction so the 5 transactions truly run
    // concurrently. The SELECT ... FOR UPDATE inside the transaction is
    // what serializes them.
    const machineIds = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
      '55555555-5555-4555-8555-555555555555',
    ];
    const results = await Promise.all(
      machineIds.map((machineId, i) =>
        redeemInvite(db, {
          token,
          machineId,
          hostname: `host-tc62-${i}`,
          claimedEmail: 'race@example.com',
          requestIp: null,
        }),
      ),
    );

    const accepted = results.filter((r) => r.ok);
    const exhausted = results.filter(
      (r) => !r.ok && r.error.kind === 'token-exhausted',
    );
    expect(accepted).toHaveLength(1);
    expect(exhausted).toHaveLength(4);

    // DB-side invariants confirm the transaction-serialized truth.
    const [invite] = await db
      .select({ usedCount: onboardingInvites.usedCount })
      .from(onboardingInvites)
      .where(eq(onboardingInvites.tokenHash, hashInviteToken(token)));
    expect(invite.usedCount).toBe(1);

    const machines = await db.select({ keyId: userMachines.keyId }).from(userMachines);
    expect(machines).toHaveLength(1);

    // Audit trail: 1 accepted + 4 token-exhausted log rows.
    const logs = await db
      .select({ outcome: onboardingRedemptionLog.outcome })
      .from(onboardingRedemptionLog);
    const counts = logs.reduce<Record<string, number>>((acc, l) => {
      acc[l.outcome] = (acc[l.outcome] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts['accepted']).toBe(1);
    expect(counts['token-exhausted']).toBe(4);
  });

  // -------------------------------------------------------------------------
  // TC-I-63: 6 parallel redeems on max_uses=3 → exactly 3 accepted.
  // -------------------------------------------------------------------------
  it('TC-I-63: 6 parallel redeems on max_uses=3 → exactly 3 accepted, 3 token-exhausted', async () => {
    const db = getDb();
    const token = make64HexToken('tc63-max-uses-3-x6');
    await seedInvite({
      orgId: seeded.orgId,
      teamId: seeded.teamAId,
      token,
      maxUses: 3,
    });

    const machineIds = [
      '11111111-1111-4111-8111-aaaaaaaaaaaa',
      '22222222-2222-4222-8222-bbbbbbbbbbbb',
      '33333333-3333-4333-8333-cccccccccccc',
      '44444444-4444-4444-8444-dddddddddddd',
      '55555555-5555-4555-8555-eeeeeeeeeeee',
      '66666666-6666-4666-8666-ffffffffffff',
    ];
    const results = await Promise.all(
      machineIds.map((machineId, i) =>
        redeemInvite(db, {
          token,
          machineId,
          hostname: `host-tc63-${i}`,
          claimedEmail: 'race3@example.com',
          requestIp: null,
        }),
      ),
    );

    const accepted = results.filter((r) => r.ok);
    const exhausted = results.filter(
      (r) => !r.ok && r.error.kind === 'token-exhausted',
    );
    expect(accepted).toHaveLength(3);
    expect(exhausted).toHaveLength(3);

    const [invite] = await db
      .select({ usedCount: onboardingInvites.usedCount })
      .from(onboardingInvites)
      .where(eq(onboardingInvites.tokenHash, hashInviteToken(token)));
    expect(invite.usedCount).toBe(3);

    const machines = await db.select({ keyId: userMachines.keyId }).from(userMachines);
    expect(machines).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // TC-I-64: simulated DB-style mid-transaction failure → infra + rollback.
  // -------------------------------------------------------------------------
  // The cleanest in-process simulation of "DB blip mid-transaction" is to
  // throw from the `hashFn` injection seam — that callback runs inside
  // `db.transaction(...)` AFTER the user upsert but BEFORE the user_machines
  // INSERT. We attach a Postgres-shaped `code` to the error so the test
  // proves the function treats arbitrary thrown errors (not just
  // bcrypt-specific ones) as `infra` failures.
  it('TC-I-64: db-shaped error mid-transaction → infra error + complete rollback (no partial writes)', async () => {
    const db = getDb();
    const token = make64HexToken('tc64-db-failure-rollback');
    await seedInvite({
      orgId: seeded.orgId,
      teamId: seeded.teamAId,
      token,
      maxUses: 5, // generous so used_count rollback is observable, not disguised by exhaustion
    });

    const dbError = Object.assign(
      new Error('connection terminated unexpectedly'),
      { code: '08006' /* connection_failure */ },
    );
    const throwingHashFn = async (): Promise<string> => {
      throw dbError;
    };

    const result = await redeemInvite(
      db,
      {
        token,
        machineId: '11111111-1111-4111-8111-cccccccccccc',
        hostname: 'host-tc64',
        claimedEmail: 'tc64@example.com',
        requestIp: null,
      },
      { hashFn: throwingHashFn },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('infra');
    if (result.error.kind === 'infra') {
      // The original cause is preserved so the route layer can log it
      // server-side without exposing details to the client.
      expect(result.error.cause).toBe(dbError);
    }

    // Rollback invariants: NO user_machines row, NO accepted log row,
    // used_count untouched. The user upsert IS allowed to commit (it's
    // inside the same transaction so it ALSO rolls back) — assert it does.
    const machines = await db.select({ keyId: userMachines.keyId }).from(userMachines);
    expect(machines).toHaveLength(0);

    const usersRows = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.email, 'tc64@example.com'));
    expect(usersRows).toHaveLength(0);

    const [invite] = await db
      .select({ usedCount: onboardingInvites.usedCount })
      .from(onboardingInvites)
      .where(eq(onboardingInvites.tokenHash, hashInviteToken(token)));
    expect(invite.usedCount).toBe(0);

    // No `accepted` log row. The infra error path may or may not write a
    // rejection log row depending on the implementation's policy — the
    // current redeem.ts does NOT log infra failures (the catch path falls
    // through to the `if (infraCause)` branch without writing). Either way,
    // there must NOT be an `accepted` row.
    const acceptedLogs = await db
      .select({ id: onboardingRedemptionLog.id })
      .from(onboardingRedemptionLog)
      .where(eq(onboardingRedemptionLog.outcome, 'accepted'));
    expect(acceptedLogs).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // TC-I-65: bcrypt-shaped throw → infra error + rollback.
  // -------------------------------------------------------------------------
  it('TC-I-65: bcrypt throws via hashFn → infra error + rollback (no partial user_machines row)', async () => {
    const db = getDb();
    const token = make64HexToken('tc65-bcrypt-throws');
    await seedInvite({
      orgId: seeded.orgId,
      teamId: seeded.teamAId,
      token,
      maxUses: 1,
    });

    // Hand-written stub (no mocking framework) — matches `BcryptHashFn`.
    const bcryptError = new Error('bcrypt: data and salt arguments required');
    const throwingHashFn = async (): Promise<string> => {
      throw bcryptError;
    };

    const result = await redeemInvite(
      db,
      {
        token,
        machineId: '22222222-2222-4222-8222-cccccccccccc',
        hostname: 'host-tc65',
        claimedEmail: 'tc65@example.com',
        requestIp: null,
      },
      { hashFn: throwingHashFn },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('infra');
    if (result.error.kind === 'infra') {
      expect(result.error.cause).toBe(bcryptError);
    }

    // Rollback invariants — same as TC-I-64. Most importantly: no user_
    // machines row containing a partial/garbage `secret_hash`.
    const machines = await db.select({ keyId: userMachines.keyId }).from(userMachines);
    expect(machines).toHaveLength(0);

    const [invite] = await db
      .select({ usedCount: onboardingInvites.usedCount })
      .from(onboardingInvites)
      .where(eq(onboardingInvites.tokenHash, hashInviteToken(token)));
    expect(invite.usedCount).toBe(0);

    const usersRows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, 'tc65@example.com'));
    expect(usersRows).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // TC-I-65b: post-rollback, the invite is still redeemable (state is clean).
  // -------------------------------------------------------------------------
  // Augments TC-I-65: after the failed bcrypt-throw redeem, a follow-up
  // call with the REAL bcrypt should succeed. This catches a class of bugs
  // where rollback leaves a phantom lock or a half-committed state that
  // breaks the next attempt.
  it('TC-I-65b: redeem retry after a hashFn-throw failure succeeds (clean rollback, no phantom state)', async () => {
    const db = getDb();
    const token = make64HexToken('tc65b-retry-after-fail');
    await seedInvite({
      orgId: seeded.orgId,
      teamId: seeded.teamAId,
      token,
      maxUses: 1,
    });

    const throwingHashFn = async (): Promise<string> => {
      throw new Error('first attempt fails');
    };
    const r1 = await redeemInvite(
      db,
      {
        token,
        machineId: '33333333-3333-4333-8333-cccccccccccc',
        hostname: 'host-tc65b-1',
        claimedEmail: 'tc65b@example.com',
        requestIp: null,
      },
      { hashFn: throwingHashFn },
    );
    expect(r1.ok).toBe(false);

    // Default hashFn (real bcrypt) — should succeed because state was rolled back.
    const r2 = await redeemInvite(db, {
      token,
      machineId: '33333333-3333-4333-8333-dddddddddddd',
      hostname: 'host-tc65b-2',
      claimedEmail: 'tc65b@example.com',
      requestIp: null,
    });
    expect(r2.ok).toBe(true);

    const machines = await db.select({ keyId: userMachines.keyId }).from(userMachines);
    expect(machines).toHaveLength(1);

    const [invite] = await db
      .select({ usedCount: onboardingInvites.usedCount })
      .from(onboardingInvites)
      .where(eq(onboardingInvites.tokenHash, hashInviteToken(token)));
    expect(invite.usedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// TASK-6 (REQ-16, central-server-onboarding-v2-sso) — org-scoped user lookup.
// ---------------------------------------------------------------------------
//
// `redeemInvite()` upserts the user keyed on the email. Previously this used
// a global `WHERE email = ?` lookup, which silently violated cross-org
// isolation once two orgs are allowed to share an email (sso-v2 drops the
// table-level UNIQUE on `users.email` in favour of `UNIQUE (org_id, email)`).
//
// The fix: include `eq(users.orgId, invite.orgId)` in the WHERE clause so
// the same email belonging to a DIFFERENT org is never returned. TC-I-43 is
// the regression — if the WHERE clause drops the org guard, the redeem would
// pick up the foreign-org user and mutate it (or, worse, attach the new
// machine to the wrong tenant).
// ---------------------------------------------------------------------------

skipDescribe('redeemInvite (org-scoped lookup — REQ-16)', () => {
  let seeded: SeedOrgs;
  let foreignOrgId: string;

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

  beforeEach(async () => {
    seeded = await seedOrgs();
    // Second, unrelated org — used to seed a same-email-but-different-org
    // user that the redeem must NOT match.
    const db = getDb();
    const [foreign] = await db
      .insert(orgs)
      .values({ name: 'RedeemForeignOrg' })
      .returning({ id: orgs.id });
    foreignOrgId = foreign.id;
  });

  afterEach(async () => {
    const db = getDb();
    await db.delete(onboardingRedemptionLog);
    await db.delete(userMachines);
    await db.delete(onboardingInvites);
    await db.delete(users);
    await db.delete(teams);
    await db.delete(orgs);
  });

  // -------------------------------------------------------------------------
  // TC-I-42: happy path — invite's org has a user with the claimed email,
  // redeem reuses that user (does NOT create a duplicate).
  // -------------------------------------------------------------------------
  it('TC-I-42: pre-existing user in invite.org with matching email → reused (single row, ids match)', async () => {
    const db = getDb();
    const [pre] = await db
      .insert(users)
      .values({
        orgId: seeded.orgId,
        teamId: seeded.teamAId,
        email: 'shared@example.com',
        ssoProvider: null,
        ssoSubject: null,
        role: 'member',
      })
      .returning({ id: users.id });

    const token = make64HexToken('tc42-same-org-reuse');
    await seedInvite({ orgId: seeded.orgId, teamId: seeded.teamAId, token });

    const r = await redeemInvite(db, {
      token,
      machineId: MACHINE_A,
      hostname: 'h-tc42',
      claimedEmail: 'shared@example.com',
      requestIp: null,
    });
    expect(r.ok).toBe(true);

    const rows = await db
      .select({ id: users.id, orgId: users.orgId, email: users.email })
      .from(users)
      .where(eq(users.email, 'shared@example.com'));
    // Exactly one user row for this email — the existing one was reused.
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(pre.id);
    expect(rows[0].orgId).toBe(seeded.orgId);
  });

  // -------------------------------------------------------------------------
  // TC-I-43: regression — a user with the same email exists in a DIFFERENT
  // org. Redeem must ignore that user (cross-org isolation) and create a
  // brand-new user in the invite's org.
  // -------------------------------------------------------------------------
  it("TC-I-43: same email exists in a foreign org → redeem creates a new user in invite's org (no cross-org match)", async () => {
    const db = getDb();
    // Foreign-org user with the SAME email the redeemer will claim.
    const [foreignUser] = await db
      .insert(users)
      .values({
        orgId: foreignOrgId,
        teamId: null,
        email: 'cross-org@example.com',
        ssoProvider: null,
        ssoSubject: null,
        role: 'member',
      })
      .returning({ id: users.id });

    const token = make64HexToken('tc43-cross-org-isolation');
    await seedInvite({ orgId: seeded.orgId, teamId: seeded.teamAId, token });

    const r = await redeemInvite(db, {
      token,
      machineId: MACHINE_A,
      hostname: 'h-tc43',
      claimedEmail: 'cross-org@example.com',
      requestIp: null,
    });
    expect(r.ok).toBe(true);

    // There should now be TWO user rows with the same email — one per org.
    const rows = await db
      .select({ id: users.id, orgId: users.orgId })
      .from(users)
      .where(eq(users.email, 'cross-org@example.com'));
    expect(rows).toHaveLength(2);

    const byOrg = new Map(rows.map((u) => [u.orgId, u.id] as const));
    // Foreign-org user untouched: same id as before.
    expect(byOrg.get(foreignOrgId)).toBe(foreignUser.id);
    // Invite-org user is brand-new (distinct id from the foreign one).
    const newUserId = byOrg.get(seeded.orgId);
    expect(newUserId).toBeDefined();
    expect(newUserId).not.toBe(foreignUser.id);

    // The new user_machines row points at the invite-org user, NOT the
    // foreign-org one — this is the actual security invariant. A pre-fix
    // run would attach the machine to `foreignUser.id`.
    const [machine] = await db
      .select({ userId: userMachines.userId })
      .from(userMachines);
    expect(machine.userId).toBe(newUserId);
    expect(machine.userId).not.toBe(foreignUser.id);
  });
});
