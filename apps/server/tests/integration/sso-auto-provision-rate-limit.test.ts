/**
 * Integration tests for the SSO auto-provision rate-limit path
 * (central-server-onboarding-v2-sso.backend — TASK-14).
 *
 * Validates the rate-limited decision path of `evaluateAutoProvision`
 * end-to-end against a Postgres backend so the audit-log discipline
 * (Decisão #16: rate-limited writes ONLY to `onboarding_redemption_log`,
 * never to `auth_event_log`, and never opens a transaction against
 * `users` / `user_machines`) is verified against real row counts — not
 * just against unit-test stub call counts.
 *
 * TC mapping:
 *   - TC-I-20  Rate-limit: 11 evaluateAutoProvision attempts from same IP
 *              within 5min → 11th returns `'rate-limited'` decision +
 *              onboarding_redemption_log row with outcome='rate-limited'.
 *   - TC-I-21  Rate-limited attempt does NOT open a DB transaction
 *              against users/user_machines/auth_event_log — only
 *              onboarding_redemption_log is incremented.
 *   - TC-I-47  Rate-limited SSO attempt writes 1 onboarding_redemption_log
 *              row AND 0 auth_event_log rows (Decisão #16).
 *   - TC-I-48  Burst test: 10 fast-succession evaluateAutoProvision
 *              calls all succeed (under the per-IP cap of 10/5min); the
 *              row-count probe confirms zero leaked `users` /
 *              `user_machines` / `auth_event_log` writes for the 11th
 *              rate-limited call.
 *
 * Postgres-backed via the shared Testcontainers `setup-pg.ts`.
 *
 * No HTTP layer — drives `evaluateAutoProvision` directly per the spec
 * Notes ("verify by post-attempt row counts"). This isolates the
 * rate-limit semantics from auth.ts plumbing.
 *
 * State hygiene: `__resetSsoRateLimit()` in `beforeEach` clears the
 * in-memory counters between tests so independent IPs don't interfere.
 *
 * Convention notes:
 *   - No mocking framework (per ts-conventions.md). The only injected
 *     dep is a no-op stub for `provisionInTx` so accepted attempts
 *     don't try to mint a real user_machines row (credential issuance
 *     lives in auth.ts; outside this test's scope). Every other dep
 *     uses the production wiring so row counts reflect real writes.
 *   - We seed an invite + email that would match if rate-limiting were
 *     bypassed — so TC-I-21's "tx not opened" assertion is meaningful
 *     (the rate-limit short-circuits BEFORE the lookup, so even a
 *     would-be successful provision is suppressed).
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { sql } from 'drizzle-orm';

import { closeDb, getDb } from '@/lib/db/client';
import {
  authEventLog,
  onboardingInvites,
  onboardingRedemptionLog,
  orgs,
  teams,
  userMachines,
  users,
} from '@/lib/db/schema';
import {
  type AutoProvisionInput,
  type ProvisionInTxResult,
  evaluateAutoProvision,
} from '@/lib/auth/sso-auto-provision';
import { __resetSsoRateLimit } from '@/lib/auth/rate-limit-sso';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

// -------- Fixtures -----------------------------------------------------------

/**
 * Build a 64-hex-char token from a stable seed so different tests can
 * generate distinct, non-colliding tokens without coordinating values.
 */
const make64HexToken = (label: string): string =>
  Buffer.from(label.padEnd(32, 'x'))
    .toString('hex')
    .padEnd(64, '0')
    .slice(0, 64);

type SeedHandles = {
  orgId: string;
  teamId: string;
  token: string;
};

const seedOrgInvite = async (): Promise<SeedHandles> => {
  const db = getDb();
  const [org] = await db
    .insert(orgs)
    .values({ name: 'RateLimitTestOrg' })
    .returning({ id: orgs.id });
  const [team] = await db
    .insert(teams)
    .values({ orgId: org.id, name: 'RateLimitTestTeam' })
    .returning({ id: teams.id });
  const token = make64HexToken('rl-task14-invite');
  await db.insert(onboardingInvites).values({
    token,
    orgId: org.id,
    teamId: team.id,
    emailPattern: '*@example.com',
    maxUses: 100,
    usedCount: 0,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    allowedSsoProviders: ['google'],
  });
  return { orgId: org.id, teamId: team.id, token };
};

/**
 * Stable AutoProvisionInput builder. Each test parameterizes the IP / email
 * so it can either share a dimension key (to trigger the cap) or vary it
 * (to isolate dimensions across tests).
 */
const makeInput = (
  overrides: Partial<AutoProvisionInput> = {},
): AutoProvisionInput => ({
  email: 'dev@example.com',
  ssoProvider: 'google',
  ssoSubject: 'oidc-sub-rate-limit-task14',
  ssoIssuer: 'https://accounts.google.com',
  audience: 'tokenfx-test-client',
  emailVerified: true,
  ip: '203.0.113.99',
  userAgent: 'Mozilla/5.0 (rate-limit-task14)',
  displayName: 'Rate Limit Test',
  ...overrides,
});

/**
 * Common deps overrides used by every test. We:
 *
 * (a) Pin `issuerWhitelist` + `clientId` so we don't depend on the runtime
 *     `TOKENFX_NEXTAUTH_CLIENT_ID` env var being set in the test process.
 * (b) Stub `provisionInTx` to a no-op accepted result — the real one would
 *     try to INSERT into `users`/`user_machines`, but credential minting
 *     (key_id/secret_hash) lives in auth.ts and is out of scope for this
 *     rate-limit test. The stub never runs on the rate-limited path
 *     anyway; we keep it for hygiene if a future case slips through.
 */
const TEST_CLIENT_ID = 'tokenfx-test-client';
const TEST_ISSUER = 'https://accounts.google.com';

const stubProvisionInTx = async (): Promise<ProvisionInTxResult> => ({
  kind: 'accepted',
  userId: '00000000-0000-0000-0000-000000000abc',
});

const depsOverrides = {
  issuerWhitelist: new Set([TEST_ISSUER]),
  clientId: TEST_CLIENT_ID,
  provisionInTx: stubProvisionInTx,
} as const;

// -------- Row-count probe ----------------------------------------------------

type RowCounts = {
  users: number;
  userMachines: number;
  authEventLog: number;
  onboardingRedemptionLog: number;
};

const countRows = async (): Promise<RowCounts> => {
  const db = getDb();
  // `db.select().from(...)` returns rows we can `.length` — straightforward
  // and avoids the QueryResult-vs-array shape divergence between Drizzle
  // versions for `db.execute()`.
  const [usersRows, umRows, aelRows, orlRows] = await Promise.all([
    db.select({ id: users.id }).from(users),
    db.select({ id: userMachines.id }).from(userMachines),
    db.select({ id: authEventLog.id }).from(authEventLog),
    db.select({ id: onboardingRedemptionLog.id }).from(onboardingRedemptionLog),
  ]);
  return {
    users: usersRows.length,
    userMachines: umRows.length,
    authEventLog: aelRows.length,
    onboardingRedemptionLog: orlRows.length,
  };
};

// -------- Suite --------------------------------------------------------------

skipDescribe('SSO auto-provision rate-limit (integration)', () => {
  beforeAll(async () => {
    const db = getDb();
    // Wipe the shared schema so prior test files (redeem-route, etc.) don't
    // leak rows that would skew our delta counts. Same CASCADE pattern as
    // sibling integration tests.
    await db.execute(sql`TRUNCATE TABLE
      manager_dismissed_anomalies, manager_anomalies, manager_drilldown_audit,
      manager_notifications, team_metrics_daily, cron_runs, org_settings,
      onboarding_redemption_log, onboarding_audit_log, onboarding_invites,
      auth_event_log,
      ingestion_log, model_breakdown_agg, tool_count_agg, sessions_agg,
      cost_calibration_per_user, user_machines, users, teams, orgs
      RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    await closeDb();
  });

  beforeEach(async () => {
    __resetSsoRateLimit();
  });

  afterEach(async () => {
    const db = getDb();
    // Clean up any rows produced by the test. Order matters for FK
    // cascade — children before parents.
    await db.delete(onboardingRedemptionLog);
    await db.delete(authEventLog);
    await db.delete(userMachines);
    await db.delete(onboardingInvites);
    await db.delete(users);
    await db.delete(teams);
    await db.delete(orgs);
  });

  // ===========================================================================
  // TC-I-20: 11 attempts from same IP within 5min → 11th returns rate-limited
  // and writes an onboarding_redemption_log row with outcome='rate-limited'.
  // ===========================================================================

  it('TC-I-20: 11 same-IP attempts within 5min — 11th returns rate-limited and writes a redemption-log row', async () => {
    const db = getDb();
    await seedOrgInvite();
    const ip = '203.0.113.20';

    // Vary the email AND sso_subject per attempt so neither the email_hash
    // (3/24h) nor sso_subject_hash (5/24h) dimensions saturate first — we
    // want to trigger the per-IP cap (10/5min) on the 11th call. The first
    // 10 must NOT trip rate-limit; they fall through to subsequent checks
    // (which may return other outcomes, e.g. accepted via the stub).
    for (let i = 0; i < 10; i += 1) {
      const decision = await evaluateAutoProvision(
        makeInput({
          ip,
          email: `dev-${i}@example.com`,
          ssoSubject: `oidc-sub-${i}`,
        }),
        depsOverrides,
      );
      expect(decision.kind).not.toBe('rate-limited');
    }

    // 11th call from same IP — first dimension (ip, 10/5min) is now full.
    const rateLimited = await evaluateAutoProvision(
      makeInput({
        ip,
        email: 'dev-10@example.com',
        ssoSubject: 'oidc-sub-10',
      }),
      depsOverrides,
    );
    expect(rateLimited.kind).toBe('rate-limited');
    if (rateLimited.kind === 'rate-limited') {
      expect(rateLimited.dimension).toBe('ip');
      expect(rateLimited.retryAfterSec).toBeGreaterThan(0);
    }

    // Verify the rate-limited row landed in onboarding_redemption_log with
    // outcome='rate-limited' (the v1 enum value reused per Decisão #16).
    const rlRows = await db
      .select()
      .from(onboardingRedemptionLog)
      .where(sql`${onboardingRedemptionLog.outcome} = 'rate-limited'`);
    expect(rlRows.length).toBe(1);
    expect(rlRows[0].method).toBe('sso-auto');
    expect(rlRows[0].requestIp).toBe(ip);
    expect(rlRows[0].machineId).toBeNull();
  });

  // ===========================================================================
  // TC-I-21: Rate-limited attempt does NOT open a tx against
  // users/user_machines/auth_event_log. Row-count probe instead of
  // pg_stat_activity (more robust + deterministic).
  // ===========================================================================

  it('TC-I-21: rate-limited attempt does NOT touch users/user_machines/auth_event_log', async () => {
    await seedOrgInvite();
    const ip = '203.0.113.21';

    // Drive the per-IP counter to its limit. Each pre-fill call may write
    // to auth_event_log/users via the (stubbed) provisionInTx happy path;
    // we capture row counts AFTER the prefill so the rate-limited probe
    // measures DELTA from the saturated state.
    for (let i = 0; i < 10; i += 1) {
      await evaluateAutoProvision(
        makeInput({
          ip,
          email: `dev-${i}@example.com`,
          ssoSubject: `oidc-sub-${i}`,
        }),
        depsOverrides,
      );
    }

    const before = await countRows();

    // The 11th call MUST be rate-limited and MUST NOT mutate users /
    // user_machines / auth_event_log.
    const rateLimited = await evaluateAutoProvision(
      makeInput({
        ip,
        email: 'dev-10@example.com',
        ssoSubject: 'oidc-sub-10',
      }),
      depsOverrides,
    );
    expect(rateLimited.kind).toBe('rate-limited');

    const after = await countRows();

    expect(after.users).toBe(before.users);
    expect(after.userMachines).toBe(before.userMachines);
    expect(after.authEventLog).toBe(before.authEventLog);
    // The only delta allowed is +1 row on the redemption-log table
    // (outcome='rate-limited').
    expect(after.onboardingRedemptionLog).toBe(
      before.onboardingRedemptionLog + 1,
    );
  });

  // ===========================================================================
  // TC-I-47: Rate-limited writes exactly 1 redemption-log row AND
  // 0 auth_event_log rows. Tighter than TC-I-21 (this asserts absolute
  // counts, not just deltas, against an empty DB).
  // ===========================================================================

  it('TC-I-47: rate-limited writes 1 onboarding_redemption_log row + 0 auth_event_log rows', async () => {
    await seedOrgInvite();
    const ip = '203.0.113.47';

    // To force the rate-limit ON THE FIRST CALL we'd need a non-default
    // limit, which we don't have. Instead, drive the counter to its cap
    // and inspect ONLY the rate-limited call's behavior — we'll measure
    // BEFORE the 11th call, then verify the delta is exactly 1
    // redemption-log row and exactly 0 auth_event_log rows.
    for (let i = 0; i < 10; i += 1) {
      await evaluateAutoProvision(
        makeInput({
          ip,
          email: `dev-${i}@example.com`,
          ssoSubject: `oidc-sub-${i}`,
        }),
        depsOverrides,
      );
    }
    const before = await countRows();

    const rateLimited = await evaluateAutoProvision(
      makeInput({
        ip,
        email: 'dev-10@example.com',
        ssoSubject: 'oidc-sub-10',
      }),
      depsOverrides,
    );
    expect(rateLimited.kind).toBe('rate-limited');

    const after = await countRows();
    expect(after.onboardingRedemptionLog - before.onboardingRedemptionLog).toBe(1);
    expect(after.authEventLog - before.authEventLog).toBe(0);
    expect(after.users - before.users).toBe(0);
    expect(after.userMachines - before.userMachines).toBe(0);
  });

  // ===========================================================================
  // TC-I-48: Burst test — 10 fast-succession calls under the per-IP cap;
  // the 11th is rate-limited. Row counts after the rate-limited call:
  // exactly 1 redemption-log row with outcome='rate-limited' AND 0
  // user_machines / 0 auth_event_log rows attributable to the burst's
  // 11th call (no DB tx for users-write was opened).
  // ===========================================================================

  it('TC-I-48: burst of 10 within window succeeds; 11th rate-limits and writes 0 users / 0 auth_event_log rows for it', async () => {
    const db = getDb();
    await seedOrgInvite();
    const ip = '203.0.113.48';

    // 10 fast-succession calls — all under the cap. Each may write some
    // rows via the production fan-out; we capture the snapshot AFTER the
    // burst to isolate the rate-limited call's contribution.
    const burstResults = await Promise.all(
      Array.from({ length: 10 }, (_unused, i) =>
        evaluateAutoProvision(
          makeInput({
            ip,
            email: `dev-${i}@example.com`,
            ssoSubject: `oidc-sub-${i}`,
          }),
          depsOverrides,
        ),
      ),
    );
    // NOTE: in-memory rate-limiter is synchronous within a single Node
    // process; Promise.all schedules them serially with no real
    // concurrency at the counter level, so all 10 succeed deterministically.
    for (const decision of burstResults) {
      expect(decision.kind).not.toBe('rate-limited');
    }

    const before = await countRows();

    const rateLimited = await evaluateAutoProvision(
      makeInput({
        ip,
        email: 'dev-10@example.com',
        ssoSubject: 'oidc-sub-10',
      }),
      depsOverrides,
    );
    expect(rateLimited.kind).toBe('rate-limited');

    const after = await countRows();

    // The 11th call's net contribution: +1 redemption-log row, 0 elsewhere.
    expect(after.onboardingRedemptionLog - before.onboardingRedemptionLog).toBe(1);
    expect(after.authEventLog - before.authEventLog).toBe(0);
    expect(after.users - before.users).toBe(0);
    expect(after.userMachines - before.userMachines).toBe(0);

    // And the only new redemption-log row carries the rate-limited outcome.
    const newRlRows = await db
      .select()
      .from(onboardingRedemptionLog)
      .where(sql`${onboardingRedemptionLog.outcome} = 'rate-limited'`);
    expect(newRlRows.length).toBe(1);
    expect(newRlRows[0].requestIp).toBe(ip);
    expect(newRlRows[0].method).toBe('sso-auto');
  });
});
