/**
 * Integration tests for `loadFirstAutoProvisionAlert` + `acknowledgeAlert`
 * (central-server-onboarding-v2-sso manager-ui spec, TASK-5).
 *
 * Postgres-backed via Testcontainers (shared globalSetup, see
 * `tests/integration/setup-pg.ts`). Skipped when `SKIP_PG_TESTS=1`.
 *
 * Test plan coverage:
 *   TC-I-01  — happy: 1 sso-auto event in 7d, no ack → `{count: 1, events: [...]}`
 *   TC-I-02  — edge:  0 sso-auto events → null
 *   TC-I-03  — business: events older than 7 days are excluded
 *   TC-I-04  — business: events in a different org are excluded
 *   TC-I-05  — happy: upsert ack for manager A → next query returns null for A
 *   TC-I-06  — business: new sso-auto event after ack → banner returns
 *   TC-I-07  — edge:  ack event A twice → ON CONFLICT preserves the first ackedAt
 *   TC-I-07b — business: events A, B, C all unacked → ack only B → A and C remain
 *   TC-I-08  — security: `loadFirstAutoProvisionAlert` is a thin DB helper
 *              callable regardless of caller role (role gate lives in the page)
 *   TC-I-08b — security: `acknowledgeAlert` is similarly callable; role gate
 *              lives in the Server Action.
 *
 * Conventions:
 *   - No mocking framework; hand-written stubs colocated where needed.
 *   - Real testcontainers Postgres; every test cleans up via afterEach.
 *   - Natural-English `it` names, TC-ID embedded for traceability.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { log as logger } from '@tokenfx/shared/logger';
import { and, eq, sql } from 'drizzle-orm';

import { closeDb, getDb } from '@/lib/db/client';
import {
  managerAlertAcks,
  onboardingInvites,
  onboardingRedemptionLog,
  orgs,
  users,
} from '@/lib/db/schema';

import { hashInviteToken } from '@/lib/auth/tokens';
import {
  acknowledgeAlert,
  loadFirstAutoProvisionAlert,
} from '@/lib/queries/manager-alerts';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Deterministic but PREFIX-DIVERSIFIED token generator. The banner query
 * joins `redemption_log.token_prefix = invites.token_prefix`, so two
 * tokens whose first 8 hex chars collide would alias across orgs. Hex-
 * encoding `'tc-i-04-a'` vs `'tc-i-04-b'` produces the SAME first 4 bytes
 * (`74632d69` = "tc-i") — they only diverge at byte 5. To force a unique
 * prefix per label, we prepend a 4-byte hash of the label.
 */
const makeToken = (label: string): string => {
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = ((hash << 5) - hash + label.charCodeAt(i)) | 0;
  }
  const prefix = (hash >>> 0).toString(16).padStart(8, '0').slice(0, 8);
  const tail = Buffer.from(label.padEnd(28, 'x')).toString('hex');
  return (prefix + tail).padEnd(64, '0').slice(0, 64);
};

type SeedOrgInput = { name?: string };

const seedOrg = async (input: SeedOrgInput = {}): Promise<{ orgId: string }> => {
  const db = getDb();
  const [org] = await db
    .insert(orgs)
    .values({ name: input.name ?? `ManagerAlertsOrg-${Math.random().toString(36).slice(2, 8)}` })
    .returning({ id: orgs.id });
  return { orgId: org.id };
};

type SeedUserInput = {
  orgId: string;
  email: string;
  role?: 'member' | 'manager' | 'admin';
};

const seedUser = async (input: SeedUserInput): Promise<{ userId: string }> => {
  const db = getDb();
  const [user] = await db
    .insert(users)
    .values({
      orgId: input.orgId,
      email: input.email,
      role: input.role ?? 'manager',
    })
    .returning({ id: users.id });
  return { userId: user.id };
};

type SeedInviteInput = {
  orgId: string;
  token: string;
};

const seedInvite = async (input: SeedInviteInput): Promise<void> => {
  const db = getDb();
  await db.insert(onboardingInvites).values({
    tokenHash: hashInviteToken(input.token),
    tokenPrefix: input.token.slice(0, 8),
    orgId: input.orgId,
    emailPattern: '*@example.com',
    maxUses: 50,
    usedCount: 0,
    expiresAt: new Date(Date.now() + 7 * ONE_DAY_MS),
    allowedSsoProviders: [],
  });
};

type SeedRedemptionInput = {
  tokenPrefix: string;
  outcome?: 'accepted-sso-auto' | 'accepted';
  method?: 'sso-auto' | 'manual-token';
  receivedAt?: Date;
  emailHash?: string;
  emailDomain?: string;
  ssoProvider?: string | null;
};

const seedRedemption = async (input: SeedRedemptionInput): Promise<{ id: number }> => {
  const db = getDb();
  const [row] = await db
    .insert(onboardingRedemptionLog)
    .values({
      tokenPrefix: input.tokenPrefix,
      machineId: null,
      emailDomain: input.emailDomain ?? 'example.com',
      emailHash: input.emailHash ?? 'abcdef0123456789aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      requestIp: null,
      outcome: input.outcome ?? 'accepted-sso-auto',
      method: input.method ?? 'sso-auto',
      ssoProvider: input.ssoProvider ?? 'google',
      receivedAt: input.receivedAt ?? new Date(),
    })
    .returning({ id: onboardingRedemptionLog.id });
  return { id: row.id };
};

const truncateAll = async (): Promise<void> => {
  const db = getDb();
  await db.execute(sql`TRUNCATE TABLE
    manager_alert_acks, onboarding_redemption_log, onboarding_audit_log,
    onboarding_invites, user_machines, users, teams, orgs
    RESTART IDENTITY CASCADE`);
};

skipDescribe('manager-alerts queries (Postgres integration)', () => {
  beforeAll(async () => {
    getDb();
    await truncateAll();
  });

  afterAll(async () => {
    await closeDb();
  });

  afterEach(async () => {
    await truncateAll();
  });

  // -------------------------------------------------------------------------
  // TC-I-01 — happy path
  // -------------------------------------------------------------------------
  it('TC-I-01: returns one unacked event for an org with a single sso-auto redemption', async () => {
    const { orgId } = await seedOrg();
    const { userId: managerId } = await seedUser({ orgId, email: 'mgr@example.com', role: 'manager' });
    const token = makeToken('tc-i-01');
    await seedInvite({ orgId, token });
    const { id } = await seedRedemption({
      tokenPrefix: token.slice(0, 8),
      emailHash: 'deadbeefcafefeed1111111111111111111111111111111111111111111111ff',
      ssoProvider: 'google',
    });

    const result = await loadFirstAutoProvisionAlert(getDb(), orgId, managerId);

    expect(result).not.toBeNull();
    expect(result!.count).toBe(1);
    expect(result!.events).toHaveLength(1);
    expect(result!.events[0].eventId).toBe(id);
    expect(result!.events[0].emailHashPrefix).toBe('deadbeef');
    expect(result!.events[0].ssoProvider).toBe('google');
    expect(result!.latestAt).toEqual(result!.events[0].receivedAt);
  });

  // -------------------------------------------------------------------------
  // TC-I-10b (security-hardening-lowsev REQ-6) — the banner JOIN matches
  // redemption_log.token_prefix against invites.token_prefix (= left(plaintext,8)),
  // NOT left(token_hash, 8). A row whose plaintext prefix differs from its hash
  // prefix must still surface — proving the JOIN migrated off LEFT(token, 8).
  // -------------------------------------------------------------------------
  it('TC-I-10b: JOIN matches on token_prefix (left(plaintext,8)), not left(hash,8)', async () => {
    const { orgId } = await seedOrg();
    const { userId: managerId } = await seedUser({ orgId, email: 'mgr@example.com', role: 'manager' });
    const token = makeToken('tc-i-10b-join-on-prefix');
    await seedInvite({ orgId, token });

    // The whole point: the at-rest hash prefix differs from the plaintext
    // prefix, so a JOIN on left(token_hash, 8) would NOT match the redemption.
    const plaintextPrefix = token.slice(0, 8);
    const hashPrefix = hashInviteToken(token).slice(0, 8);
    expect(plaintextPrefix).not.toBe(hashPrefix);

    // The redemption audit trail carries the PLAINTEXT prefix (what redeem +
    // sso-auto write).
    const { id } = await seedRedemption({ tokenPrefix: plaintextPrefix });

    const result = await loadFirstAutoProvisionAlert(getDb(), orgId, managerId);
    expect(result).not.toBeNull();
    expect(result!.count).toBe(1);
    expect(result!.events[0].eventId).toBe(id);
  });

  // -------------------------------------------------------------------------
  // TC-I-02 — empty state
  // -------------------------------------------------------------------------
  it('TC-I-02: returns null when there are no sso-auto events at all', async () => {
    const { orgId } = await seedOrg();
    const { userId: managerId } = await seedUser({ orgId, email: 'mgr@example.com', role: 'manager' });

    const result = await loadFirstAutoProvisionAlert(getDb(), orgId, managerId);

    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // TC-I-03 — events older than 7 days are excluded
  // -------------------------------------------------------------------------
  it('TC-I-03: excludes sso-auto events received more than 7 days ago', async () => {
    const { orgId } = await seedOrg();
    const { userId: managerId } = await seedUser({ orgId, email: 'mgr@example.com', role: 'manager' });
    const token = makeToken('tc-i-03');
    await seedInvite({ orgId, token });

    // 8 days ago — outside the window.
    await seedRedemption({
      tokenPrefix: token.slice(0, 8),
      receivedAt: new Date(Date.now() - 8 * ONE_DAY_MS),
    });
    // 1 hour ago — inside the window.
    const { id: freshId } = await seedRedemption({
      tokenPrefix: token.slice(0, 8),
      receivedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const result = await loadFirstAutoProvisionAlert(getDb(), orgId, managerId);

    expect(result).not.toBeNull();
    expect(result!.count).toBe(1);
    expect(result!.events[0].eventId).toBe(freshId);
  });

  // -------------------------------------------------------------------------
  // TC-I-04 — cross-org isolation
  // -------------------------------------------------------------------------
  it('TC-I-04: excludes sso-auto events belonging to a different org', async () => {
    const { orgId: orgA } = await seedOrg({ name: 'OrgA' });
    const { orgId: orgB } = await seedOrg({ name: 'OrgB' });
    const { userId: managerA } = await seedUser({ orgId: orgA, email: 'mgr@a.com', role: 'manager' });
    const tokenA = makeToken('tc-i-04-a');
    const tokenB = makeToken('tc-i-04-b');
    await seedInvite({ orgId: orgA, token: tokenA });
    await seedInvite({ orgId: orgB, token: tokenB });

    const { id: eventA } = await seedRedemption({ tokenPrefix: tokenA.slice(0, 8) });
    await seedRedemption({ tokenPrefix: tokenB.slice(0, 8) });

    const result = await loadFirstAutoProvisionAlert(getDb(), orgA, managerA);

    expect(result).not.toBeNull();
    expect(result!.count).toBe(1);
    expect(result!.events[0].eventId).toBe(eventA);
  });

  // -------------------------------------------------------------------------
  // TC-I-05 — ack hides the event from subsequent reads
  // -------------------------------------------------------------------------
  it('TC-I-05: ack for manager A causes the next query to return null for A', async () => {
    const { orgId } = await seedOrg();
    const { userId: managerId } = await seedUser({ orgId, email: 'mgr@example.com', role: 'manager' });
    const token = makeToken('tc-i-05');
    await seedInvite({ orgId, token });
    const { id } = await seedRedemption({ tokenPrefix: token.slice(0, 8) });

    await acknowledgeAlert(getDb(), managerId, 'first-auto-provision', id, orgId);

    const result = await loadFirstAutoProvisionAlert(getDb(), orgId, managerId);
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // TC-I-06 — banner reappears for a new event after an ack
  // -------------------------------------------------------------------------
  it('TC-I-06: new sso-auto event arriving after an ack causes the banner to return', async () => {
    const { orgId } = await seedOrg();
    const { userId: managerId } = await seedUser({ orgId, email: 'mgr@example.com', role: 'manager' });
    const token = makeToken('tc-i-06');
    await seedInvite({ orgId, token });
    const { id: firstId } = await seedRedemption({ tokenPrefix: token.slice(0, 8) });

    await acknowledgeAlert(getDb(), managerId, 'first-auto-provision', firstId, orgId);
    // Banner hidden:
    expect(await loadFirstAutoProvisionAlert(getDb(), orgId, managerId)).toBeNull();

    // A new event lands.
    const { id: secondId } = await seedRedemption({ tokenPrefix: token.slice(0, 8) });

    const result = await loadFirstAutoProvisionAlert(getDb(), orgId, managerId);
    expect(result).not.toBeNull();
    expect(result!.count).toBe(1);
    expect(result!.events[0].eventId).toBe(secondId);
  });

  // -------------------------------------------------------------------------
  // TC-I-07 — idempotent ack (ON CONFLICT DO NOTHING preserves first ackedAt)
  // -------------------------------------------------------------------------
  it('TC-I-07: ack of the same event twice preserves the original ackedAt', async () => {
    const { orgId } = await seedOrg();
    const { userId: managerId } = await seedUser({ orgId, email: 'mgr@example.com', role: 'manager' });
    const token = makeToken('tc-i-07');
    await seedInvite({ orgId, token });
    const { id } = await seedRedemption({ tokenPrefix: token.slice(0, 8) });

    await acknowledgeAlert(getDb(), managerId, 'first-auto-provision', id, orgId);
    const db = getDb();
    const [first] = await db
      .select({ ackedAt: managerAlertAcks.ackedAt })
      .from(managerAlertAcks)
      .where(
        and(
          eq(managerAlertAcks.managerUserId, managerId),
          eq(managerAlertAcks.alertKind, 'first-auto-provision'),
          eq(managerAlertAcks.eventId, id),
        ),
      );

    // Wait long enough that a second insert would visibly mutate ackedAt
    // if ON CONFLICT was DO UPDATE instead of DO NOTHING.
    await new Promise((r) => setTimeout(r, 25));

    await acknowledgeAlert(getDb(), managerId, 'first-auto-provision', id, orgId);
    const [second] = await db
      .select({ ackedAt: managerAlertAcks.ackedAt })
      .from(managerAlertAcks)
      .where(
        and(
          eq(managerAlertAcks.managerUserId, managerId),
          eq(managerAlertAcks.alertKind, 'first-auto-provision'),
          eq(managerAlertAcks.eventId, id),
        ),
      );

    expect(second.ackedAt.getTime()).toBe(first.ackedAt.getTime());

    // Sanity: there is still only ONE row for this composite key.
    const allRows = await db
      .select()
      .from(managerAlertAcks)
      .where(
        and(
          eq(managerAlertAcks.managerUserId, managerId),
          eq(managerAlertAcks.alertKind, 'first-auto-provision'),
          eq(managerAlertAcks.eventId, id),
        ),
      );
    expect(allRows).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // TC-I-07b — per-event ack isolation (acking B does not dismiss A, C)
  // -------------------------------------------------------------------------
  it('TC-I-07b: acking event B only drops B from the banner; A and C remain', async () => {
    const { orgId } = await seedOrg();
    const { userId: managerId } = await seedUser({ orgId, email: 'mgr@example.com', role: 'manager' });
    const token = makeToken('tc-i-07b');
    await seedInvite({ orgId, token });

    const { id: a } = await seedRedemption({
      tokenPrefix: token.slice(0, 8),
      receivedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
    });
    const { id: b } = await seedRedemption({
      tokenPrefix: token.slice(0, 8),
      receivedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });
    const { id: c } = await seedRedemption({
      tokenPrefix: token.slice(0, 8),
      receivedAt: new Date(Date.now() - 1 * 60 * 60 * 1000),
    });

    await acknowledgeAlert(getDb(), managerId, 'first-auto-provision', b, orgId);

    const result = await loadFirstAutoProvisionAlert(getDb(), orgId, managerId);
    expect(result).not.toBeNull();
    expect(result!.count).toBe(2);
    const eventIds = result!.events.map((event) => event.eventId);
    // Ordered by receivedAt DESC: C (most recent) first, then A.
    expect(eventIds).toEqual([c, a]);
  });

  // -------------------------------------------------------------------------
  // TC-I-08 — query helper is callable regardless of caller role
  // -------------------------------------------------------------------------
  it('TC-I-08: loadFirstAutoProvisionAlert is a thin DB helper — no role gate inside', async () => {
    const { orgId } = await seedOrg();
    // Caller is a *member*, not a manager. The query MUST still execute
    // (role gating is the page/Server-Action's job). It returns whatever
    // the org currently has; absent any events, the result is null.
    const { userId: memberId } = await seedUser({ orgId, email: 'rank@example.com', role: 'member' });

    // No events seeded — expect null. The point of this case is that no
    // unauthorized exception is thrown.
    await expect(
      loadFirstAutoProvisionAlert(getDb(), orgId, memberId),
    ).resolves.toBeNull();

    // With an event seeded, the helper STILL returns the event — proving
    // role enforcement is intentionally absent.
    const token = makeToken('tc-i-08');
    await seedInvite({ orgId, token });
    const { id } = await seedRedemption({ tokenPrefix: token.slice(0, 8) });

    const result = await loadFirstAutoProvisionAlert(getDb(), orgId, memberId);
    expect(result).not.toBeNull();
    expect(result!.events[0].eventId).toBe(id);
  });

  // -------------------------------------------------------------------------
  // TC-I-08b — acknowledgeAlert is a thin DB helper — no role gate inside
  // -------------------------------------------------------------------------
  it('TC-I-08b: acknowledgeAlert is a thin DB helper — no role gate inside', async () => {
    const { orgId } = await seedOrg();
    const { userId: memberId } = await seedUser({ orgId, email: 'rank@example.com', role: 'member' });
    const token = makeToken('tc-i-08b');
    await seedInvite({ orgId, token });
    const { id } = await seedRedemption({ tokenPrefix: token.slice(0, 8) });

    // The helper accepts any caller. Role gating belongs in the Server Action.
    await expect(
      acknowledgeAlert(getDb(), memberId, 'first-auto-provision', id, orgId),
    ).resolves.toBeUndefined();

    const rows = await getDb()
      .select()
      .from(managerAlertAcks)
      .where(
        and(
          eq(managerAlertAcks.managerUserId, memberId),
          eq(managerAlertAcks.alertKind, 'first-auto-provision'),
          eq(managerAlertAcks.eventId, id),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  // ===========================================================================
  // fix-manager-alert-ack-org-scoping — cross-org rejection + edge cases.
  // ===========================================================================

  // TC-AO-01 (ack-org-scoping spec) — happy path: same-org ack inserts 1 row.
  it('inserts an ack row when event_id belongs to the manager org', async () => {
    const { orgId } = await seedOrg();
    const { userId: managerId } = await seedUser({ orgId, email: 'mgr@ack01.example', role: 'manager' });
    const token = makeToken('ack-org-01');
    await seedInvite({ orgId, token });
    const { id } = await seedRedemption({ tokenPrefix: token.slice(0, 8) });

    await acknowledgeAlert(getDb(), managerId, 'first-auto-provision', id, orgId);

    const rows = await getDb()
      .select()
      .from(managerAlertAcks)
      .where(eq(managerAlertAcks.eventId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0].managerUserId).toBe(managerId);
    expect(rows[0].ackedAt).toBeInstanceOf(Date);
  });

  // TC-AO-02 (ack-org-scoping spec) — cross-org: manager A acking Org B event → 0 rows.
  it('silently rejects ack when event_id belongs to a different org (cross-org attack)', async () => {
    const { orgId: orgAId } = await seedOrg();
    const { orgId: orgBId } = await seedOrg();
    const { userId: managerA } = await seedUser({ orgId: orgAId, email: 'mgr-a@ack02.example', role: 'manager' });
    const tokenB = makeToken('ack-org-02-b');
    await seedInvite({ orgId: orgBId, token: tokenB });
    const { id: eventB } = await seedRedemption({ tokenPrefix: tokenB.slice(0, 8) });

    await acknowledgeAlert(getDb(), managerA, 'first-auto-provision', eventB, orgAId);

    const rows = await getDb()
      .select()
      .from(managerAlertAcks)
      .where(eq(managerAlertAcks.eventId, eventB));
    expect(rows).toHaveLength(0);
  });

  // TC-AO-03 (ack-org-scoping spec) — idempotent re-ack preserves first ackedAt timestamp.
  it('preserves the first ackedAt timestamp on re-ack of the same event', async () => {
    const { orgId } = await seedOrg();
    const { userId: managerId } = await seedUser({ orgId, email: 'mgr@ack03.example', role: 'manager' });
    const token = makeToken('ack-org-03');
    await seedInvite({ orgId, token });
    const { id } = await seedRedemption({ tokenPrefix: token.slice(0, 8) });

    await acknowledgeAlert(getDb(), managerId, 'first-auto-provision', id, orgId);
    const first = await getDb()
      .select()
      .from(managerAlertAcks)
      .where(eq(managerAlertAcks.eventId, id));
    expect(first).toHaveLength(1);
    const firstAt = first[0].ackedAt;

    await new Promise((resolve) => setTimeout(resolve, 25));

    await acknowledgeAlert(getDb(), managerId, 'first-auto-provision', id, orgId);
    const second = await getDb()
      .select()
      .from(managerAlertAcks)
      .where(eq(managerAlertAcks.eventId, id));
    expect(second).toHaveLength(1);
    expect(second[0].ackedAt.getTime()).toBe(firstAt.getTime());
  });

  // TC-AO-04 (ack-org-scoping spec) — forensic isolation: acking eventA leaves eventB unacked.
  it('keeps a second same-org event unacked when only the first is acknowledged', async () => {
    const { orgId } = await seedOrg();
    const { userId: managerId } = await seedUser({ orgId, email: 'mgr@ack04.example', role: 'manager' });
    const token = makeToken('ack-org-04');
    await seedInvite({ orgId, token });
    const { id: eventA } = await seedRedemption({ tokenPrefix: token.slice(0, 8) });
    const { id: eventB } = await seedRedemption({ tokenPrefix: token.slice(0, 8) });

    await acknowledgeAlert(getDb(), managerId, 'first-auto-provision', eventA, orgId);

    const ackedRows = await getDb()
      .select()
      .from(managerAlertAcks)
      .where(eq(managerAlertAcks.managerUserId, managerId));
    expect(ackedRows.map((r) => r.eventId).sort()).toEqual([eventA].sort());

    const alert = await loadFirstAutoProvisionAlert(getDb(), orgId, managerId);
    expect(alert?.count).toBe(1);
    expect(alert?.events.map((e) => e.eventId)).toEqual([eventB]);
  });

  // TC-AO-05 (ack-org-scoping spec) — positive predicate arm under a different (org, manager, event) tuple.
  it('accepts an ack from manager B in Org B for an Org B event', async () => {
    const { orgId: orgBId } = await seedOrg();
    const { userId: managerB } = await seedUser({ orgId: orgBId, email: 'mgr-b@ack05.example', role: 'manager' });
    const tokenB = makeToken('ack-org-05-b');
    await seedInvite({ orgId: orgBId, token: tokenB });
    const { id: eventB } = await seedRedemption({ tokenPrefix: tokenB.slice(0, 8) });

    await acknowledgeAlert(getDb(), managerB, 'first-auto-provision', eventB, orgBId);

    const rows = await getDb()
      .select()
      .from(managerAlertAcks)
      .where(eq(managerAlertAcks.eventId, eventB));
    expect(rows).toHaveLength(1);
  });

  // TC-AO-06 (ack-org-scoping spec) — method=manual-token does NOT bypass the cross-org predicate.
  it('still rejects cross-org when the event method is manual-token (not sso-auto)', async () => {
    const { orgId: orgAId } = await seedOrg();
    const { orgId: orgBId } = await seedOrg();
    const { userId: managerA } = await seedUser({ orgId: orgAId, email: 'mgr-a@ack06.example', role: 'manager' });
    const tokenB = makeToken('ack-org-06-b');
    await seedInvite({ orgId: orgBId, token: tokenB });
    const { id: eventB } = await seedRedemption({
      tokenPrefix: tokenB.slice(0, 8),
      method: 'manual-token',
    });

    await acknowledgeAlert(getDb(), managerA, 'first-auto-provision', eventB, orgAId);

    const rows = await getDb()
      .select()
      .from(managerAlertAcks)
      .where(eq(managerAlertAcks.eventId, eventB));
    expect(rows).toHaveLength(0);
  });

  // TC-AO-07 (ack-org-scoping spec) — non-existent event_id silently no-ops (WHERE EXISTS false).
  it('silently no-ops when event_id does not exist in onboarding_redemption_log', async () => {
    const { orgId } = await seedOrg();
    const { userId: managerId } = await seedUser({ orgId, email: 'mgr@ack07.example', role: 'manager' });

    await expect(
      acknowledgeAlert(getDb(), managerId, 'first-auto-provision', 999_999_999, orgId),
    ).resolves.toBeUndefined();

    const rows = await getDb()
      .select()
      .from(managerAlertAcks)
      .where(eq(managerAlertAcks.eventId, 999_999_999));
    expect(rows).toHaveLength(0);
  });

  // TC-AO-08 (ack-org-scoping spec) — orgId='' fail-safe (0 rows, no throw on ''::uuid cast).
  it('fails safe (0 rows, no throw) when orgId is an empty string', async () => {
    const { orgId } = await seedOrg();
    const { userId: managerId } = await seedUser({ orgId, email: 'mgr@ack08.example', role: 'manager' });
    const token = makeToken('ack-org-08');
    await seedInvite({ orgId, token });
    const { id } = await seedRedemption({ tokenPrefix: token.slice(0, 8) });

    await expect(
      acknowledgeAlert(getDb(), managerId, 'first-auto-provision', id, ''),
    ).resolves.toBeUndefined();

    const rows = await getDb()
      .select()
      .from(managerAlertAcks)
      .where(eq(managerAlertAcks.eventId, id));
    expect(rows).toHaveLength(0);
  });

  // TC-AO-09 (ack-org-scoping spec) — privacy invariant: cross-org rejection emits NO log entry.
  it('does not log anything on cross-org rejection (privacy posture)', async () => {
    const { orgId: orgAId } = await seedOrg();
    const { orgId: orgBId } = await seedOrg();
    const { userId: managerA } = await seedUser({ orgId: orgAId, email: 'mgr-a@ack09.example', role: 'manager' });
    const tokenB = makeToken('ack-org-09-b');
    await seedInvite({ orgId: orgBId, token: tokenB });
    const { id: eventB } = await seedRedemption({ tokenPrefix: tokenB.slice(0, 8) });

    // Spy setup BEFORE try-block so failed setup doesn't leak unrestored
    // spies. The assertion is forward-looking: acknowledgeAlert today
    // makes zero logger calls; a future regression that adds
    // `logger.warn` on the rejection path would break the privacy
    // posture, and THIS test would catch it.
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    try {
      await acknowledgeAlert(getDb(), managerA, 'first-auto-provision', eventB, orgAId);
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(infoSpy).not.toHaveBeenCalled();
      expect(debugSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      infoSpy.mockRestore();
      debugSpy.mockRestore();
    }
  });
});
