/**
 * auth-bypass smoke spec — proves the e2e Credentials bypass works
 * end-to-end (TC-E2E-01 admin happy path, TC-E2E-02 role-gate enforcement).
 *
 * See `.specs/fix-e2e-auth-bypass.md` Design — this spec exists to detect
 * regressions if NextAuth v5 internals shift and the bypass stops minting
 * a valid session cookie.
 */
import { test, expect } from '@playwright/test';
import { signInAs } from './helpers/sign-in-as';

const BASE_URL = 'http://localhost:3232';

test.describe('e2e auth bypass (TASK-SMOKE)', () => {
  test.skip(
    process.env.SKIP_PG_TESTS === '1',
    'SKIP_PG_TESTS=1 — testcontainer Postgres unavailable, skipping E2E',
  );

  test('TC-E2E-01: alice (admin) signs in and reaches /manager', async ({ page, context }) => {
    await signInAs(context, { email: 'alice@alpha.test' });
    await page.goto(`${BASE_URL}/manager`);
    await expect(page).toHaveURL(/\/manager(\b|\/)/);
    // Strict assertion: the /manager landing renders an <h1>Overview</h1>
    // (see `app/manager/page.tsx`). Loading skeletons or sign-in redirects
    // would not satisfy the role+name pair, so this fails on regression.
    await expect(
      page.getByRole('heading', { level: 1, name: /Overview/i }),
    ).toBeVisible();
  });

  test('TC-E2E-02: bob (member) hits /manager/effectiveness and gets a 403 (role gate)', async ({ page, context }) => {
    await signInAs(context, { email: 'bob@alpha.test' });
    const response = await page.goto(`${BASE_URL}/manager/effectiveness`);
    expect(response?.status()).toBe(403);
  });
});
