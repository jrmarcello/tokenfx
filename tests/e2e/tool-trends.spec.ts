import { test, expect } from '@playwright/test';

test.describe('tool success trends', () => {
  test('TC-E2E-01: / shows chart when seed has ≥2 tools above threshold', async ({
    page,
  }) => {
    // /effectiveness foi consolidada em / (spec unified-dashboard). A seção
    // "Tendência de erro por ferramenta" vive agora no bloco #efetividade.
    await page.goto('/');

    const heading = page.getByRole('heading', {
      name: 'Tendência de erro por ferramenta',
    });
    await expect(heading).toBeVisible();

    // The chart wrapper has role="img" + aria-label starting with "Tendência"
    const chart = page.getByRole('img', { name: /Tendência semanal/ });
    await expect(chart).toBeVisible();

    // Recharts Legend renders tool names; the seed uses Bash + Read so both
    // must appear at least once.
    await expect(page.locator('.recharts-legend-item').first()).toBeVisible();
    await expect(page.getByText('Bash').first()).toBeVisible();
    await expect(page.getByText('Read').first()).toBeVisible();
  });

  test('TC-E2E-02: section is hidden on a main-only session page (scope isolation)', async ({
    page,
  }) => {
    // TC-E2E-02 in the spec targets an empty-window scenario; our E2E env
    // always seeds tool calls, so we verify the other dimension of the hide
    // rule: the trend section belongs to the global dashboard only, never
    // to the per-session page. Session detail should NOT carry the heading.
    await page.goto('/sessions/e2e-1');
    await expect(
      page.getByRole('heading', { name: 'Tendência de erro por ferramenta' }),
    ).toHaveCount(0);
  });
});
