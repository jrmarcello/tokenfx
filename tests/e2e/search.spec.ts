import { test, expect } from '@playwright/test';

test.describe('transcript search', () => {
  test('TC-E2E-01: /search with query returns hit linked to session', async ({
    page,
  }) => {
    await page.goto('/search?q=auth-marker');
    await expect(
      page.getByRole('heading', { name: 'Busca' }),
    ).toBeVisible();
    // Scope by accessible name — there are now two searchboxes on the page
    // (header widget + page form) so a bare `getByRole('searchbox')` is
    // ambiguous. The form input gets its name from the <label>Consulta</label>
    // wrapper; the widget uses aria-label="Buscar no transcript".
    await expect(
      page.getByRole('searchbox', { name: 'Consulta' }),
    ).toHaveValue('auth-marker');
    // The seed for e2e-1 contains "auth-marker" in both prompt and response.
    const hitLink = page.getByRole('link', { name: /auth-marker/i }).first();
    await expect(hitLink).toBeVisible();
    await expect(hitLink).toHaveAttribute(
      'href',
      /\/sessions\/e2e-1#turn-e2e-1-t1/,
    );
  });

  test('TC-E2E-02: /search without query shows empty-state message', async ({
    page,
  }) => {
    await page.goto('/search');
    await expect(page.getByRole('heading', { name: 'Busca' })).toBeVisible();
    await expect(
      page.getByRole('searchbox', { name: 'Consulta' }),
    ).toHaveValue('');
    await expect(
      page.getByText(/digite um termo/i),
    ).toBeVisible();
  });

  test('TC-E2E-03: clicking a hit navigates and highlights the target turn', async ({
    page,
  }) => {
    await page.goto('/search?q=auth-marker');
    const hitLink = page.getByRole('link', { name: /auth-marker/i }).first();
    await hitLink.click();
    await page.waitForURL(/\/sessions\/e2e-1#turn-e2e-1-t1/);
    const turn = page.locator('#turn-e2e-1-t1');
    await expect(turn).toBeVisible();
    // The TurnScrollTo client component adds ring-* classes for ~2s.
    await expect(turn).toHaveClass(/ring-amber-400/);
  });
});
