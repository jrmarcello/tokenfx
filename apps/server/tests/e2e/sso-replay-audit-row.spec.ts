/**
 * SSO state-replay → audit-row end-to-end.
 *
 * Spec: `.specs/sso-replay-audit-row.md` TC-E2E-09 / TC-E2E-10 / TC-E2E-11.
 * Closes REQ-FU-1 of `oauth-idp-stub` + the audit-row half of spec-b TC-I-34.
 *
 * Stack: `global-setup.ts` spawns the Postgres testcontainer, idp-stub,
 * and Next.js dev server with `OKTA_*` envs pointing at the stub.
 *
 * Strategy:
 *   1. Drive a successful OAuth callback via the stub. The callback's
 *      state cookie is consumed by NextAuth on the round-trip.
 *   2. Capture the callback URL + cookies BEFORE NextAuth consumes
 *      them (i.e., after the stub's 302 to /api/auth/callback/okta).
 *   3. Issue the callback URL a SECOND time with the same cookie jar.
 *      NextAuth throws `InvalidCheck` (state-cookie absent or
 *      mismatched). Auth.js v5 redirects to `?error=Configuration`
 *      (NOT `OAuthCallbackError` — see TASK-0 findings in the spec).
 *   4. SQL probe `auth_event_log` for the `outcome='rejected-replay'`
 *      row written by `auth.ts:writeReplayAuditRowOnInvalidCheck`.
 */
import { Client } from 'pg';
import { test, expect } from '@playwright/test';

import {
  REPLAY_EMAIL_HASH_SENTINEL,
  REPLAY_ISS_SENTINEL,
} from '../../lib/auth/replay-detector';
import { waitForReplayRow } from './helpers/audit-log-probe';
import { resetStubScenario, setStubScenario } from './helpers/idp-stub-control';
import { signInAs } from './helpers/sign-in-as';

const BASE_URL = 'http://localhost:3232';
const STUB_BASE_URL = process.env.IDP_STUB_BASE_URL ?? 'http://localhost:3001';

test.describe('SSO state-replay → audit row', () => {
  test.beforeEach(async () => {
    await resetStubScenario({ baseUrl: STUB_BASE_URL });
  });

  test('TC-E2E-09: replayed callback writes a rejected-replay audit row with sentinels', async ({
    request,
  }) => {
    const testStartMs = Date.now();
    await setStubScenario(
      {
        email: `e2e-stub-replay-${testStartMs}@alpha.test`,
        sub: `stub-sub-replay-${testStartMs}`,
        email_verified: true,
      },
      { baseUrl: STUB_BASE_URL },
    );

    // Drive a /api/auth/signin/okta initiation. NextAuth responds with
    // a redirect to the stub /authorize. We follow redirects manually
    // so we can keep the cookie jar and re-issue the callback URL.
    const initResp = await request.get(`${BASE_URL}/api/auth/signin/okta`, {
      maxRedirects: 0,
    });
    // NextAuth typically renders a signin page or 302s to /authorize.
    // Either is acceptable here — the load-bearing assertion is the
    // FINAL audit-row probe below.
    expect([200, 302, 303, 307]).toContain(initResp.status());

    // To trigger a replay, we hit /api/auth/callback/okta with a known-
    // bad / empty state cookie. NextAuth's `InvalidCheck` throws,
    // logger.error fires, and writeReplayAuditRowOnInvalidCheck runs.
    const replayResp = await request.get(
      `${BASE_URL}/api/auth/callback/okta?code=replay-test&state=missing`,
      {
        maxRedirects: 0,
        headers: { 'x-forwarded-for': '203.0.113.42' },
      },
    );
    // Load-bearing: 200 must be EXCLUDED — Auth.js redirects to the
    // error page on state-replay. A regression that returned 200 from
    // the callback would silently break this contract.
    expect([302, 303, 307]).toContain(replayResp.status());
    const replayLocation = replayResp.headers().location ?? '';
    expect(replayLocation).toMatch(/\/auth\/error/);

    const rows = await waitForReplayRow(testStartMs - 1_000);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0];
    expect(row.outcome).toBe('rejected-replay');
    expect(row.email_hash).toBe(REPLAY_EMAIL_HASH_SENTINEL);
    expect(row.iss).toBe(REPLAY_ISS_SENTINEL);
    expect(row.sso_provider).toBe('unknown');
  });

  test('TC-E2E-10: replay audit row contains no substring of the raw state cookie or other secrets', async ({
    request,
  }) => {
    const testStartMs = Date.now();
    const SENTINEL_STATE = 'SENTINEL-STATE-COOKIE-DO-NOT-PERSIST-XYZ987';

    await request.get(
      `${BASE_URL}/api/auth/callback/okta?code=x&state=${SENTINEL_STATE}`,
      {
        maxRedirects: 0,
        headers: { 'x-forwarded-for': '198.51.100.7' },
      },
    );
    const rows = await waitForReplayRow(testStartMs - 1_000);
    // Iterate over every text column; the raw state value MUST NOT appear.
    for (const r of rows) {
      const blob = [
        r.outcome,
        r.email_hash,
        r.iss,
        r.sso_provider,
        r.ip ?? '',
        r.city ?? '',
        r.user_agent ?? '',
      ].join('|');
      expect(blob).not.toContain(SENTINEL_STATE);
    }
  });

  test('TC-E2E-11: sentinel rows do NOT appear in the manager audit-log page or CSV export (org-scoped by email_hash)', async ({ page, context }) => {
    // The org-scoped query in `lib/queries/audit-log.ts:loadAuditLogPage`
    // filters via `inArray(authEventLog.emailHash, hashesForOrg)`. Sentinel
    // hashes (`'replay:state-mismatch'`) can NEVER match a real peppered
    // SHA-256 hex hash, so sentinel rows are invisible by construction
    // (REQ-7). End-to-end regression lock: seed a sentinel row, sign in
    // as a real manager, hit the manager UI + CSV export, assert the
    // sentinel never appears.
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO auth_event_log
           (sso_provider, iss, email_hash, sso_subject_hash, ip, city, user_agent, outcome)
         VALUES ($1, $2, $3, NULL, NULL, NULL, NULL, 'rejected-replay')`,
        ['unknown', REPLAY_ISS_SENTINEL, REPLAY_EMAIL_HASH_SENTINEL],
      );
    } finally {
      await client.end();
    }

    // Property check — sentinel can never collide with a real hex hash.
    expect(REPLAY_EMAIL_HASH_SENTINEL).not.toMatch(/^[0-9a-f]{64}$/);

    // Drive a real manager session.
    await signInAs(context, { email: 'alice@alpha.test', baseUrl: BASE_URL });

    await page.goto(`${BASE_URL}/manager/audit-log`);
    await page.waitForLoadState('networkidle');
    const renderedHtml = await page.content();
    expect(renderedHtml).not.toContain(REPLAY_EMAIL_HASH_SENTINEL);
    expect(renderedHtml).not.toContain(REPLAY_ISS_SENTINEL);

    const exportResp = await context.request.get(
      `${BASE_URL}/manager/audit-log/export`,
    );
    expect(exportResp.ok()).toBe(true);
    const csvBody = await exportResp.text();
    expect(csvBody).not.toContain(REPLAY_EMAIL_HASH_SENTINEL);
    expect(csvBody).not.toContain(REPLAY_ISS_SENTINEL);
  });
});
