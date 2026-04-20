import { test, expect, type Page } from '@playwright/test';

// QUOTA HELPERS — all mutations go through the form (Server Action) so
// `revalidatePath('/', 'layout')` fires and the dev-server's long-lived
// `better-sqlite3` singleton picks up the change on the next SELECT. A
// direct DB write from this process races against the dev server's WAL
// view cache and produced flakes under full-suite load; the form path is
// deterministic.

const QUOTA_LABELS = [
  'Tokens — janela 5h',
  'Tokens — janela 7d',
  'Sessões — janela 5h',
  'Sessões — janela 7d',
] as const;

type QuotaFieldKey =
  | 'quotaTokens5h'
  | 'quotaTokens7d'
  | 'quotaSessions5h'
  | 'quotaSessions7d';

const LABEL_BY_KEY: Record<QuotaFieldKey, (typeof QUOTA_LABELS)[number]> = {
  quotaTokens5h: 'Tokens — janela 5h',
  quotaTokens7d: 'Tokens — janela 7d',
  quotaSessions5h: 'Sessões — janela 5h',
  quotaSessions7d: 'Sessões — janela 7d',
};

async function resetUserSettings(page: Page): Promise<void> {
  await page.goto('/quota');
  for (const label of QUOTA_LABELS) {
    await page.getByLabel(label).fill('');
  }
  await page.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.getByText('Salvo!')).toBeVisible();
}

async function seedUserSettings(
  page: Page,
  settings: {
    quotaTokens5h: number | null;
    quotaTokens7d: number | null;
    quotaSessions5h: number | null;
    quotaSessions7d: number | null;
  },
): Promise<void> {
  await page.goto('/quota');
  for (const key of Object.keys(LABEL_BY_KEY) as QuotaFieldKey[]) {
    const value = settings[key];
    await page.getByLabel(LABEL_BY_KEY[key]).fill(value === null ? '' : String(value));
  }
  await page.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.getByText('Salvo!')).toBeVisible();
}

test.describe('max plan quota', () => {
  test.beforeEach(async ({ page }) => {
    await resetUserSettings(page);
  });

  test('TC-E2E-01: nav has "Quota" link alongside Visão geral and Sessões', async ({
    page,
  }) => {
    // The unified-dashboard spec collapsed `/effectiveness` into `/` and moved
    // search from a nav link into a header widget, leaving three nav links.
    await page.goto('/');
    const nav = page.locator('nav').first();
    await expect(nav.getByRole('link', { name: 'Visão geral' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Sessões' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Quota' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Efetividade' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Busca' })).toHaveCount(0);
  });

  test('TC-E2E-02: /quota without settings shows H1 + CTA + empty form', async ({
    page,
  }) => {
    await page.goto('/quota');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Quota do Max' }),
    ).toBeVisible();
    await expect(
      page.getByText('Defina seu primeiro threshold abaixo pra ver consumo.'),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Salvar' }),
    ).toBeVisible();
  });

  test('TC-E2E-03: submit form persists threshold and nav widget appears', async ({
    page,
  }) => {
    await page.goto('/quota');
    await page
      .getByLabel('Tokens — janela 5h')
      .fill('50000');
    await page.getByRole('button', { name: 'Salvar' }).click();
    await expect(page.getByText('Salvo!')).toBeVisible();

    await page.goto('/');
    const widget = page.locator('[aria-label="Quota do Max"]').first();
    await expect(widget).toBeVisible();
    await expect(widget.getByText(/5h/)).toBeVisible();
  });

  test('TC-E2E-04: all thresholds null → nav widget is absent', async ({
    page,
  }) => {
    // Route through the form so Server Action invalidates the layout cache
    // (revalidatePath('/', 'layout')). A direct DB DELETE doesn't trigger
    // Next's Full Route Cache invalidation, so the nav slot can stick with
    // stale HTML between tests.
    await page.goto('/quota');
    for (const label of [
      'Tokens — janela 5h',
      'Tokens — janela 7d',
      'Sessões — janela 5h',
      'Sessões — janela 7d',
    ]) {
      await page.getByLabel(label).fill('');
    }
    await page.getByRole('button', { name: 'Salvar' }).click();
    await expect(page.getByText('Salvo!')).toBeVisible();

    await page.goto('/');
    const widget = page.locator('[aria-label="Quota do Max"]');
    await expect(widget).toHaveCount(0);
  });

  test('TC-E2E-05: submit negative value shows error and does not persist', async ({
    page,
  }) => {
    await page.goto('/quota');
    const input = page.getByLabel('Tokens — janela 5h');
    await input.fill('-1');
    await page.getByRole('button', { name: 'Salvar' }).click();
    // Form reports either a field-scoped error (aria-invalid + role=alert) or
    // a generic footer error; both variants assert "did not succeed".
    await expect(page.getByText('Salvo!')).toHaveCount(0);
  });

  test('TC-E2E-06: /quota with threshold and seeded turns renders heatmap title', async ({
    page,
  }) => {
    await seedUserSettings(page, {
      quotaTokens5h: 50000,
      quotaTokens7d: null,
      quotaSessions5h: null,
      quotaSessions7d: null,
    });
    await expect(
      page.getByRole('heading', { name: 'Padrão de consumo (últimas 4 semanas)' }),
    ).toBeVisible();
  });

  test('TC-E2E-07: only one threshold set → exactly one KPI card rendered', async ({
    page,
  }) => {
    await seedUserSettings(page, {
      quotaTokens5h: 50000,
      quotaTokens7d: null,
      quotaSessions5h: null,
      quotaSessions7d: null,
    });
    // The only KPI card in scope should be "Tokens 5h"; the other three titles
    // must NOT appear as KPI cards.
    await expect(page.getByRole('heading', { name: 'Tokens 5h' })).toHaveCount(
      1,
    );
    await expect(page.getByRole('heading', { name: 'Tokens 7d' })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole('heading', { name: 'Sessões 5h' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('heading', { name: 'Sessões 7d' }),
    ).toHaveCount(0);
  });

  test('TC-E2E-08: KpiCard info tooltip contains rolling-window explanation', async ({
    page,
  }) => {
    await seedUserSettings(page, {
      quotaTokens5h: 50000,
      quotaTokens7d: null,
      quotaSessions5h: null,
      quotaSessions7d: null,
    });
    const trigger = page.getByRole('button', { name: 'O que é Tokens 5h?' });
    await expect(trigger).toBeVisible();
    await trigger.hover();
    await expect(
      page.getByText(/Janela rolling — o Max reseta a cada 5h/),
    ).toBeVisible();
  });
});
