/**
 * Nonce-validation rejection → audit-row write, end-to-end.
 *
 * Spec: `.specs/sso-nonce-replay.md` TC-E2E-01..04. Closes spec-b TC-I-45
 * and REQ-FU-2 of `.specs/oauth-idp-stub.md`.
 *
 * Stack (provided by `global-setup.ts`): Postgres testcontainer +
 * idp-stub + Next.js dev server. The `auth.config.ts` Okta provider
 * now declares `checks: ['pkce', 'state', 'nonce']` — without this
 * config change, NextAuth's nonce path never runs and TC-E2E-03 cannot
 * pass.
 *
 * Test design (per spec §Decisões #5): we DO NOT replay a callback URL
 * after a successful first response. Auth.js runs the `state` check
 * before the `nonce` check in `@auth/core/src/lib/actions/callback/oauth/callback.ts`,
 * so a URL-replay fires `InvalidCheck` on the state branch — proving
 * nothing about whether nonce validation is enabled. Instead we pin a
 * deliberately tampered `id_token.nonce` via the stub scenario and
 * drive a SINGLE callback with a fresh, valid state cookie. NextAuth's
 * state check passes; the nonce check fails; `InvalidCheck` fires on
 * the nonce branch; the existing `auth.ts:logger.error` hook writes
 * the audit row.
 */
import { test, expect } from '@playwright/test';

import {
  REPLAY_EMAIL_HASH_SENTINEL,
  REPLAY_ISS_SENTINEL,
} from '../../lib/auth/replay-detector';
import { e2eOrgId } from '../../lib/e2e/seed-ids';

import { truncateReplayRows, waitForReplayRow } from './helpers/audit-log-probe';
import { resetStubScenario, setStubScenario } from './helpers/idp-stub-control';
import { initiateOktaSignin } from './helpers/initiate-okta-signin';
import { resetSsoInvitesIsolated } from './helpers/sso-invite-isolation';

const BASE_URL = 'http://localhost:3232';
const STUB_BASE_URL = process.env.IDP_STUB_BASE_URL ?? 'http://localhost:3001';

// The `__Secure-` prefix is only emitted when cookies carry `Secure;`
// (HTTPS-only). The Playwright dev server is HTTP, so cookies omit the
// prefix. Match both shapes.
const NONCE_COOKIE_RE = /(?:__Secure-)?(authjs|next-auth)\.nonce/;

test.describe('SSO nonce-validation → audit row', () => {
  test.beforeAll(async () => {
    // fix-sso-e2e-remaining-5 TASK-3 isolation: see sso-flow.spec.ts
    // for rationale — wipe + re-seed the wildcard invite so NULL-pattern
    // invites left by earlier specs don't cause rejected-multiple-matches.
    await resetSsoInvitesIsolated(e2eOrgId('org-alpha'));
  });

  test.beforeEach(async () => {
    await resetStubScenario({ baseUrl: STUB_BASE_URL });
    // fix-sso-e2e-remaining-5 TASK-4: scrub the sentinel `rejected-replay`
    // rows so prior tests in the same Playwright run (e.g. sso-flow's
    // TC-E2E-08) don't leak into this spec's `.toBe(0)` / `.toBe(1)` row
    // counts via the `occurred_at > testStartMs - 1_000` poll window.
    await truncateReplayRows();
  });

  test('TC-E2E-01: /api/auth/signin/okta redirects to stub /authorize with a nonce query param + sets a sealed nonce cookie', async ({
    request,
  }) => {
    const res = await initiateOktaSignin(request, BASE_URL, { maxRedirects: 0 });
    expect([302, 303, 307]).toContain(res.status());
    const location = res.headers().location ?? '';
    expect(location).toMatch(/\/authorize/);
    const url = new URL(location);
    const nonce = url.searchParams.get('nonce');
    expect(nonce, 'nonce query param must be present in /authorize redirect').toBeTruthy();
    expect(nonce!.length).toBeGreaterThan(8);

    const setCookieHeaders = res.headers()['set-cookie'] ?? '';
    expect(setCookieHeaders).toMatch(NONCE_COOKIE_RE);
  });

  test('TC-E2E-02: healthy first callback (stub echoes URL nonce) sets a session cookie AND writes NO rejected-replay row', async ({
    request,
  }) => {
    const testStartMs = Date.now();

    const res = await initiateOktaSignin(request, BASE_URL, { maxRedirects: 5 });
    expect(res.url()).not.toContain('/auth/error');

    // Positive assertion: a session cookie must land in the Playwright
    // request context's cookie jar. Without this, the test would pass
    // on a partial flow that never establishes auth state.
    //
    // fix-sso-e2e-remaining-5 TASK-3: original assertion probed
    // `res.headers()['set-cookie']` after `maxRedirects:5` — but on a
    // redirect chain Playwright surfaces ONLY the final response's
    // Set-Cookie headers. The session-token is set by the intermediate
    // /api/auth/callback/okta 302 and consumed (cookie jar updated)
    // before the chain lands. Probe the cookie jar directly instead.
    const state = await request.storageState();
    const sessionCookie = state.cookies.find((c) =>
      /(authjs|next-auth)\.session-token/.test(c.name),
    );
    expect(sessionCookie, 'session-token cookie should be in the request context cookie jar').toBeDefined();

    // waitForReplayRow polls internally — no external sleep needed.
    const rows = await waitForReplayRow(testStartMs - 1_000, 500);
    expect(rows.length).toBe(0);
  });

  test('TC-E2E-03: tampered id_token nonce → callback rejected → exactly ONE rejected-replay audit row with sentinels', async ({
    request,
  }) => {
    const testStartMs = Date.now();

    await setStubScenario(
      { nonce: 'tampered-value-XYZ' },
      { baseUrl: STUB_BASE_URL },
    );

    const res = await initiateOktaSignin(request, BASE_URL, { maxRedirects: 10 });
    expect(res.url()).toContain('/auth/error');

    // fix-sso-e2e-remaining-5 TASK-4: poll bumped 3s → 10s for the same
    // microtask-vs-cold-start-compile reason documented at TC-E2E-09.
    const rows = await waitForReplayRow(testStartMs - 1_000, 10_000);
    // Exactly one row — proves the logger.error hook is idempotent and
    // not invoked twice (e.g. by Auth.js middleware retry).
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.outcome).toBe('rejected-replay');
    // email_hash filter is already in queryReplayRowsSince's WHERE clause;
    // assert iss sentinel (not filtered in the query) as the discriminating
    // signal that the writer used the correct sentinel set.
    expect(row.iss).toBe(REPLAY_ISS_SENTINEL);
    // Defense-in-depth: re-assert email_hash sentinel even though the
    // WHERE clause already filters on it — locks against a future
    // probe refactor that drops the filter.
    expect(row.email_hash).toBe(REPLAY_EMAIL_HASH_SENTINEL);
  });

  test('TC-E2E-04: audit row from the nonce-rejected callback contains NO substring of the actual NextAuth-generated nonce that Auth.js validated against (privacy)', async ({
    request,
  }) => {
    // Single-flow design — set the tampered scenario BEFORE initiating
    // signin so the SAME flow produces both the captured nonce AND the
    // failed callback. The previous two-flow design captured nonce A
    // and asserted absence in the audit row for flow B's nonce —
    // vacuous because flow A's nonce was never persisted anyway.
    const testStartMs = Date.now();

    await setStubScenario(
      { nonce: 'tampered-single-flow-XYZ' },
      { baseUrl: STUB_BASE_URL },
    );

    // Step 1: capture the nonce Auth.js generates for THIS flow (via
    // maxRedirects:0 so we can read the Location header before
    // following). NextAuth has already sealed this nonce into a cookie
    // that the followed request will carry through to the callback.
    const signinRes = await initiateOktaSignin(request, BASE_URL, { maxRedirects: 0 });
    const location = signinRes.headers().location ?? '';
    const generatedNonce = new URL(location).searchParams.get('nonce') ?? '';
    expect(generatedNonce.length).toBeGreaterThan(16);

    // Step 2: follow the same flow's redirect chain manually — the
    // Playwright request context preserves the cookie jar across
    // calls, so the nonce cookie set on signinRes propagates to the
    // callback. The tampered scenario.nonce wins over the
    // /authorize-recorded nonce (TC-U-07 / TC-I-02), so the id_token's
    // claim disagrees with the cookie → InvalidCheck → audit row.
    const followRes = await request.get(location, { maxRedirects: 10 });
    expect(followRes.url()).toContain('/auth/error');

    // Step 3: assert the audit row never persisted the captured nonce.
    // fix-sso-e2e-remaining-5 TASK-4: 10s poll (microtask-vs-cold-start).
    const rows = await waitForReplayRow(testStartMs - 1_000, 10_000);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0];
    const blob = [
      row.outcome,
      row.email_hash,
      row.iss,
      row.sso_provider,
      row.ip ?? '',
      row.city ?? '',
      row.user_agent ?? '',
    ].join('|');
    expect(blob).not.toContain(generatedNonce);
    expect(blob).not.toContain(generatedNonce.slice(0, 16));
  });
});
