import { test, expect, type Page } from '@playwright/test';

// Helper — set a threshold via the dialog flow (replaces the old form-based
// `seedUserSettings`). Uses the Save flow in QuotaTokenCard, so the settings
// persist through the Server Action → `revalidatePath` path the dev server
// sees.
async function seedThresholdViaDialog(
  page: Page,
  window: '5h' | '7d',
  value: number,
): Promise<void> {
  await page.goto('/quota');
  const card = page.getByRole('region', { name: `Tokens — janela ${window}` });
  await card
    .getByRole('button', {
      name: `Editar threshold Tokens — janela ${window}`,
    })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const input = dialog.getByRole('spinbutton', { name: 'Valor em tokens' });
  await input.fill(String(value));
  await dialog.getByRole('button', { name: 'Salvar' }).click();
  // Wait for dialog to close (success path).
  await expect(dialog).not.toBeVisible();
}

// Helper — clear all thresholds so next test starts from empty state.
async function resetThresholds(page: Page): Promise<void> {
  for (const win of ['5h', '7d'] as const) {
    await page.goto('/quota');
    const card = page.getByRole('region', {
      name: `Tokens — janela ${win}`,
    });
    const button = card.getByRole('button', {
      name: `Editar threshold Tokens — janela ${win}`,
    });
    await button.click();
    const dialog = page.getByRole('dialog');
    const input = dialog.getByRole('spinbutton', { name: 'Valor em tokens' });
    await input.fill('');
    await dialog.getByRole('button', { name: 'Salvar' }).click();
    await expect(dialog).not.toBeVisible();
  }
}

test.describe('quota improvements', () => {
  test.beforeEach(async ({ page }) => {
    await resetThresholds(page);
  });

  // ------------------------------ Layout ------------------------------

  test('TC-E2E-01: /quota seeded renders 2 cards side-by-side ≥md', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await seedThresholdViaDialog(page, '5h', 500_000);
    await page.goto('/quota');
    const card5h = page.getByRole('region', { name: 'Tokens — janela 5h' });
    const card7d = page.getByRole('region', { name: 'Tokens — janela 7d' });
    await expect(card5h).toBeVisible();
    await expect(card7d).toBeVisible();
    // Both cards sit on the same vertical offset (grid 2-col at ≥md).
    const box5h = await card5h.boundingBox();
    const box7d = await card7d.boundingBox();
    expect(box5h).not.toBeNull();
    expect(box7d).not.toBeNull();
    if (box5h && box7d) {
      expect(Math.abs(box5h.y - box7d.y)).toBeLessThan(8);
      expect(box7d.x).toBeGreaterThan(box5h.x);
    }
  });

  test('TC-E2E-02: /quota no longer has Thresholds form section', async ({
    page,
  }) => {
    await page.goto('/quota');
    await expect(
      page.getByRole('heading', { name: 'Thresholds' }),
    ).toHaveCount(0);
    // Zero labels for the session fields anywhere on the page.
    await expect(
      page.locator('body', { hasText: /Sessões — janela/ }),
    ).toHaveCount(0);
  });

  test('TC-E2E-03: /quota without thresholds renders both cards in empty state', async ({
    page,
  }) => {
    await page.goto('/quota');
    const card5h = page.getByRole('region', { name: 'Tokens — janela 5h' });
    const card7d = page.getByRole('region', { name: 'Tokens — janela 7d' });
    await expect(card5h).toBeVisible();
    await expect(card7d).toBeVisible();
    // Empty-state affordance: "sem threshold definido" hint + "Definir" button.
    await expect(card5h.getByText('sem threshold definido')).toBeVisible();
    await expect(card7d.getByText('sem threshold definido')).toBeVisible();
    await expect(
      card5h.getByRole('button', { name: /Editar threshold.*5h/ }),
    ).toContainText('Definir');
  });

  // ------------------------------ Dialog ------------------------------

  test('TC-E2E-04: clicking the pencil opens the dialog with autoFocus', async ({
    page,
  }) => {
    await seedThresholdViaDialog(page, '5h', 500_000);
    await page.goto('/quota');
    const card5h = page.getByRole('region', { name: 'Tokens — janela 5h' });
    await card5h
      .getByRole('button', { name: /Editar threshold.*5h/ })
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const input = dialog.getByRole('spinbutton', { name: 'Valor em tokens' });
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('500000');
  });

  test('TC-E2E-05: save new threshold updates card', async ({ page }) => {
    await seedThresholdViaDialog(page, '5h', 200_000);
    await page.goto('/quota');
    const card5h = page.getByRole('region', { name: 'Tokens — janela 5h' });
    await card5h
      .getByRole('button', { name: /Editar threshold.*5h/ })
      .click();
    const dialog = page.getByRole('dialog');
    const input = dialog.getByRole('spinbutton', { name: 'Valor em tokens' });
    await input.fill('500000');
    await dialog.getByRole('button', { name: 'Salvar' }).click();
    await expect(dialog).not.toBeVisible();
    // Card re-renders with new limit — fmtCompact(500_000) = "500K".
    await expect(card5h).toContainText('500K');
  });

  test('TC-E2E-06: negative input shows inline error without closing', async ({
    page,
  }) => {
    await seedThresholdViaDialog(page, '5h', 500_000);
    await page.goto('/quota');
    const card5h = page.getByRole('region', { name: 'Tokens — janela 5h' });
    await card5h
      .getByRole('button', { name: /Editar threshold.*5h/ })
      .click();
    const dialog = page.getByRole('dialog');
    const input = dialog.getByRole('spinbutton', { name: 'Valor em tokens' });
    await input.fill('-1');
    await dialog.getByRole('button', { name: 'Salvar' }).click();
    // Dialog stays open, alert visible.
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('alert')).toBeVisible();
  });

  test('TC-E2E-07: Esc closes the dialog without saving', async ({ page }) => {
    await seedThresholdViaDialog(page, '5h', 500_000);
    await page.goto('/quota');
    const card5h = page.getByRole('region', { name: 'Tokens — janela 5h' });
    await card5h
      .getByRole('button', { name: /Editar threshold.*5h/ })
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const input = dialog.getByRole('spinbutton', { name: 'Valor em tokens' });
    // User types a new value but changes their mind.
    await input.fill('999999');
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    // Original value persisted (dialog aborted the change).
    await expect(card5h).toContainText('500K');
  });

  test('TC-E2E-07b: click on backdrop closes the dialog', async ({ page }) => {
    await seedThresholdViaDialog(page, '5h', 500_000);
    await page.goto('/quota');
    const card5h = page.getByRole('region', { name: 'Tokens — janela 5h' });
    await card5h
      .getByRole('button', { name: /Editar threshold.*5h/ })
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // Click the dialog element itself AT the top-left corner — that's the
    // backdrop (the form is positioned inside with padding). Our handler
    // `e.target === dialogRef.current` closes only when the click is on
    // the dialog element, not on its children.
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      await page.mouse.click(box.x + 1, box.y + 1);
    }
    await expect(dialog).not.toBeVisible();
  });

  test('TC-E2E-07c: keyboard Enter on the pencil opens the dialog', async ({
    page,
  }) => {
    await seedThresholdViaDialog(page, '5h', 500_000);
    await page.goto('/quota');
    const card5h = page.getByRole('region', { name: 'Tokens — janela 5h' });
    const pencil = card5h.getByRole('button', {
      name: /Editar threshold.*5h/,
    });
    await pencil.focus();
    await expect(pencil).toBeFocused();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const input = dialog.getByRole('spinbutton', { name: 'Valor em tokens' });
    await expect(input).toBeFocused();
  });

  test('TC-E2E-07d: closing the dialog via Esc returns focus to the pencil', async ({
    page,
  }) => {
    await seedThresholdViaDialog(page, '5h', 500_000);
    await page.goto('/quota');
    const card5h = page.getByRole('region', { name: 'Tokens — janela 5h' });
    const pencil = card5h.getByRole('button', {
      name: /Editar threshold.*5h/,
    });
    await pencil.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    // Native <dialog>.close() restores focus to the element that had it
    // before showModal().
    await expect(pencil).toBeFocused();
  });

  // ------------------------------ Header copy ------------------------------

  test('TC-E2E-08: header copy mentions both windows and Account & Usage', async ({
    page,
  }) => {
    await page.goto('/quota');
    const header = page.locator('header').first();
    await expect(header).toContainText(/duas janelas/);
    await expect(header).toContainText(/Account & Usage/);
  });

  // ------------------------------ Reset countdown ------------------------------

  test('TC-E2E-09: cards with recent activity show "Reseta em ~" hint', async ({
    page,
  }) => {
    await seedThresholdViaDialog(page, '5h', 500_000);
    await seedThresholdViaDialog(page, '7d', 3_000_000);
    await page.goto('/quota');
    // The seeded e2e-today session has a turn at ~now, inside both the 5h
    // and 7d windows — both cards should display a reset line.
    const card5h = page.getByRole('region', { name: 'Tokens — janela 5h' });
    const card7d = page.getByRole('region', { name: 'Tokens — janela 7d' });
    await expect(card5h).toContainText(/Reseta em ~/);
    await expect(card7d).toContainText(/Reseta em ~/);
  });

  // TC-E2E-10 (empty-activity 5h branch) is covered at the query layer
  // by `lib/queries/quota.test.ts` TC-I-05 (`getQuotaResetEstimates` →
  // `reset5hMs: null` when the most recent turn is > 5h ago) + the
  // trivial branch in `components/quota/quota-token-card.tsx:100`
  // (`if (hasThreshold) return NO_ACTIVITY_COPY[win]`). An E2E version
  // would require mutating seed timestamps mid-suite — same
  // WAL-cross-process pitfall documented in earlier specs. Skipped here
  // to keep the suite deterministic.
  test.skip('TC-E2E-10: no recent 5h activity shows "próxima mensagem inicia bloco"', () => {});

  // ------------------------------ Nav widget ------------------------------

  test('TC-E2E-11: setting a tokens threshold makes the nav widget appear', async ({
    page,
  }) => {
    await seedThresholdViaDialog(page, '5h', 500_000);
    await page.goto('/');
    const widget = page.locator('[aria-label="Quota do Max"]');
    await expect(widget).toBeVisible();
    // No "S 5h" / "S 7d" labels should exist — session tracking was removed.
    await expect(widget).not.toContainText(/^S 5h$/);
    await expect(widget).not.toContainText(/^S 7d$/);
  });

  // ------------------------------ Heatmap ------------------------------

  test('TC-E2E-12: QuotaHeatmap renders below the cards', async ({ page }) => {
    await page.goto('/quota');
    const card5h = page.getByRole('region', { name: 'Tokens — janela 5h' });
    const heatmapHeading = page.getByRole('heading', {
      name: /Padrão de consumo/,
    });
    await expect(heatmapHeading).toBeVisible();
    const boxCard = await card5h.boundingBox();
    const boxHeatmap = await heatmapHeading.boundingBox();
    expect(boxCard).not.toBeNull();
    expect(boxHeatmap).not.toBeNull();
    if (boxCard && boxHeatmap) {
      expect(boxHeatmap.y).toBeGreaterThan(boxCard.y);
    }
  });
});
