/**
 * Playwright spec for AUTH_REQUIRED=false localhost-only open-access mode.
 * Spec: `.specs/auth-optional-mode-and-sso-bugfixes.md` (TC-E2E-01).
 *
 * # Why this spec skips by default
 *
 * The shared `global-setup.ts` spawns a dev server with full SSO env
 * (`OKTA_ISSUER`, `E2E_AUTH_BYPASS=1`, etc.) — AUTH_REQUIRED is unset,
 * which means the fail-safe default (`true`) applies. The other E2E
 * specs depend on this SSO-enabled server.
 *
 * This spec needs the INVERSE: a server running with `AUTH_REQUIRED=false`
 * where the auth gate is bypassed entirely. Running both modes from the
 * same global-setup would require either (a) spawning two dev servers on
 * different ports, or (b) adding a second Playwright project with its own
 * globalSetup. Both are non-trivial.
 *
 * For the initial release we leave this spec in skip-by-default form,
 * documenting the test plan. The localhost-mode behavior IS validated:
 *
 *   - Unit: lib/auth/auth-required.test.ts (TC-U-01..17) — isAuthRequired
 *     polarity, isLocalhostHost allow-list, buildLocalDevSession shape.
 *   - Integration: tests/integration/auth-localhost-mode.test.ts (15 TCs).
 *   - Manual smoke: documented in `.specs/auth-optional-mode-and-sso-bugfixes.md`
 *     Execution Log (curl against dev server with AUTH_REQUIRED=false:
 *     Host=localhost → request reaches route, Host=evil.example.com → 403).
 *
 * # How to run this spec manually
 *
 * 1. Spawn a dev server with `AUTH_REQUIRED=false` in env:
 *
 *      cd apps/server
 *      AUTH_REQUIRED=false \
 *      DATABASE_URL=<real postgres uri> \
 *      AUTH_SECRET=dev-secret \
 *      ONBOARDING_EMAIL_HASH_PEPPER=dev \
 *      INTERNAL_CRON_SECRET=dev \
 *      pnpm dev
 *
 * 2. In a separate shell:
 *
 *      LOCALHOST_MODE_E2E=1 pnpm exec playwright test \
 *        tests/e2e/auth-localhost-mode.spec.ts
 *
 * The `LOCALHOST_MODE_E2E=1` gate prevents this spec from accidentally
 * running against the default SSO-enabled global-setup, which would
 * produce confusing failures (signin-redirect-to-Okta vs expected
 * direct-render).
 */
import { test, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:3232';

test.describe('AUTH_REQUIRED=false localhost-only mode', () => {
  test.skip(
    process.env.LOCALHOST_MODE_E2E !== '1',
    'Set LOCALHOST_MODE_E2E=1 AND spawn the dev server with AUTH_REQUIRED=false separately. See file header for instructions.',
  );

  test('TC-E2E-01: /manager/teams renders without signin redirect', async ({
    page,
  }) => {
    const response = await page.goto(`${BASE_URL}/manager/teams`);
    // No signin redirect — open access.
    expect(page.url()).toBe(`${BASE_URL}/manager/teams`);
    expect(response?.status()).toBeLessThan(400);
  });

  test('TC-E2E-01b: /me/dashboard renders without signin redirect', async ({
    page,
  }) => {
    const response = await page.goto(`${BASE_URL}/me/dashboard`);
    expect(page.url()).toBe(`${BASE_URL}/me/dashboard`);
    expect(response?.status()).toBeLessThan(400);
  });

  test('TC-E2E-01c: non-localhost Host header → 403 localhost-only', async ({
    request,
  }) => {
    // Using the request fixture (not page.goto, which uses the browser's
    // own Host header) so we can spoof the Host explicitly. The middleware
    // localhost-host guard fires on the raw Host header.
    const response = await request.get(`${BASE_URL}/manager/teams`, {
      headers: { Host: 'evil.example.com' },
    });
    expect(response.status()).toBe(403);
    const body = await response.json();
    // security-hardening-lowsev (REQ-3): error body follows the
    // `{error:{message,code}}` shape from .claude/rules/security.md
    // (was a bare `{error:'forbidden',code:'localhost-only'}`).
    expect(body).toMatchObject({
      error: { message: 'forbidden', code: 'localhost-only' },
    });
  });

  test('TC-E2E-01d: X-Forwarded-Host is NOT honored — spoofed via XFH still blocked', async ({
    request,
  }) => {
    // With AUTH_REQUIRED=false, ONLY the raw Host header is checked.
    // An attacker who controls X-Forwarded-Host cannot bypass.
    const response = await request.get(`${BASE_URL}/manager/teams`, {
      headers: {
        Host: '192.168.1.100',
        'X-Forwarded-Host': 'localhost',
      },
    });
    expect(response.status()).toBe(403);
  });
});
