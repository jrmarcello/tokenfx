import { test, expect } from '@playwright/test';
import path from 'node:path';
import Database from 'better-sqlite3';

const dbPath = path.resolve(__dirname, '../../data/e2e-test.db');

function seedSpecialSessions(): void {
  const db = new Database(dbPath);
  const now = Date.now();
  const insertSession = db.prepare(
    `INSERT OR REPLACE INTO sessions (
       id, slug, cwd, project, git_branch, cc_version,
       started_at, ended_at,
       total_input_tokens, total_output_tokens,
       total_cache_read_tokens, total_cache_creation_tokens,
       total_cost_usd, total_cost_usd_otel, turn_count, tool_call_count,
       source_file, ingested_at
     ) VALUES (
       @id, NULL, @cwd, @project, 'main', '2.0.0',
       @started_at, @ended_at, 0, 0, 0, 0, 0, NULL, @turn_count, 0,
       @source_file, @ingested_at
     )`,
  );
  // Session with turnCount > 0 but zero rows in `turns` — covers the "turnos
  // declarados mas nenhum ingerido" empty state (REQ-11).
  insertSession.run({
    id: 'e2e-unlogged',
    cwd: '/Users/e2e/unlogged',
    project: 'e2e-project-unlogged',
    started_at: now - 86_400_000,
    ended_at: now - 86_400_000 + 30_000,
    turn_count: 7,
    source_file: 'e2e://e2e-unlogged',
    ingested_at: now,
  });
  // Session with turnCount === 0 — covers the "Sem turnos" empty state +
  // ShareActions hidden (REQ-12).
  insertSession.run({
    id: 'e2e-empty',
    cwd: '/Users/e2e/empty',
    project: 'e2e-project-empty',
    started_at: now - 172_800_000,
    ended_at: now - 172_800_000 + 30_000,
    turn_count: 0,
    source_file: 'e2e://e2e-empty',
    ingested_at: now,
  });
  db.close();
}

test.describe('ui audit fixes', () => {
  test.beforeAll(() => {
    seedSpecialSessions();
  });

  test('TC-E2E-01: /search light mode input is readable', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/search?q=ingest');
    // Force light theme explicitly (defaults to system).
    await page.getByRole('button', { name: 'Alterar tema' }).click();
    await page.getByRole('menuitemradio', { name: 'Claro' }).click();
    await expect(page.locator('html')).not.toHaveClass(/(^|\s)dark(\s|$)/);

    const inputBg = await page
      .getByRole('searchbox', { name: /consulta/i })
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    // Light mode: input background is `bg-white` — some rgb value with all
    // channels high. Assert it is NOT the dark-mode near-black.
    expect(inputBg).not.toBe('rgb(10, 10, 10)');
  });

  test('TC-E2E-02: rota inexistente renderiza not-found global', async ({
    page,
  }) => {
    // Dev mode can return 200 for not-found pages — the contract is the
    // rendered heading + home link, not the HTTP status code.
    await page.goto('/rota-que-nao-existe');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Página não encontrada' }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Voltar pra home' })).toBeVisible();
  });

  test('TC-E2E-03: /sessions/nonexistent-id aciona notFound', async ({
    page,
  }) => {
    await page.goto('/sessions/nonexistent-id-e2e');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Página não encontrada' }),
    ).toBeVisible();
  });

  test('TC-E2E-04: sessão com turnCount > 0 e zero turns mostra alerta', async ({
    page,
  }) => {
    await page.goto('/sessions/e2e-unlogged');
    await expect(
      page.getByText(/declara 7 turnos mas nenhum foi ingerido/i),
    ).toBeVisible();
  });

  test('TC-E2E-05: sessão com turnCount === 0 esconde ShareActions', async ({
    page,
  }) => {
    await page.goto('/sessions/e2e-empty');
    await expect(page.locator('[aria-label="Compartilhar"]')).toHaveCount(0);
    await expect(page.getByText('Sem turnos nesta sessão.')).toBeVisible();
  });

  test('TC-E2E-06: mobile 375px nav scroll horizontal', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 375, height: 667 },
    });
    try {
      const page = await context.newPage();
      await page.goto('/');
      const linkList = page.locator('nav ul').first();
      // scrollWidth > clientWidth means horizontal overflow is available.
      const { sw, cw } = await linkList.evaluate((el) => ({
        sw: el.scrollWidth,
        cw: el.clientWidth,
      }));
      expect(sw).toBeGreaterThan(cw);
    } finally {
      await context.close();
    }
  });

  test('TC-E2E-07: RatingWidget aria-pressed reflete seleção', async ({
    page,
  }) => {
    await page.goto('/sessions/e2e-1');
    const bom = page
      .getByRole('button', { name: 'Bom', exact: true })
      .first();
    await expect(bom).toBeVisible();
    await bom.click();
    // Wait for the transition to settle + read aria-pressed on the same button.
    await expect(bom).toHaveAttribute('aria-pressed', 'true');
  });

  test('TC-E2E-08: em / (não /search) foco NÃO está no search input', async ({
    page,
  }) => {
    await page.goto('/');
    // There is no search input on /.
    const count = await page.locator('input[name="q"]').count();
    expect(count).toBe(0);
  });

  test('TC-E2E-09: /search sem ?q= foca o input', async ({ page }) => {
    await page.goto('/search');
    const input = page.getByRole('searchbox', { name: /consulta/i });
    await expect(input).toBeFocused();
  });

  test('TC-E2E-10: /search?q=foo NÃO rouba foco (query pre-populada)', async ({
    page,
  }) => {
    await page.goto('/search?q=foo');
    const input = page.getByRole('searchbox', { name: /consulta/i });
    // Focus should NOT be on the input — it lands wherever the browser put it
    // (typically body). Assert it's not focused.
    const isFocused = await input.evaluate(
      (el) => document.activeElement === el,
    );
    expect(isFocused).toBe(false);
  });

  test('TC-E2E-11: /search?q=foo dark mode renderiza sem regressão', async ({
    page,
  }) => {
    await page.goto('/search?q=foo');
    await page.getByRole('button', { name: 'Alterar tema' }).click();
    await page.getByRole('menuitemradio', { name: 'Escuro' }).click();
    await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/);
    // Form still visible and usable in dark mode.
    await expect(
      page.getByRole('searchbox', { name: /consulta/i }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Buscar', exact: true }),
    ).toBeVisible();
  });
});
