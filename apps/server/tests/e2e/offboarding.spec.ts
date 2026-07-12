/**
 * offboarding smoke spec — admin offboards a dev at /manager/admin/users, and
 * a manager is blocked from the admin route.
 * Spec: .specs/data-retention-policy.md (TC-E2E-01, TC-E2E-02).
 *
 * Uses the shared e2e Credentials bypass (`signInAs`) + testcontainer Postgres.
 * Skipped when the container is unavailable.
 */
import { test, expect } from '@playwright/test';
import { signInAs } from './helpers/sign-in-as';

const BASE_URL = 'http://localhost:3232';

test.describe('offboarding (TASK-SMOKE)', () => {
  test.skip(
    process.env.SKIP_PG_TESTS === '1',
    'SKIP_PG_TESTS=1 — testcontainer Postgres unavailable, skipping E2E',
  );

  test('TC-E2E-01: admin offboards a dev and the row shows departed (no old email)', async ({
    page,
    context,
  }) => {
    await signInAs(context, { email: 'alice@alpha.test' });
    await page.goto(`${BASE_URL}/manager/admin/users`);
    await expect(page.getByRole('heading', { level: 1, name: /Users/i })).toBeVisible();
    // Auto-accept the window.confirm on the irreversible action.
    page.on('dialog', (d) => d.accept());
    const offboard = page.getByRole('button', { name: /Offboard/i }).first();
    // Fail loudly if the seed/UI stops rendering an offboardable dev.
    await expect(offboard).toBeVisible();
    await offboard.click();
    await expect(page.getByText(/departed/i).first()).toBeVisible();
    // The full old corporate email of the offboarded dev must be gone.
    expect(await page.content()).not.toMatch(/bob@alpha\.test/);
  });

  test('TC-E2E-02: a manager is blocked from /manager/admin/users (admin-only gate)', async ({
    page,
    context,
  }) => {
    await signInAs(context, { email: 'paula@alpha.test' });
    const response = await page.goto(`${BASE_URL}/manager/admin/users`);
    expect(response?.status()).toBe(403);
  });
});
