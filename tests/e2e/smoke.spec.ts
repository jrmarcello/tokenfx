import { test, expect } from '@playwright/test';

test.describe('smoke', () => {
  test('TC-E2E-01: home page loads with KPIs and data', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Visão geral' })).toBeVisible();
    await expect(page.getByText('Custo total (30d)')).toBeVisible();
    await expect(page.getByText('Tokens (30d)')).toBeVisible();
    await expect(page.getByText('Taxa de cache hit')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Sessões mais caras' }),
    ).toBeVisible();
  });

  test('TC-E2E-02: drill-down shows transcript of a session', async ({ page }) => {
    await page.goto('/sessions/e2e-1');
    await expect(
      page.getByRole('heading', { level: 1, name: 'e2e-project-alpha' })
    ).toBeVisible();
    // Session id is rendered in the <p> under the heading (exact match to avoid
    // colliding with prompt text that also contains "e2e-1").
    await expect(page.getByText('e2e-1', { exact: true })).toBeVisible();
    await expect(page.getByText(/First user prompt for e2e-1/)).toBeVisible();
  });

  test('TC-E2E-04: /effectiveness shows model breakdown section with mixed families', async ({ page }) => {
    await page.goto('/effectiveness');
    await expect(
      page.getByRole('heading', { name: 'Distribuição de spend por modelo' }),
    ).toBeVisible();
    // Seed covers opus + sonnet + haiku; at least two family labels should appear.
    const families = page.getByText(/^(opus|sonnet|haiku)$/);
    await expect(families.first()).toBeVisible();
    expect(await families.count()).toBeGreaterThanOrEqual(2);
  });

  test('TC-E2E-03: rating a turn updates immediately', async ({ page }) => {
    // Warm the Next dev compiler for /api/ratings so the first user click isn't
    // racing the initial compile (cold starts can exceed expect timeouts).
    const warm = await page.request.post('/api/ratings', {
      data: { turnId: 'e2e-1-t2', rating: 0 },
    });
    expect(warm.ok()).toBeTruthy();

    await page.goto('/sessions/e2e-1');
    const goodButton = page.getByRole('button', { name: 'Bom' }).first();

    // Wait for the POST to resolve so the test doesn't race the fetch.
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/ratings') && r.request().method() === 'POST',
        { timeout: 15_000 }
      ),
      goodButton.click(),
    ]);
    expect(response.ok()).toBeTruthy();

    // Optimistic UI: emerald class is applied immediately on click.
    await expect(goodButton).toHaveClass(/emerald/);

    // Persistence: reload and confirm the rating survived.
    await page.reload();
    const afterReload = page.getByRole('button', { name: 'Bom' }).first();
    await expect(afterReload).toHaveClass(/emerald/);
  });
});
