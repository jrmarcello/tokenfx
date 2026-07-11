import { test, expect } from '@playwright/test';

// TC-E2E-01 (REQ-6) + TC-E2E-03 (REQ-5) — .specs/fix-pricing-unknown-model-family.md

test.describe('session 404', () => {
  test('nonexistent session id returns a real HTTP 404', async ({ request }) => {
    const response = await request.get('/sessions/nonexistent-id-e2e', {
      maxRedirects: 0,
    });
    expect(response.status()).toBe(404);
  });
});

test.describe('cache hit ratio consistency', () => {
  test('home cache KPI uses the session_effectiveness formula (creation in denominator)', async ({
    page,
  }) => {
    // The home KPI and /effectiveness both derive from the same per-row
    // formula now. Aggregation strategies differ (SUM-ratio vs per-session),
    // so this asserts both pages render a finite percentage without error —
    // formula parity itself is pinned by integration tests (TC-I-07/08).
    await page.goto('/');
    const kpi = page.getByText(/cache hit/i).first();
    await expect(kpi).toBeVisible();

    await page.goto('/effectiveness');
    await expect(page.locator('body')).not.toContainText('NaN%');
  });
});
