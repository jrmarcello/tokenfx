import { test, expect } from '@playwright/test';

const DAY_MS = 86_400_000;

/**
 * Returns the local-date ISO (YYYY-MM-DD) of `N` days ago. Matches the
 * `strftime('%Y-%m-%d', started_at/1000, 'unixepoch', 'localtime')`
 * bucket used by the `listSessionsByDate` SQL window.
 */
function localDateDaysAgo(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * DAY_MS);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

test.describe('sessions pagination', () => {
  // TC-E2E-01: page 1 controls visible
  test('TC-E2E-01: /sessions renders page 1 with Próxima enabled and Anterior disabled', async ({
    page,
  }) => {
    await page.goto('/sessions');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Sessões' }),
    ).toBeVisible();

    // Subtitle contains "sessões · exibindo 1–25"
    await expect(page.locator('header p')).toContainText('sessões');
    await expect(page.locator('header p')).toContainText('exibindo 1');

    // Pagination nav present
    const nav = page.getByRole('navigation', { name: 'Paginação' });
    await expect(nav).toBeVisible();

    // Next is a <Link> (role="link")
    const next = nav.getByRole('link', { name: 'Próxima página' });
    await expect(next).toBeVisible();

    // Prev is disabled span (aria-disabled="true" — not role="link")
    const prevDisabled = nav.locator('[aria-label="Página anterior"]');
    await expect(prevDisabled).toHaveAttribute('aria-disabled', 'true');
  });

  // TC-E2E-02: clicking Next navigates to offset=25
  test('TC-E2E-02: clicking "Próxima" advances to offset=25', async ({
    page,
  }) => {
    await page.goto('/sessions');
    const nav = page.getByRole('navigation', { name: 'Paginação' });
    const next = nav.getByRole('link', { name: 'Próxima página' });
    await next.click();

    await expect(page).toHaveURL(/\/sessions\?offset=25/);
    await expect(page.locator('header p')).toContainText('exibindo 26');

    // Prev now enabled (a <Link>)
    const nav2 = page.getByRole('navigation', { name: 'Paginação' });
    await expect(
      nav2.getByRole('link', { name: 'Página anterior' }),
    ).toBeVisible();
  });

  // TC-E2E-03: date filter with a single-session day (e2e-today = daysAgo=0 has 1)
  test('TC-E2E-03: date filter with ≤25 sessions hides pagination nav', async ({
    page,
  }) => {
    const today = localDateDaysAgo(0);
    await page.goto(`/sessions?date=${today}`);

    // Expect the filtered label
    await expect(page.locator('header p')).toContainText(today);

    // No pagination nav
    await expect(
      page.getByRole('navigation', { name: 'Paginação' }),
    ).toHaveCount(0);
  });

  // TC-E2E-04: negative offset clamps silently
  test('TC-E2E-04: ?offset=-1 clamps to first page', async ({ page }) => {
    await page.goto('/sessions?offset=-1');
    // Renders page 1 — "exibindo 1" should appear
    await expect(page.locator('header p')).toContainText('exibindo 1');
  });

  // TC-E2E-05: offset past total shows overflow CTA
  test('TC-E2E-05: ?offset=9999 shows "Voltar pra primeira página" CTA', async ({
    page,
  }) => {
    await page.goto('/sessions?offset=9999');
    await expect(page.getByText('Sem sessões nesta página')).toBeVisible();
    const backLink = page.getByRole('link', {
      name: /Voltar pra primeira página/i,
    });
    await expect(backLink).toBeVisible();
    await expect(backLink).toHaveAttribute('href', '/sessions');
  });

  // TC-E2E-06: date + offset preserved on Next
  test('TC-E2E-06: date filter paginates, preserving date on Next', async ({
    page,
  }) => {
    // Seed populated `daysAgo=10` with 31 sessions. Compute that local date.
    const dayFull = localDateDaysAgo(10);
    await page.goto(`/sessions?date=${dayFull}`);

    // Expect subtitle mentions that date + a count >= 26
    await expect(page.locator('header p')).toContainText(dayFull);

    const nav = page.getByRole('navigation', { name: 'Paginação' });
    const next = nav.getByRole('link', { name: 'Próxima página' });
    await next.click();

    await expect(page).toHaveURL(
      new RegExp(`\\?date=${dayFull}&offset=25`),
    );

    const prev = page
      .getByRole('navigation', { name: 'Paginação' })
      .getByRole('link', { name: 'Página anterior' });
    const prevHref = await prev.getAttribute('href');
    expect(prevHref).toContain(`date=${dayFull}`);
  });

  // TC-E2E-07: aria-labels present on enabled + disabled
  test('TC-E2E-07: aria-labels present on Prev (disabled) and Next (enabled)', async ({
    page,
  }) => {
    await page.goto('/sessions');
    const nav = page.getByRole('navigation', { name: 'Paginação' });

    const next = nav.getByRole('link', { name: 'Próxima página' });
    await expect(next).toHaveAttribute('aria-label', 'Próxima página');

    const prev = nav.locator('[aria-label="Página anterior"]');
    await expect(prev).toHaveAttribute('aria-disabled', 'true');
  });
});
