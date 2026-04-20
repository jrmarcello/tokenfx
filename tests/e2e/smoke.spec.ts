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

  test('TC-E2E-08: home page shows mixed cost-source badge on Custo total KPI', async ({ page }) => {
    await page.goto('/');
    // Seed has e2e-today with OTEL cost + others with local only → mixed.
    const badge = page
      .locator('[role="img"][aria-label*="sessões"]')
      .first();
    await expect(badge).toBeVisible();
  });

  test('TC-E2E-09: session detail page shows OTEL badge for e2e-today', async ({ page }) => {
    await page.goto('/sessions/e2e-today');
    await expect(
      page.getByRole('img', { name: 'Custo via OTEL' }),
    ).toBeVisible();
    // Divergence hint — local cost line appears since OTEL differs from local.
    await expect(page.getByText(/estimado local/)).toBeVisible();
  });

  test('TC-E2E-10: session without OTEL shows calibrated badge on /sessions', async ({ page }) => {
    await page.goto('/sessions');
    // At least one row should carry the amber "calibrated" badge (the e2e-1
    // session has no OTEL but the seed populates cost_calibration.global).
    await expect(
      page.locator('[aria-label="Custo calibrado"]').first(),
    ).toBeVisible();
  });

  // TC-E2E-11 (legacy "Fonte dos custos" heading em /effectiveness) removido
  // — CostSourcesBreakdown foi consolidado no tooltip do KPI Custo na home
  // (spec unified-dashboard, REQ-17). TC-E2E-18 da unified-dashboard.spec.ts
  // cobre a nova assertion.

test('TC-E2E-05: home page renders activity heatmap with at least one non-empty cell', async ({ page }) => {
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Atividade do último ano' }),
    ).toBeVisible();
    // Seed contains a session "today" (daysAgo: 0) → at least one cell with spend > 0.
    const allCells = page.locator('rect[data-date][data-spend]');
    const total = await allCells.count();
    expect(total).toBeGreaterThan(0);
    let nonZero = 0;
    for (let i = 0; i < total; i++) {
      const spend = await allCells.nth(i).getAttribute('data-spend');
      if (spend && Number(spend) > 0) nonZero++;
    }
    expect(nonZero).toBeGreaterThan(0);
  });

  test('TC-E2E-06: clicking a heatmap cell navigates to filtered /sessions', async ({ page }) => {
    await page.goto('/');
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const d = String(today.getDate()).padStart(2, '0');
    const iso = `${y}-${m}-${d}`;
    const todayCell = page.locator(`rect[data-date="${iso}"]`);
    await expect(todayCell).toHaveCount(1);
    await todayCell.click();
    await expect(page).toHaveURL(new RegExp(`/sessions\\?date=${iso}$`));
    // The /sessions date-filter summary reads "N encontrada(s) em YYYY-MM-DD".
    await expect(
      page.getByText(new RegExp(`encontrada[s]? em ${iso}`)),
    ).toBeVisible();
    await expect(page.getByText('e2e-project-today')).toBeVisible();
  });

  test('TC-E2E-07: /sessions?date=abc shows invalid banner + full list', async ({ page }) => {
    await page.goto('/sessions?date=abc');
    await expect(
      page.getByText(/Par.metro date inv.lido/i),
    ).toBeVisible();
    // Full list still renders — seed e2e-1..3 should all be visible.
    await expect(page.getByText('e2e-project-alpha')).toBeVisible();
  });

  test('TC-E2E-04: / shows model breakdown section with mixed families', async ({ page }) => {
    // /effectiveness foi consolidada em / (spec unified-dashboard). A seção
    // nova usa ModelBreakdownBar com heading "Custo por família de modelo".
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Custo por família de modelo' }),
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
