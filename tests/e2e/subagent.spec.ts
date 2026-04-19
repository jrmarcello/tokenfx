import { test, expect } from '@playwright/test';

test.describe('subagent breakdown', () => {
  test('TC-E2E-01: /sessions/e2e-subagent shows the breakdown with Main + 2 sub-agents', async ({
    page,
  }) => {
    await page.goto('/sessions/e2e-subagent');
    const heading = page.getByRole('heading', {
      name: 'Distribuição por agente',
    });
    await expect(heading).toBeVisible();

    const section = page.locator('section', { has: heading });
    const rows = section.locator('tbody > tr');
    await expect(rows).toHaveCount(3);

    // Main anchor first; then sub-agents by cost desc.
    await expect(rows.nth(0)).toContainText('Main');
    // Explore (turn 1: 1000 in, 300 out) is the costlier sub-agent vs
    // code-reviewer (turn 2: 800 in, 200 out) given the seed.
    await expect(rows.nth(1)).toContainText('Explore');
    await expect(rows.nth(2)).toContainText('code-reviewer');
  });

  test('TC-E2E-02: /sessions/e2e-1 (main-only seed) hides the breakdown section', async ({
    page,
  }) => {
    await page.goto('/sessions/e2e-1');
    // Session heading still present
    await expect(
      page.getByRole('heading', { level: 1, name: 'e2e-project-alpha' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Distribuição por agente' }),
    ).toHaveCount(0);
  });

  test('TC-E2E-03: breakdown renders BEFORE the TranscriptViewer in the DOM', async ({
    page,
  }) => {
    await page.goto('/sessions/e2e-subagent');
    const breakdown = page.getByRole('heading', {
      name: 'Distribuição por agente',
    });
    // The transcript viewer uses an <ol> with turn list items.
    const viewer = page.locator('ol > li').first();
    await expect(breakdown).toBeVisible();
    await expect(viewer).toBeVisible();

    const relation = await breakdown.evaluate((a, b) => {
      if (!(b instanceof HTMLElement)) return 0;
      return a.compareDocumentPosition(b);
    }, await viewer.elementHandle());
    // Node.DOCUMENT_POSITION_FOLLOWING = 4 → viewer follows breakdown.
    expect(relation & 4).toBe(4);
  });
});
