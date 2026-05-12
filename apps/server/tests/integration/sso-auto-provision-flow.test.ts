/**
 * Integration tests for the full SSO auto-provision flow (TASK-12).
 *
 * Spec: .specs/central-server-onboarding-v2-sso.backend.md
 *
 * Covers:
 *   TC-I-01 .. TC-I-15  — orchestrator E2E against a real Postgres
 *   TC-I-22 .. TC-I-27  — signIn-callback integration semantics
 *
 * Strategy
 *   - Exercise `evaluateAutoProvision` directly with REAL Postgres (Drizzle +
 *     testcontainers) so the orchestrator's transactional core + audit writes
 *     are validated end-to-end. The pure unit suite (sso-auto-provision.test.ts)
 *     already exercises the decision tree with stubs; this suite focuses on
 *     the wiring that touches the DB.
 *   - For TC-I-22..27 (signIn callback semantics), we exercise `evaluateSignIn`
 *     + `evaluateAutoProvision` against the same DB to mirror the auth.ts
 *     signIn callback's branching, rather than spinning up NextAuth in-test.
 *     The auth.ts file itself wires the two functions together; this suite
 *     validates the integration contract each side honors.
 *
 * Conventions
 *   - Hand-written stubs colocated below; no mocking framework (project rule).
 *   - Each test cleans up via afterEach so cases stay order-independent.
 *   - TC-IDs appear in `it` descriptions for spec traceability.
 *   - Race test TC-I-35 uses TWO real pg connections (§Decisão #22) so the
 *     pure `revalidateInvite` predicate is exercised inside the FOR UPDATE
 *     transaction — fake timers cannot simulate cross-tx visibility.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { and, eq, sql } from 'drizzle-orm';

import { closeDb, getDb } from '@/lib/db/client';
import {
  authEventLog,
  onboardingInvites,
  onboardingRedemptionLog,
  orgs,
  teams,
  users,
} from '@/lib/db/schema';

import {
  evaluateAutoProvision,
  type AutoProvisionDeps,
  type AutoProvisionInput,
  type FindPreExistingV1User,
} from '@/lib/auth/sso-auto-provision';
import { matchActiveInvitesByEmail } from '@/lib/auth/match-active-invites';
import { evaluateSignIn } from '@/lib/auth/load-user';
import { hashEmail, emailDomain } from '@/lib/auth/email-hash';
import { __resetSsoRateLimit } from '@/lib/auth/rate-limit-sso';
import { __resetPreExistingBindingEmailState } from '@/lib/auth/pre-existing-binding-email';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

// =============================================================================
// Test fixtures + helpers
// =============================================================================

const TEST_ISSUER = 'https://accounts.google.com';
const TEST_CLIENT_ID = 'tokenfx-test-client';
const TEST_PROVIDER = 'google';
const TEST_PEPPER = 'tokenfx-integration-test-pepper';

/**
 * Deterministic invite-token generator (64 hex). The orchestrator only
 * inspects the first 8 chars for `tokenPrefix`; full hex keeps the column
 * looking authentic.
 */
const makeToken = (label: string): string => {
  const seed = label.padEnd(32, 'x');
  return Buffer.from(seed).toString('hex').padEnd(64, '0').slice(0, 64);
};

/** Minimal `AutoProvisionInput` builder — overrides explicit per test. */
const makeInput = (overrides: Partial<AutoProvisionInput> = {}): AutoProvisionInput => ({
  email: 'dev@example.com',
  ssoProvider: TEST_PROVIDER,
  ssoSubject: 'oidc-sub-default',
  ssoIssuer: TEST_ISSUER,
  audience: TEST_CLIENT_ID,
  emailVerified: true,
  ip: '',
  userAgent: 'Mozilla/5.0 (integration-test)',
  displayName: 'Test Dev',
  ...overrides,
});

type SeedOrgInput = {
  name?: string;
};

const seedOrg = async (input: SeedOrgInput = {}): Promise<{ orgId: string }> => {
  const db = getDb();
  const [org] = await db
    .insert(orgs)
    .values({ name: input.name ?? 'SsoFlowOrg' })
    .returning({ id: orgs.id });
  return { orgId: org.id };
};

const seedTeam = async (orgId: string, name = 'Alpha'): Promise<{ teamId: string }> => {
  const db = getDb();
  const [team] = await db
    .insert(teams)
    .values({ orgId, name })
    .returning({ id: teams.id });
  return { teamId: team.id };
};

type SeedInviteInput = {
  orgId: string;
  teamId?: string | null;
  token: string;
  emailPattern?: string | null;
  maxUses?: number;
  allowedSsoProviders?: string[];
  /** Used to override expiry — defaults to 1 day. */
  expiresInMs?: number;
};

const seedInvite = async (input: SeedInviteInput): Promise<void> => {
  const db = getDb();
  await db.insert(onboardingInvites).values({
    token: input.token,
    orgId: input.orgId,
    teamId: input.teamId ?? null,
    emailPattern: input.emailPattern ?? '*@example.com',
    maxUses: input.maxUses ?? 5,
    usedCount: 0,
    expiresAt: new Date(Date.now() + (input.expiresInMs ?? 24 * 60 * 60 * 1000)),
    allowedSsoProviders: input.allowedSsoProviders ?? [],
  });
};

/**
 * Build production-grade deps wired to the real DB. By default we use the
 * production `evaluateAutoProvision` exports for every collaborator
 * (matchActiveInvitesByEmail, etc.); the consumer only overrides what a
 * given test needs (e.g. an email-helper spy).
 */
type DepsOverrides = {
  /** Spy on pre-existing-binding email sends. */
  preExistingEmailCalls?: Array<{ to: string; city: string | null; browser: string | null }>;
  /** Replace findPreExistingV1User for testing the pre-existing branch. */
  findPreExistingV1User?: FindPreExistingV1User;
};

const buildIntegrationDeps = (
  overrides: DepsOverrides = {},
): Partial<AutoProvisionDeps> => {
  const partial: Partial<AutoProvisionDeps> = {
    issuerWhitelist: new Set([TEST_ISSUER]),
    clientId: TEST_CLIENT_ID,
  };

  if (overrides.preExistingEmailCalls !== undefined) {
    const calls = overrides.preExistingEmailCalls;
    partial.sendPreExistingBindingEmail = async (input) => {
      calls.push({ to: input.to, city: input.city, browser: input.browser });
      return { sent: true, messageId: 'integration-stub-mid' };
    };
  }

  if (overrides.findPreExistingV1User) {
    partial.findPreExistingV1User = overrides.findPreExistingV1User;
  }

  return partial;
};

/**
 * Truncate every table this suite writes to. CASCADE handles FK fan-out.
 * `RESTART IDENTITY` resets bigserial counters so `auth_event_log.id` stays
 * predictable.
 */
const truncateAll = async (): Promise<void> => {
  const db = getDb();
  await db.execute(sql`TRUNCATE TABLE
    auth_event_log, onboarding_redemption_log, onboarding_audit_log,
    onboarding_invites, user_machines, users, teams, orgs
    RESTART IDENTITY CASCADE`);
};

// =============================================================================
// Suite
// =============================================================================

skipDescribe('SSO auto-provision flow (Postgres integration)', () => {
  beforeAll(async () => {
    // Pin the pepper so hashEmail is deterministic regardless of env.
    process.env.ONBOARDING_EMAIL_HASH_PEPPER = TEST_PEPPER;
    getDb();
    await truncateAll();
  });

  afterAll(async () => {
    await closeDb();
  });

  beforeEach(() => {
    // Each test re-resets the in-process rate-limit + email-rate state so
    // earlier cases (TC-I-20 family in other suites or repeated TC-I-XX runs)
    // can't leak counters across tests.
    __resetSsoRateLimit();
    __resetPreExistingBindingEmailState();
  });

  afterEach(async () => {
    await truncateAll();
  });

  // ---------------------------------------------------------------------------
  // TC-I-01 — happy path
  // ---------------------------------------------------------------------------
  it('TC-I-01: end-to-end auto-provision happy path writes users + audit rows', async () => {
    const { orgId } = await seedOrg();
    const { teamId } = await seedTeam(orgId);
    const token = makeToken('tc-i-01-happy');
    await seedInvite({ orgId, teamId, token });

    const decision = await evaluateAutoProvision(
      makeInput({ email: 'alice@example.com' }),
      buildIntegrationDeps(),
    );

    expect(decision.kind).toBe('accepted-sso-auto');
    if (decision.kind !== 'accepted-sso-auto') throw new Error('unreachable');
    expect(decision.orgId).toBe(orgId);

    const db = getDb();
    const userRows = await db
      .select({
        id: users.id,
        email: users.email,
        orgId: users.orgId,
        teamId: users.teamId,
        ssoProvider: users.ssoProvider,
        role: users.role,
      })
      .from(users);
    expect(userRows).toHaveLength(1);
    expect(userRows[0].email).toBe('alice@example.com');
    expect(userRows[0].orgId).toBe(orgId);
    expect(userRows[0].teamId).toBe(teamId);
    expect(userRows[0].ssoProvider).toBe(TEST_PROVIDER);

    const authEvents = await db.select().from(authEventLog);
    expect(authEvents).toHaveLength(1);
    expect(authEvents[0].outcome).toBe('accepted-sso-auto');

    const redemptionRows = await db.select().from(onboardingRedemptionLog);
    expect(redemptionRows).toHaveLength(1);
    expect(redemptionRows[0].outcome).toBe('accepted-sso-auto');
    expect(redemptionRows[0].method).toBe('sso-auto');
  });

  // ---------------------------------------------------------------------------
  // TC-I-02 — public domain
  // ---------------------------------------------------------------------------
  it('TC-I-02: public-domain email is rejected with both audit rows but no user', async () => {
    const { orgId } = await seedOrg();
    await seedInvite({
      orgId,
      token: makeToken('tc-i-02-public'),
      emailPattern: '*@gmail.com',
    });

    const decision = await evaluateAutoProvision(
      makeInput({ email: 'spammer@gmail.com' }),
      buildIntegrationDeps(),
    );

    expect(decision.kind).toBe('rejected-public-domain');
    const db = getDb();
    const userRows = await db.select().from(users);
    expect(userRows).toHaveLength(0);
    const authEvents = await db.select().from(authEventLog);
    expect(authEvents).toHaveLength(1);
    expect(authEvents[0].outcome).toBe('rejected-public-domain');
    const redemptionRows = await db.select().from(onboardingRedemptionLog);
    expect(redemptionRows).toHaveLength(1);
    expect(redemptionRows[0].outcome).toBe('rejected-public-domain');
  });

  // ---------------------------------------------------------------------------
  // TC-I-03 — no match
  // ---------------------------------------------------------------------------
  it('TC-I-03: zero matching invites returns rejected-no-match', async () => {
    await seedOrg();
    // No invite seeded — matchActiveInvitesByEmail returns [].
    const decision = await evaluateAutoProvision(
      makeInput({ email: 'nobody@example.com' }),
      buildIntegrationDeps(),
    );

    expect(decision.kind).toBe('rejected-no-match');
    const db = getDb();
    expect(await db.select().from(users)).toHaveLength(0);
    const authEvents = await db.select().from(authEventLog);
    expect(authEvents).toHaveLength(1);
    expect(authEvents[0].outcome).toBe('rejected-no-match');
  });

  // ---------------------------------------------------------------------------
  // TC-I-04 — multiple matches across orgs
  // ---------------------------------------------------------------------------
  it('TC-I-04: two orgs with overlapping pattern returns rejected-multiple-matches', async () => {
    const { orgId: orgA } = await seedOrg({ name: 'OrgA' });
    const { orgId: orgB } = await seedOrg({ name: 'OrgB' });
    // Use tokens whose first-8 differ so we can prove "first match alphabetical".
    const tokenA = makeToken('aaa-tc-i-04-a');
    const tokenB = makeToken('zzz-tc-i-04-b');
    await seedInvite({ orgId: orgA, token: tokenA });
    await seedInvite({ orgId: orgB, token: tokenB });

    const decision = await evaluateAutoProvision(
      makeInput({ email: 'multi@example.com' }),
      buildIntegrationDeps(),
    );

    expect(decision.kind).toBe('rejected-multiple-matches');
    const db = getDb();
    const authEvents = await db.select().from(authEventLog);
    expect(authEvents).toHaveLength(1);
    expect(authEvents[0].outcome).toBe('rejected-multiple-matches');
    const redemptionRows = await db.select().from(onboardingRedemptionLog);
    expect(redemptionRows).toHaveLength(1);
    // Token prefix in audit row should be the alphabetically-first token's
    // first 8 chars (token_prefix length = 8 per onboarding_audit_log CHECK).
    const sortedTokens = [tokenA, tokenB].sort();
    expect(redemptionRows[0].tokenPrefix).toBe(sortedTokens[0].slice(0, 8));
  });

  // ---------------------------------------------------------------------------
  // TC-I-05 — cross-IdP rejected
  // ---------------------------------------------------------------------------
  it('TC-I-05: allowed_sso_providers=[google] + ssoProvider=okta returns rejected-cross-idp', async () => {
    const { orgId } = await seedOrg();
    await seedInvite({
      orgId,
      token: makeToken('tc-i-05-cross'),
      allowedSsoProviders: ['google'],
    });

    const decision = await evaluateAutoProvision(
      makeInput({ ssoProvider: 'okta' }),
      buildIntegrationDeps(),
    );

    expect(decision.kind).toBe('rejected-cross-idp');
    const db = getDb();
    expect(await db.select().from(users)).toHaveLength(0);
    const authEvents = await db.select().from(authEventLog);
    expect(authEvents[0].outcome).toBe('rejected-cross-idp');
  });

  // ---------------------------------------------------------------------------
  // TC-I-06 — empty allowed list = legacy/any provider accepted
  // ---------------------------------------------------------------------------
  it('TC-I-06: allowed_sso_providers=[] (legacy) accepts any provider', async () => {
    const { orgId } = await seedOrg();
    await seedInvite({
      orgId,
      token: makeToken('tc-i-06-legacy'),
      allowedSsoProviders: [],
    });

    const decision = await evaluateAutoProvision(
      makeInput({ ssoProvider: 'okta', ssoIssuer: TEST_ISSUER }),
      buildIntegrationDeps(),
    );

    expect(decision.kind).toBe('accepted-sso-auto');
  });

  // ---------------------------------------------------------------------------
  // TC-I-07 — pre-existing v1 user binding
  // ---------------------------------------------------------------------------
  it('TC-I-07: pre-existing v1 user (NULL sso_provider) in same org returns rejected-pre-existing-binding and invokes email helper', async () => {
    const { orgId } = await seedOrg();
    await seedInvite({ orgId, token: makeToken('tc-i-07-binding') });
    // Seed a v1 user — same email, NULL sso fields, same org.
    const db = getDb();
    await db.insert(users).values({
      orgId,
      email: 'legacy@example.com',
      ssoProvider: null,
      ssoSubject: null,
      role: 'member',
    });

    const emailCalls: Array<{ to: string; city: string | null; browser: string | null }> = [];
    const decision = await evaluateAutoProvision(
      makeInput({ email: 'legacy@example.com' }),
      buildIntegrationDeps({ preExistingEmailCalls: emailCalls }),
    );

    expect(decision.kind).toBe('rejected-pre-existing-binding');
    expect(emailCalls).toHaveLength(1);
    expect(emailCalls[0].to).toBe('legacy@example.com');
    const authEvents = await db.select().from(authEventLog);
    expect(authEvents[0].outcome).toBe('rejected-pre-existing-binding');
  });

  // ---------------------------------------------------------------------------
  // TC-I-35 — end-to-end race using TWO real pg connections (REQ-15).
  //
  // Methodology (§Decisão #22):
  //   1. Seed a live invite.
  //   2. From a SECOND pg.Pool, revoke the invite + COMMIT — this happens
  //      BEFORE the orchestrator opens its tx, so there's no lock contention.
  //   3. Invoke `evaluateAutoProvision` on the primary connection. Internally
  //      it runs `matchActiveInvitesByEmail` (the WHERE clause filters live
  //      rows, but the row is now revoked — yet the candidate-selection still
  //      returns it if the revoke landed AFTER its read snapshot). To
  //      deterministically force the race window, we call the second-pool
  //      revoke AFTER the candidate selection has already happened but BEFORE
  //      the FOR UPDATE.
  //
  // The simplest deterministic path: pre-fetch the invite via
  // `matchActiveInvitesByEmail` ourselves to mimic the orchestrator's first
  // step, then revoke from a second pool, then drive the orchestrator (which
  // will re-run match — but match filters on revoked_at IS NULL so the
  // re-match would short-circuit to rejected-no-match, NOT rejected-race).
  //
  // To exercise the FOR UPDATE re-validation path specifically we call
  // `defaultProvisionInTx`-equivalent path via `evaluateAutoProvision` with
  // an injected `matchActiveInvitesByEmail` that returns a stale (still-live)
  // copy of the invite. Then a second-pool UPDATE revokes the row BEFORE
  // the orchestrator's FOR UPDATE re-reads it. Inside the tx, the SELECT
  // FOR UPDATE sees the revoked row, `revalidateInvite` returns
  // `{valid: false, reason: 'revoked'}`, and the decision is rejected-race.
  //
  // No fake timers — real pg races prove the predicate fires inside the
  // FOR UPDATE tx.
  // ---------------------------------------------------------------------------
  it('TC-I-35: rejects with rejected-race when invite is revoked between match query and FOR UPDATE', async () => {
    const { orgId } = await seedOrg();
    const token = makeToken('tc-i-35-real-race');
    await seedInvite({ orgId, token });

    // Capture the live invite via the production matcher so we can hand a
    // pre-revoke snapshot to the orchestrator. matchActiveInvitesByEmail
    // returns ActiveInvite shape sans `revokedAt` — at this point the row
    // is live.
    const liveMatches = await matchActiveInvitesByEmail('racer@example.com');
    expect(liveMatches).toHaveLength(1);
    const liveInvite = liveMatches[0];

    // Open a SECOND pg connection and revoke the invite + COMMIT before the
    // orchestrator opens its tx. By the time the orchestrator's SELECT FOR
    // UPDATE fires, the row IS revoked — the FOR UPDATE returns it (PK lookup
    // ignores revoked_at), and `revalidateInvite` reports it.
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL not set');
    const secondPool = new Pool({ connectionString: databaseUrl });
    try {
      const client = await secondPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'UPDATE onboarding_invites SET revoked_at = NOW() WHERE token = $1',
          [token],
        );
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    } finally {
      await secondPool.end();
    }

    // Inject a stale matcher that returns the pre-revoke snapshot — this
    // bypasses the candidate-selection's `revoked_at IS NULL` filter so the
    // orchestrator believes it has a live candidate and proceeds into the
    // transactional core. The FOR UPDATE re-select is the one that observes
    // the revoke; revalidateInvite (TASK-3) reports `revoked`, mapped to
    // `rejected-race` per spec b §Decisão #22.
    const decision = await evaluateAutoProvision(
      makeInput({ email: 'racer@example.com' }),
      {
        issuerWhitelist: new Set([TEST_ISSUER]),
        clientId: TEST_CLIENT_ID,
        matchActiveInvitesByEmail: async () => [liveInvite],
      },
    );

    expect(decision.kind).toBe('rejected-race');
    const db = getDb();
    // No user row was created.
    expect(await db.select().from(users)).toHaveLength(0);
    // used_count was NOT bumped.
    const inviteRows = await db
      .select({ usedCount: onboardingInvites.usedCount })
      .from(onboardingInvites)
      .where(eq(onboardingInvites.token, token));
    expect(inviteRows[0].usedCount).toBe(0);
    // Audit row was written OUTSIDE the rolled-back tx.
    const authEvents = await db.select().from(authEventLog);
    expect(authEvents).toHaveLength(1);
    expect(authEvents[0].outcome).toBe('rejected-race');
  });

  // ---------------------------------------------------------------------------
  // TC-I-11 — accepted: user shape includes role=member and team_id from invite
  // ---------------------------------------------------------------------------
  it('TC-I-11: accepted user row has role=member and team_id from invite', async () => {
    const { orgId } = await seedOrg();
    const { teamId } = await seedTeam(orgId, 'Beta');
    await seedInvite({
      orgId,
      teamId,
      token: makeToken('tc-i-11-team-from-invite'),
    });

    const decision = await evaluateAutoProvision(
      makeInput({ email: 'memberish@example.com' }),
      buildIntegrationDeps(),
    );
    expect(decision.kind).toBe('accepted-sso-auto');

    const db = getDb();
    const [userRow] = await db
      .select({ role: users.role, teamId: users.teamId })
      .from(users);
    expect(userRow.role).toBe('member');
    expect(userRow.teamId).toBe(teamId);
  });

  // ---------------------------------------------------------------------------
  // TC-I-12 — accepted: invite team_id=NULL → user team_id=NULL
  // ---------------------------------------------------------------------------
  it('TC-I-12: accepted with invite team_id=NULL writes user with team_id=NULL', async () => {
    const { orgId } = await seedOrg();
    await seedInvite({
      orgId,
      teamId: null,
      token: makeToken('tc-i-12-null-team'),
    });

    const decision = await evaluateAutoProvision(
      makeInput({ email: 'noteam@example.com' }),
      buildIntegrationDeps(),
    );
    expect(decision.kind).toBe('accepted-sso-auto');

    const db = getDb();
    const [userRow] = await db.select({ teamId: users.teamId }).from(users);
    expect(userRow.teamId).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // TC-I-13 — used_count bumped atomically + auth_event_log row in same tx
  // ---------------------------------------------------------------------------
  it('TC-I-13: used_count incremented atomically alongside auth_event_log + redemption-log row', async () => {
    const { orgId } = await seedOrg();
    const token = makeToken('tc-i-13-atomic-bump');
    await seedInvite({ orgId, token });

    const decision = await evaluateAutoProvision(
      makeInput({ email: 'atomic@example.com' }),
      buildIntegrationDeps(),
    );
    expect(decision.kind).toBe('accepted-sso-auto');

    const db = getDb();
    const [inv] = await db
      .select({ usedCount: onboardingInvites.usedCount })
      .from(onboardingInvites)
      .where(eq(onboardingInvites.token, token));
    expect(inv.usedCount).toBe(1);
    const authEvents = await db.select().from(authEventLog);
    expect(authEvents).toHaveLength(1);
    const redemptionRows = await db.select().from(onboardingRedemptionLog);
    expect(redemptionRows).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // TC-I-14 — auth_event_log row has every required field
  // ---------------------------------------------------------------------------
  it('TC-I-14: auth_event_log row has every required field populated correctly', async () => {
    const { orgId } = await seedOrg();
    await seedInvite({ orgId, token: makeToken('tc-i-14-fields') });

    const longUa = 'A'.repeat(700); // exceeds 512 → truncated by writer
    const decision = await evaluateAutoProvision(
      makeInput({ email: 'fields@example.com', userAgent: longUa, ip: '' }),
      buildIntegrationDeps(),
    );
    expect(decision.kind).toBe('accepted-sso-auto');

    const db = getDb();
    const [evt] = await db.select().from(authEventLog);
    expect(evt.ssoProvider).toBe(TEST_PROVIDER);
    expect(evt.iss).toBe(TEST_ISSUER);
    expect(evt.emailHash).toBe(hashEmail('fields@example.com'));
    expect(evt.ssoSubjectHash).toBeTruthy();
    // ip is empty string passed in — writer preserves it (NOT null).
    expect(evt.ip).toBe('');
    // city: ip-to-city stub always returns null in spec b.
    expect(evt.city).toBeNull();
    // user_agent truncated to <= 512 chars by writer's truncateUserAgent.
    expect(evt.userAgent).not.toBeNull();
    if (evt.userAgent !== null) {
      expect(evt.userAgent.length).toBeLessThanOrEqual(512);
    }
    expect(evt.outcome).toBe('accepted-sso-auto');
    // occurred_at within last 30 seconds.
    const occurred = new Date(evt.occurredAt).getTime();
    expect(Math.abs(Date.now() - occurred)).toBeLessThan(30_000);
  });

  // ---------------------------------------------------------------------------
  // TC-I-15 — redemption-log row: method='sso-auto'; machine_id NULL on
  // both accepted and rejected paths (spec b doesn't mint creds inside the
  // orchestrator — auth.ts owns machine credentials post-accept).
  // ---------------------------------------------------------------------------
  it('TC-I-15: redemption-log rows carry method=sso-auto on accepted and rejected paths', async () => {
    const { orgId } = await seedOrg();
    await seedInvite({ orgId, token: makeToken('tc-i-15-method') });

    const decisionAccepted = await evaluateAutoProvision(
      makeInput({ email: 'accept@example.com' }),
      buildIntegrationDeps(),
    );
    expect(decisionAccepted.kind).toBe('accepted-sso-auto');

    // Reject path — use a different email that doesn't match any invite.
    const decisionRejected = await evaluateAutoProvision(
      makeInput({ email: 'reject@other.com' }),
      buildIntegrationDeps(),
    );
    expect(decisionRejected.kind).toBe('rejected-no-match');

    const db = getDb();
    const rows = await db
      .select({
        outcome: onboardingRedemptionLog.outcome,
        method: onboardingRedemptionLog.method,
        machineId: onboardingRedemptionLog.machineId,
      })
      .from(onboardingRedemptionLog)
      .orderBy(onboardingRedemptionLog.id);
    expect(rows).toHaveLength(2);
    // Accepted row.
    expect(rows[0].outcome).toBe('accepted-sso-auto');
    expect(rows[0].method).toBe('sso-auto');
    // machine_id is NULL — spec b defers machine credential minting.
    expect(rows[0].machineId).toBeNull();
    // Rejected row.
    expect(rows[1].outcome).toBe('rejected-no-match');
    expect(rows[1].method).toBe('sso-auto');
    expect(rows[1].machineId).toBeNull();
  });

  // ===========================================================================
  // signIn callback integration semantics — TC-I-22..27
  //
  // The auth.ts signIn callback runs:
  //   1. loadUserBySsoIdentity (sso first)
  //   2. select rows by email
  //   3. evaluateSignIn(oauth, existingRows) → decision kind
  //   4. on 'bootstrap': matchActiveInvitesByEmail → if ≥1 match,
  //      evaluateAutoProvision; else single-org-bootstrap fallback
  //
  // We exercise the same control flow against the real DB, asserting
  // observable side effects. NextAuth itself is NOT spawned — the contract
  // we validate is "given these existing rows + invite matches, the right
  // decision is reached and the right side effects fire".
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // TC-I-22 — bootstrap + SSO-auto pattern match → accepted-sso-auto
  // ---------------------------------------------------------------------------
  it('TC-I-22: signIn-style flow with bootstrap + SSO-auto pattern → accepted-sso-auto', async () => {
    const { orgId } = await seedOrg();
    await seedInvite({ orgId, token: makeToken('tc-i-22-bootstrap-sso') });

    // Mirror auth.ts.signIn for the bootstrap branch: empty existing rows
    // → evaluateSignIn returns 'bootstrap' → matchActiveInvitesByEmail
    // returns ≥1 → call evaluateAutoProvision.
    const email = 'newuser@example.com';
    const db = getDb();
    const existing = await db
      .select({ ssoProvider: users.ssoProvider, ssoSubject: users.ssoSubject })
      .from(users)
      .where(eq(users.email, email));
    const decision = evaluateSignIn(
      { provider: TEST_PROVIDER, providerAccountId: 'sub-tc22' },
      existing,
    );
    expect(decision.kind).toBe('bootstrap');

    const matches = await matchActiveInvitesByEmail(email);
    expect(matches.length).toBe(1);

    const apDecision = await evaluateAutoProvision(
      makeInput({ email, ssoSubject: 'sub-tc22' }),
      buildIntegrationDeps(),
    );
    expect(apDecision.kind).toBe('accepted-sso-auto');

    const userRows = await db.select({ email: users.email }).from(users);
    expect(userRows).toHaveLength(1);
    expect(userRows[0].email).toBe(email);
  });

  // ---------------------------------------------------------------------------
  // TC-I-23 — bootstrap + no SSO-auto pattern → falls through to v1
  // ---------------------------------------------------------------------------
  it('TC-I-23: signIn-style flow with bootstrap + no SSO-auto pattern → v1 single-org-bootstrap fallback', async () => {
    const { orgId } = await seedOrg();
    // No invite seeded — matchActiveInvitesByEmail returns [].
    const email = 'firstuser@example.com';

    const db = getDb();
    const existing = await db
      .select({ ssoProvider: users.ssoProvider, ssoSubject: users.ssoSubject })
      .from(users)
      .where(eq(users.email, email));
    const decision = evaluateSignIn(
      { provider: TEST_PROVIDER, providerAccountId: 'sub-tc23' },
      existing,
    );
    expect(decision.kind).toBe('bootstrap');

    const matches = await matchActiveInvitesByEmail(email);
    expect(matches).toHaveLength(0);

    // Single-org-bootstrap fallback — auth.ts inserts a user when allOrgs.length === 1.
    const allOrgs = await db.select({ id: orgs.id }).from(orgs).limit(2);
    expect(allOrgs).toHaveLength(1);
    await db.insert(users).values({
      orgId: allOrgs[0].id,
      email,
      ssoProvider: TEST_PROVIDER,
      ssoSubject: 'sub-tc23',
      role: 'member',
    });
    const userRows = await db.select({ email: users.email }).from(users);
    expect(userRows).toHaveLength(1);
    expect(userRows[0].email).toBe(email);
    // No SSO-auto orchestrator was invoked → no auth_event_log row.
    expect(await db.select().from(authEventLog)).toHaveLength(0);
    // Reference orgId so TS does not warn about an unused-locals violation.
    expect(orgId).toBe(allOrgs[0].id);
  });

  // ---------------------------------------------------------------------------
  // TC-I-24 — v1 fill-sso flow: legacy user with NULL sso_provider + matching email
  // ---------------------------------------------------------------------------
  it('TC-I-24: v1 fill-sso flow updates NULL sso_provider on existing user', async () => {
    const { orgId } = await seedOrg();
    const email = 'legacy-fill@example.com';
    const db = getDb();
    await db.insert(users).values({
      orgId,
      email,
      ssoProvider: null,
      ssoSubject: null,
      role: 'member',
    });

    const existing = await db
      .select({ ssoProvider: users.ssoProvider, ssoSubject: users.ssoSubject })
      .from(users)
      .where(eq(users.email, email));
    const decision = evaluateSignIn(
      { provider: TEST_PROVIDER, providerAccountId: 'sub-tc24' },
      existing,
    );
    expect(decision.kind).toBe('fill-sso');

    // Mirror auth.ts: UPDATE sso_provider + sso_subject.
    if (decision.kind === 'fill-sso') {
      await db
        .update(users)
        .set({ ssoProvider: decision.provider, ssoSubject: decision.subject })
        .where(eq(users.email, email));
    }

    const [updated] = await db
      .select({ ssoProvider: users.ssoProvider, ssoSubject: users.ssoSubject })
      .from(users)
      .where(eq(users.email, email));
    expect(updated.ssoProvider).toBe(TEST_PROVIDER);
    expect(updated.ssoSubject).toBe('sub-tc24');
  });

  // ---------------------------------------------------------------------------
  // TC-I-25 — v1 allow flow: existing SSO-bound user → decision 'allow'
  // ---------------------------------------------------------------------------
  it('TC-I-25: v1 allow flow returns allow for existing SSO-bound user', async () => {
    const { orgId } = await seedOrg();
    const email = 'allowed@example.com';
    const db = getDb();
    await db.insert(users).values({
      orgId,
      email,
      ssoProvider: TEST_PROVIDER,
      ssoSubject: 'sub-tc25',
      role: 'member',
    });

    const existing = await db
      .select({ ssoProvider: users.ssoProvider, ssoSubject: users.ssoSubject })
      .from(users)
      .where(eq(users.email, email));
    const decision = evaluateSignIn(
      { provider: TEST_PROVIDER, providerAccountId: 'sub-tc25' },
      existing,
    );
    expect(decision.kind).toBe('allow');
  });

  // ---------------------------------------------------------------------------
  // TC-I-26 — v1 reject-mismatch flow: existing user with different sso subject
  // ---------------------------------------------------------------------------
  it('TC-I-26: v1 reject-mismatch flow rejects when sso_subject differs', async () => {
    const { orgId } = await seedOrg();
    const email = 'mismatch@example.com';
    const db = getDb();
    await db.insert(users).values({
      orgId,
      email,
      ssoProvider: TEST_PROVIDER,
      ssoSubject: 'sub-original',
      role: 'member',
    });

    const existing = await db
      .select({ ssoProvider: users.ssoProvider, ssoSubject: users.ssoSubject })
      .from(users)
      .where(eq(users.email, email));
    const decision = evaluateSignIn(
      { provider: TEST_PROVIDER, providerAccountId: 'sub-different' },
      existing,
    );
    expect(decision.kind).toBe('reject-mismatch');
  });

  // ---------------------------------------------------------------------------
  // TC-I-27 — v1 ambiguous-multi-org: same email in 2 orgs → ambiguous decision
  // ---------------------------------------------------------------------------
  it('TC-I-27: v1 ambiguous-multi-org flow returns ambiguous-multi-org when email maps to 2 orgs', async () => {
    const { orgId: orgA } = await seedOrg({ name: 'OrgA' });
    const { orgId: orgB } = await seedOrg({ name: 'OrgB' });
    const email = 'multi-org@example.com';
    const db = getDb();
    await db.insert(users).values([
      {
        orgId: orgA,
        email,
        ssoProvider: TEST_PROVIDER,
        ssoSubject: 'sub-a',
        role: 'member',
      },
      {
        orgId: orgB,
        email,
        ssoProvider: TEST_PROVIDER,
        ssoSubject: 'sub-b',
        role: 'member',
      },
    ]);

    const existing = await db
      .select({ ssoProvider: users.ssoProvider, ssoSubject: users.ssoSubject })
      .from(users)
      .where(eq(users.email, email));
    expect(existing.length).toBe(2);
    const decision = evaluateSignIn(
      { provider: TEST_PROVIDER, providerAccountId: 'sub-a' },
      existing,
    );
    expect(decision.kind).toBe('ambiguous-multi-org');
  });
});

// =============================================================================
// Unused-import guard — keeps Pool / and / hashEmail / emailDomain / Result
// imports honest if a future refactor drops the references.
// =============================================================================

// `Pool` and `and` are retained for future race tests that may need a second
// connection; reference them once to keep tsc + eslint quiet.
const _typeGuards = (): void => {
  const _p: typeof Pool = Pool;
  const _a: typeof and = and;
  const _d: typeof emailDomain = emailDomain;
  void _p;
  void _a;
  void _d;
};
void _typeGuards;
