/**
 * machine-revocation smoke spec — admin lists + revokes machine credentials
 * at /manager/admin/machines, and the admin-only gate blocks a manager.
 * Spec: .specs/machine-revocation-ui.md (TC-E2E-01/02/03).
 *
 * Uses the shared e2e Credentials bypass (`signInAs`) + testcontainer Postgres
 * seeded by global-setup. Skipped when the container is unavailable.
 */
import { test, expect } from '@playwright/test';
import { signInAs } from './helpers/sign-in-as';

const BASE_URL = 'http://localhost:3232';

test.describe('machine revocation (TASK-SMOKE)', () => {
  test.skip(
    process.env.SKIP_PG_TESTS === '1',
    'SKIP_PG_TESTS=1 — testcontainer Postgres unavailable, skipping E2E',
  );

  test('TC-E2E-01: admin sees the machines list with prefixes only (no full key_id)', async ({
    page,
    context,
  }) => {
    await signInAs(context, { email: 'alice@alpha.test' });
    const response = await page.goto(`${BASE_URL}/manager/admin/machines`);
    expect(response?.status()).toBeLessThan(400);
    await expect(
      page.getByRole('heading', { level: 1, name: /Machines/i }),
    ).toBeVisible();
    // The full key_id (k_ + 16 hex) must never appear in the DOM — only the
    // 8-char prefix. Assert no 18-char k_ token is rendered.
    const html = await page.content();
    expect(html).not.toMatch(/k_[0-9a-f]{16}/);
  });

  test('TC-E2E-02: admin revokes an active machine and the row flips to revoked', async ({
    page,
    context,
  }) => {
    await signInAs(context, { email: 'alice@alpha.test' });
    await page.goto(`${BASE_URL}/manager/admin/machines`);
    const revokeButton = page.getByRole('button', { name: /Revoke/i }).first();
    // The e2e seed MUST provide at least one active machine in Alpha for this
    // test to be meaningful — fail loudly (not silently skip) if it stops.
    await expect(revokeButton).toBeVisible();
    await revokeButton.click();
    await expect(page.getByText(/revoked/i).first()).toBeVisible();
  });

  test('TC-E2E-03: a manager is blocked from /manager/admin/machines (admin-only gate)', async ({
    page,
    context,
  }) => {
    await signInAs(context, { email: 'paula@alpha.test' });
    const response = await page.goto(`${BASE_URL}/manager/admin/machines`);
    expect(response?.status()).toBe(403);
  });
});
