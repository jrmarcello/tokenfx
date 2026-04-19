import { test, expect } from '@playwright/test';

test.describe('session share', () => {
  test('TC-E2E-01: session page renders 3 share buttons with aria-labels', async ({
    page,
  }) => {
    await page.goto('/sessions/e2e-1');
    await expect(
      page.getByRole('heading', { level: 1, name: 'e2e-project-alpha' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Copiar markdown' }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Baixar markdown' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Imprimir como PDF' }),
    ).toBeVisible();
  });

  test('TC-E2E-02: clicking "Copiar markdown" writes markdown to clipboard', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/sessions/e2e-1');
    await page.getByRole('button', { name: 'Copiar markdown' }).click();
    await expect(page.getByText('Copiado!')).toBeVisible();
    const clipboardText = await page.evaluate(() =>
      navigator.clipboard.readText(),
    );
    expect(clipboardText.startsWith('# Sessão:')).toBe(true);
  });

  test('TC-E2E-03: clicking "Baixar markdown" triggers a .md download with expected filename', async ({
    page,
  }) => {
    await page.goto('/sessions/e2e-1');
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Baixar markdown' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(
      /^tokenfx-session-.+-\d{8}\.md$/,
    );
  });

  test('TC-E2E-04: @media print hides ShareActions and RatingWidget', async ({
    page,
  }) => {
    await page.goto('/sessions/e2e-1');
    const shareActions = page
      .locator('[aria-label="Compartilhar"]')
      .first();
    await expect(shareActions).toBeVisible();
    await page.emulateMedia({ media: 'print' });
    await expect(shareActions).toBeHidden();
    const ratingLabel = page.getByText('Avaliação:').first();
    await expect(ratingLabel).toBeHidden();
  });

  test('TC-E2E-05: clicking "Imprimir como PDF" invokes window.print exactly once', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      (window as unknown as { __printCalls: number }).__printCalls = 0;
      window.print = () => {
        (window as unknown as { __printCalls: number }).__printCalls += 1;
      };
    });
    await page.goto('/sessions/e2e-1');
    await page.getByRole('button', { name: 'Imprimir como PDF' }).click();
    const calls = await page.evaluate(
      () => (window as unknown as { __printCalls: number }).__printCalls,
    );
    expect(calls).toBe(1);
  });

  test('TC-E2E-06: copy error state shown when clipboard rejects', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: () => Promise.reject(new Error('denied')),
        },
      });
    });
    await page.goto('/sessions/e2e-1');
    await page.getByRole('button', { name: 'Copiar markdown' }).click();
    await expect(page.getByText('Falha ao copiar')).toBeVisible();
  });
});
