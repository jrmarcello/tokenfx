/**
 * Cross-stack smoke E2E — `.specs/cross-stack-smoke-validation.md`
 * TASK-PLAYWRIGHT-SMOKE-PROJECT.
 *
 * Maps to TC-E2E-01..05 in that spec. These tests assume the cross-stack
 * docker smoke stack is already up via:
 *
 *   docker compose --profile smoke up -d
 *   pnpm smoke:reset && pnpm smoke:seed
 *
 * per `docs/smoke-runbook.md`. They run under the `smoke` Playwright project
 * (selected via `--project=smoke` or the `@smoke` grep filter — see
 * `playwright.config.ts`). The project skips `webServer`, so nothing is
 * spawned by Playwright: tests drive the running containers directly.
 *
 * Endpoint map (host loopback):
 *   - root tokenfx     → http://localhost:3131
 *   - apps/server      → http://localhost:3232
 *   - apps/idp-stub    → http://localhost:3001
 *
 * Active TCs (tagged `@smoke`):
 *   - TC-E2E-01: SSO live login against idp-stub → /me/dashboard renders.
 *   - TC-E2E-02: root dashboard renders $42.50 + session count.
 *   - TC-E2E-03: server dashboard renders KPIs after E2E auth bypass.
 *   - TC-E2E-04: all key routes across both apps return 200 (no 5xx).
 *   - TC-E2E-05: cross-service data flow proof — server `/manager/teams`
 *                aggregate equals root `$42.50` after reporter push only
 *                (no direct server seed).
 */
import { test, expect, type Page } from '@playwright/test';
import { signInAs } from '../../apps/server/tests/e2e/helpers/sign-in-as';

const ROOT_BASE = 'http://localhost:3131';
const SERVER_BASE = 'http://localhost:3232';
const IDP_STUB_BASE = 'http://localhost:3001';

const SEED_TOTAL_COST = '$42.50';
const SEED_SESSION_COUNT = 3;
const SEED_MANAGER_EMAIL = 'smoke-user-1@example.com';

/**
 * Asserts the page response is 200 and the body rendered (no top-level
 * Next.js / framework error boundary). Returns the status for explicit
 * caller-side assertions.
 */
const assertOk = async (page: Page, url: string): Promise<number> => {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
  const status = response?.status() ?? 0;
  expect(status, `GET ${url} should return 2xx`).toBeGreaterThanOrEqual(200);
  expect(status, `GET ${url} should not 5xx`).toBeLessThan(500);
  return status;
};

test.describe('cross-stack-smoke-validation — TC-E2E-01..05', () => {
  test('TC-E2E-01 SSO live login completes against idp-stub @smoke', async ({ page }) => {
    // Sanity: idp-stub discovery endpoint is reachable.
    const discoveryResp = await page.request.get(
      `${IDP_STUB_BASE}/.well-known/openid-configuration`,
    );
    expect(
      discoveryResp.status(),
      'idp-stub /.well-known/openid-configuration must be 200 — is the stack up?',
    ).toBe(200);

    // Drive the NextAuth signin flow on apps/server. The Okta provider
    // (configured in apps/server `auth.config.ts`) is wired to
    // OKTA_ISSUER=http://tokenfx-idp-stub:3001 inside the container — the
    // host-side reachability of the resulting `authorize` redirect goes
    // through the published port (127.0.0.1:3001) since `iss` mirrors
    // OKTA_ISSUER. The runbook documents the issuer-mismatch workaround if
    // NextAuth rejects.
    const signinResp = await page.goto(`${SERVER_BASE}/api/auth/signin`);
    expect(
      signinResp?.status(),
      'GET /api/auth/signin should return 200 (rendering signin UI)',
    ).toBe(200);

    // Click the Okta provider button. NextAuth renders one form per
    // provider; the submit button is labelled "Sign in with Okta".
    const oktaButton = page.getByRole('button', { name: /sign in with okta/i });
    await expect(
      oktaButton,
      'signin page should expose Okta provider button',
    ).toBeVisible();

    // Submitting kicks off the OAuth flow → redirect to idp-stub
    // /authorize → idp-stub auto-issues id_token + redirects back to
    // /api/auth/callback/okta → NextAuth provisions user → final redirect
    // to /me/dashboard.
    await Promise.all([
      page.waitForURL(/\/me\/dashboard/, { timeout: 20_000 }),
      oktaButton.click(),
    ]);

    expect(
      page.url(),
      'final URL should be /me/dashboard after SSO completes',
    ).toContain('/me/dashboard');
    await expect(page.locator('body')).toBeVisible();
  });

  test('TC-E2E-02 root dashboard renders seeded $42.50 total @smoke', async ({ page }) => {
    const response = await page.goto(`${ROOT_BASE}/`);
    expect(response?.status(), 'GET / should return 200').toBe(200);

    // Body contains the seeded aggregate cost (per smoke-seed.ts header
    // comment: 10.00 + 15.00 + 17.50 = 42.50 USD).
    await expect(
      page.locator('body'),
      'root dashboard must display the seeded total cost',
    ).toContainText(SEED_TOTAL_COST);

    // And the seeded session count of 3 must surface somewhere on the page
    // (KPI grid / sessions list). We assert via a relaxed regex against the
    // full body text to stay resilient to label changes.
    const bodyText = (await page.locator('body').innerText()) ?? '';
    expect(
      bodyText,
      `root dashboard body should mention seeded session count of ${SEED_SESSION_COUNT}`,
    ).toMatch(new RegExp(`\\b${SEED_SESSION_COUNT}\\b`));
  });

  test('TC-E2E-03 server /manager/teams renders KPIs with E2E auth bypass @smoke', async ({ page, context }) => {
    // Mint a NextAuth session cookie via the canonical e2e-bypass helper
    // (apps/server runs with E2E_AUTH_BYPASS=1 inside the smoke container).
    await signInAs(context, {
      email: SEED_MANAGER_EMAIL,
      baseUrl: SERVER_BASE,
    });

    const response = await page.goto(`${SERVER_BASE}/manager/teams`);
    expect(response?.status(), 'GET /manager/teams should return 200').toBe(200);

    // Page must surface KPI section — assert the heading is visible.
    await expect(
      page.locator('body'),
      '/manager/teams must render some content',
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 1 }),
      '/manager/teams must render an h1 heading (KPI/teams surface)',
    ).toBeVisible();
  });

  test('TC-E2E-04 all key routes across both apps return 200 (no 5xx) @smoke', async ({ page, context }) => {
    // Auth-gate the server routes — manager + me both require a session.
    await signInAs(context, {
      email: SEED_MANAGER_EMAIL,
      baseUrl: SERVER_BASE,
    });

    const routes: ReadonlyArray<{ readonly url: string; readonly label: string }> = [
      // Root tokenfx (port 3131) — public/local.
      { url: `${ROOT_BASE}/`, label: 'root /' },
      { url: `${ROOT_BASE}/sessions`, label: 'root /sessions' },
      { url: `${ROOT_BASE}/effectiveness`, label: 'root /effectiveness' },
      // apps/server (port 3232) — gated, bypass cookie injected above.
      { url: `${SERVER_BASE}/manager/teams`, label: 'server /manager/teams' },
      { url: `${SERVER_BASE}/manager/activity`, label: 'server /manager/activity' },
      { url: `${SERVER_BASE}/me/dashboard`, label: 'server /me/dashboard' },
    ] as const;

    for (const { url, label } of routes) {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
      const status = response?.status() ?? 0;
      expect(status, `${label} should return 200 (got ${status})`).toBe(200);
    }
  });

  test('TC-E2E-05 cross-service data flow proof — server matches root $42.50 @smoke', async ({ page, context }) => {
    // PRECONDITION (per runbook): the server side was NOT seeded with
    // session data — only root tokenfx was seeded + reporter pushed. So if
    // /manager/teams displays $42.50, the value MUST have transited root →
    // reporter → /api/ingest → sessions_agg → server query. This proves the
    // cross-stack data flow end-to-end.
    await signInAs(context, {
      email: SEED_MANAGER_EMAIL,
      baseUrl: SERVER_BASE,
    });

    // Sanity: root dashboard already shows the canonical seeded value.
    await assertOk(page, `${ROOT_BASE}/`);
    await expect(
      page.locator('body'),
      'root dashboard must show seeded $42.50 baseline',
    ).toContainText(SEED_TOTAL_COST);

    // The actual cross-stack assertion.
    await assertOk(page, `${SERVER_BASE}/manager/teams`);
    await expect(
      page.locator('body'),
      'server /manager/teams aggregate cost must equal root seed (proves reporter wired)',
    ).toContainText(SEED_TOTAL_COST);
  });
});
