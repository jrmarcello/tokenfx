/**
 * Integration tests locking the SSO-invite seeding contract.
 *
 * Spec: `.specs/fix-sso-e2e-remaining-5.md` TASK-3 (TC-I-05, TC-I-06).
 *
 * - TC-I-05: with an active `*@alpha.test` invite row seeded (a pattern
 *   that DOES match Alice's email), the Credentials bypass provider's
 *   `authorize()` still returns a valid user for `alice@alpha.test`.
 *   This locks the adversarial contract: invite presence does NOT
 *   break the bypass path even when the invite WOULD match the email
 *   (validates TASK-1's root-cause conclusion that the previous
 *   "30-test regression" was port collision, NOT fixture pollution).
 * - TC-I-06: `matchActiveInvitesByEmail` with a seeded
 *   `email_pattern='*@e2e-sso.test'` row returns the invite for BOTH
 *   `e2e-stub-happy@e2e-sso.test` AND `e2e-sso-new@e2e-sso.test`.
 *   Locks the wildcard-matcher assumption that TASK-3's seed relies on.
 */
import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAuthorize } from '@/lib/auth/e2e-bypass-provider';
import { matchActiveInvitesByEmail } from '@/lib/auth/match-active-invites';
import { closeDb, getDb } from '@/lib/db/client';
import { onboardingInvites, orgs, users } from '@/lib/db/schema';
import { stableUuid } from '@/lib/e2e/seed-ids';

const skipIfNoPg = process.env.SKIP_PG_TESTS === '1' ? describe.skip : describe;

const ALPHA_ORG_ID = stableUuid('org:org-alpha');
const ALICE_EMAIL = 'alice@alpha.test';

skipIfNoPg('seed-sso-invites contract (TC-I-05, TC-I-06)', () => {
  beforeAll(async () => {
    const db = getDb();
    // Wipe + seed minimal fixtures. We deliberately do NOT run
    // `seed-server.ts --e2e` here to keep this test fast and focused on
    // the invite-vs-bypass contract — that script's full surface is
    // already covered by `auth-bearer.test.ts:TC-I-08/09`.
    await db.execute(sql`TRUNCATE TABLE
      onboarding_invites, users, teams, orgs
      RESTART IDENTITY CASCADE`);
    await db.insert(orgs).values({ id: ALPHA_ORG_ID, name: 'Alpha Co' });
    await db.insert(users).values({
      id: stableUuid('user:org-alpha:alice'),
      orgId: ALPHA_ORG_ID,
      email: ALICE_EMAIL,
      role: 'admin',
      ssoProvider: 'e2e-seed',
      ssoSubject: `e2e:${ALICE_EMAIL}`,
    });
    // Seed TWO wildcard invites so each TC exercises an adversarial fixture:
    //   - `*@alpha.test` makes TC-I-05's `alice@alpha.test` MATCH an active
    //     invite (so the test actually proves the bypass ignores invites
    //     rather than incidentally not being evaluated).
    //   - `*@e2e-sso.test` is the canonical SSO-test wildcard TC-I-06
    //     probes against (used by `seed-server.ts` for the E2E run).
    const alphaToken = createHash('sha256')
      .update('e2e:wildcard-invite:alpha')
      .digest('hex');
    const ssoToken = createHash('sha256')
      .update('e2e:wildcard-invite:e2e-sso')
      .digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await db.insert(onboardingInvites).values([
      {
        token: alphaToken,
        orgId: ALPHA_ORG_ID,
        teamId: null,
        emailPattern: '*@alpha.test',
        maxUses: 100,
        usedCount: 0,
        expiresAt,
        allowedSsoProviders: ['okta'],
      },
      {
        token: ssoToken,
        orgId: ALPHA_ORG_ID,
        teamId: null,
        emailPattern: '*@e2e-sso.test',
        maxUses: 100,
        usedCount: 0,
        expiresAt,
        allowedSsoProviders: ['okta'],
      },
    ]);
  });

  afterAll(async () => {
    await closeDb();
  });

  it('TC-I-05: bypass authorize() returns user when wildcard invite is present', async () => {
    // Mirror seed-sso-invites contract: even with an active *@alpha.test
    // invite row, the Credentials bypass for alice@alpha.test returns
    // her seeded user (not null, not a thrown error).
    const { loadUserByEmail } = await import('@/lib/auth/load-user');
    const authorize = createAuthorize(loadUserByEmail);
    const fakeRequest = new Request('http://localhost:3232/api/auth/callback/credentials', {
      headers: { host: 'localhost:3232' },
    });
    const result = await authorize({ email: ALICE_EMAIL }, fakeRequest);
    expect(result).not.toBeNull();
    expect(result?.email).toBe(ALICE_EMAIL);
    expect(result?.role).toBe('admin');
    expect(result?.orgId).toBe(ALPHA_ORG_ID);
  });

  it('TC-I-06: matchActiveInvitesByEmail returns the wildcard row for two distinct e2e emails', async () => {
    const happyMatches = await matchActiveInvitesByEmail('e2e-stub-happy@e2e-sso.test');
    const ssoNewMatches = await matchActiveInvitesByEmail('e2e-sso-new@e2e-sso.test');
    expect(happyMatches.length).toBe(1);
    expect(ssoNewMatches.length).toBe(1);
    expect(happyMatches[0].token).toBe(ssoNewMatches[0].token);
    expect(happyMatches[0].emailPattern).toBe('*@e2e-sso.test');
    expect(happyMatches[0].orgId).toBe(ALPHA_ORG_ID);
  });
});
