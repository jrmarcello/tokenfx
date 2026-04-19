import { test, expect } from '@playwright/test';

// Each test gets a fresh browser context from Playwright by default, so
// localStorage starts empty. No manual reset needed.

test.describe('themes', () => {
  test('TC-E2E-01: theme toggle opens dropdown with 3 labeled options', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Alterar tema' }).click();
    await expect(page.getByRole('menuitemradio', { name: 'Claro' })).toBeVisible();
    await expect(page.getByRole('menuitemradio', { name: 'Escuro' })).toBeVisible();
    await expect(
      page.getByRole('menuitemradio', { name: 'Sistema' }),
    ).toBeVisible();
  });

  test('TC-E2E-02: selecting "Escuro" applies class="dark" and persists', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Alterar tema' }).click();
    await page.getByRole('menuitemradio', { name: 'Escuro' }).click();
    await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/);
    const stored = await page.evaluate(() => localStorage.getItem('theme'));
    expect(stored).toBe('dark');
  });

  test('TC-E2E-03: selecting "Claro" removes class="dark"', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Alterar tema' }).click();
    await page.getByRole('menuitemradio', { name: 'Claro' }).click();
    await expect(page.locator('html')).not.toHaveClass(/(^|\s)dark(\s|$)/);
    const stored = await page.evaluate(() => localStorage.getItem('theme'));
    expect(stored).toBe('light');
  });

  test('TC-E2E-04: "Sistema" with prefers-color-scheme=dark applies .dark', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await page.getByRole('button', { name: 'Alterar tema' }).click();
    await page.getByRole('menuitemradio', { name: 'Sistema' }).click();
    await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/);
    const stored = await page.evaluate(() => localStorage.getItem('theme'));
    expect(stored).toBe('system');
  });

  test('TC-E2E-05: system mode follows OS preference changes live', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await page.getByRole('button', { name: 'Alterar tema' }).click();
    await page.getByRole('menuitemradio', { name: 'Sistema' }).click();
    await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).not.toHaveClass(/(^|\s)dark(\s|$)/);
  });

  test('TC-E2E-06: dark theme persists across reload without flash', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Alterar tema' }).click();
    await page.getByRole('menuitemradio', { name: 'Escuro' }).click();
    await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/);
    await page.reload();
    // Immediately after reload the class must be present: next-themes injects
    // a pre-paint script that reads localStorage and sets .dark before
    // hydration, so there's no flash of the opposite theme.
    await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/);
    const stored = await page.evaluate(() => localStorage.getItem('theme'));
    expect(stored).toBe('dark');
  });

  test('TC-E2E-07: light mode resolves --background CSS var to light value', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Alterar tema' }).click();
    await page.getByRole('menuitemradio', { name: 'Claro' }).click();
    const bg = await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue('--background')
        .trim()
        .toLowerCase(),
    );
    // globals.css :root → --background: #fafafa (neutral-50)
    expect(bg).toBe('#fafafa');
  });

  test('TC-E2E-08: dark mode resolves --background CSS var to dark value', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Alterar tema' }).click();
    await page.getByRole('menuitemradio', { name: 'Escuro' }).click();
    const bg = await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue('--background')
        .trim()
        .toLowerCase(),
    );
    // globals.css .dark → --background: #0a0a0a (neutral-950)
    expect(bg).toBe('#0a0a0a');
  });

  test('TC-E2E-09: Escape closes dropdown without changing theme', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Alterar tema' }).click();
    await page.getByRole('menuitemradio', { name: 'Escuro' }).click();
    await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/);
    await page.getByRole('button', { name: 'Alterar tema' }).click();
    await expect(
      page.getByRole('menuitemradio', { name: 'Claro' }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('menuitemradio', { name: 'Claro' }),
    ).toBeHidden();
    await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/);
  });

  test('TC-E2E-10: toggle exposes aria-label "Alterar tema"', async ({ page }) => {
    await page.goto('/');
    await expect(
      page.getByRole('button', { name: 'Alterar tema' }),
    ).toBeVisible();
  });

  test('TC-E2E-11: theme change in tab A propagates to tab B via storage event', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    try {
      const pageA = await context.newPage();
      const pageB = await context.newPage();
      await pageA.goto('/');
      await pageB.goto('/');
      await pageA.getByRole('button', { name: 'Alterar tema' }).click();
      await pageA.getByRole('menuitemradio', { name: 'Escuro' }).click();
      await expect(pageA.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/);
      // B should pick it up via the `storage` event next-themes listens to.
      await expect(pageB.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/, {
        timeout: 3000,
      });
    } finally {
      await context.close();
    }
  });
});
