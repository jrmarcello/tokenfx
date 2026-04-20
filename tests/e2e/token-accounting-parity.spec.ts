import { test, expect } from '@playwright/test';

test.describe('token accounting parity', () => {
  // --------------------------- KPI Tokens tooltip ---------------------------

  test('TC-E2E-01: Tokens KPI info tooltip shows the 4-way breakdown', async ({
    page,
  }) => {
    await page.goto('/');
    const trigger = page.getByRole('button', {
      name: 'O que é Tokens (30d)?',
    });
    await expect(trigger).toBeVisible();
    await trigger.hover();
    // `InfoTooltip` renders a `span[role="tooltip"]` whose accessible name is
    // its full text content. Scope by the 3 breakdown labels to avoid the
    // OtelStatusBadge / Cost tooltips also on the page.
    const tooltip = page.getByRole('tooltip', { name: /Breakdown:/ });
    await expect(tooltip).toBeAttached();
    const text = (await tooltip.textContent()) ?? '';
    // Each of the 3 breakdown labels is followed by a `<strong>` with the
    // formatted value — match label + at least one digit on the same string.
    expect(text).toMatch(/Input \+ output:\s*\d/);
    expect(text).toMatch(/Cache creation:\s*\d/);
    expect(text).toMatch(/Cache read:\s*\d/);
  });

  test('TC-E2E-02: Tokens KPI tooltip textually mentions ccusage', async ({
    page,
  }) => {
    await page.goto('/');
    const trigger = page.getByRole('button', {
      name: 'O que é Tokens (30d)?',
    });
    await trigger.hover();
    const tooltip = page.getByRole('tooltip', { name: /Breakdown:/ });
    await expect(tooltip).toBeAttached();
    const text = (await tooltip.textContent()) ?? '';
    expect(text).toMatch(/ccusage/);
  });

  // --------------------------- Delegação a subagents card ---------------------------

  test('TC-E2E-03: Delegação a subagents card renders with N/M sessões pattern', async ({
    page,
  }) => {
    await page.goto('/');
    // KpiCard title is rendered as a heading inside the card header.
    await expect(
      page.getByRole('heading', { name: /Delegação a subagents/ }),
    ).toBeVisible();
    // Value pattern: "{with}/{total} sessões".
    await expect(page.getByText(/^\d+\/\d+ sessões$/)).toBeVisible();
  });

  test('TC-E2E-04: Delegação card hint shows "X% dos tokens"', async ({
    page,
  }) => {
    await page.goto('/');
    // Hint text is rendered inside the KpiCard; matches `"<N>% dos tokens"`.
    await expect(page.getByText(/\d+(\.\d+)?%\s+dos tokens/)).toBeVisible();
  });

  // TC-E2E-05: empty-state branch (subagentUsage.sessionsTotal === 0 hides
  // the card) is covered at the unit/integration layer — see
  // `lib/queries/effectiveness.test.ts` TC-I-06 and the conditional render
  // at app/page.tsx:274. An E2E version was attempted but proved
  // incompatible with `next dev`'s long-lived `better-sqlite3` singleton,
  // which serves a stale WAL view of cross-process DELETEs (same root
  // cause documented in tests/e2e/unified-dashboard.spec.ts TC-E2E-16).
  test.skip('TC-E2E-05: empty DB → Delegação card not visible', () => {});

  // --------------------------- Efetividade grid ---------------------------

  test('TC-E2E-06: Efetividade section has 4 KPI cards at ≥lg viewport', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    const efetividade = page.locator('section#efetividade');
    // 4 cards expected: Score médio, Cost per turn médio, Sessões avaliadas,
    // Delegação a subagents.
    const headings = [
      /Score médio/,
      /Cost per turn médio/,
      /Sessões avaliadas/,
      /Delegação a subagents/,
    ];
    for (const name of headings) {
      await expect(efetividade.getByRole('heading', { name })).toBeVisible();
    }
  });
});
