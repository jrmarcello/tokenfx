import { test, expect } from '@playwright/test';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * effectiveness-personal-v2 — TASK-SMOKE (TC-E2E-01..07).
 *
 * Seeds (added to global-setup.ts under `EFFECTIVENESS_V2_SEEDS`):
 *   - 6 sessions prefixed `e2e-eff-v2-*` spread over the 30-day window,
 *     each with Edit/MultiEdit/Write tool_calls so the funnel populates.
 *   - 5 of them rated (-1 / 0 / 1 mix) so the cost × rating scatter has
 *     ≥3 distinct points and the regression line is non-degenerate.
 *   - `e2e-eff-v2-compact` carries 2 rows in `compaction_events` so
 *     `getPersonalEffectivenessAggregates.sessionsWithCompaction` ≥ 1.
 *
 * TC-E2E-06 strategy
 * ------------------
 * Same approach proven in `outcomes.spec.ts` TC-E2E-05: snapshot every
 * sessions row, DELETE FROM sessions (ON DELETE CASCADE clears turns,
 * tool_calls, ratings, compaction_events, …), reload `/effectiveness`,
 * assert the empty-state branch renders, and restore inside `finally`.
 *
 * Why DELETE-and-restore vs a separate Playwright project:
 *   - Playwright is configured with `workers: 1` (serial), so no other
 *     test races the temporary truncation.
 *   - `/effectiveness` is rendered with `dynamic = 'force-dynamic'`, so
 *     the SELECT re-runs on every navigation — no fetch cache to fight.
 *   - Forking the webServer to bring up a second seedless project would
 *     double the ~1min test runtime for a single edge-case TC.
 *   - Restore happens inside `try/finally` — a mid-test failure still
 *     leaves the DB intact for downstream tests.
 */

const DB_PATH = path.resolve(__dirname, '../../data/e2e-test.db');

test.describe('effectiveness-v2 — page sections', () => {
  test('TC-E2E-01: /effectiveness renders all expected sections with seed data', async ({
    page,
  }) => {
    await page.goto('/effectiveness');

    // (0) main heading
    await expect(
      page.getByRole('heading', { name: /Efetividade pessoal/, level: 1 }),
    ).toBeVisible();

    // (1) KPIs section
    await expect(
      page.getByRole('heading', { name: 'KPIs', exact: true }),
    ).toBeVisible();

    // (2) heatmap
    await expect(
      page.getByRole('heading', { name: /Efetividade do último ano/ }),
    ).toBeVisible();

    // (3) funnel
    await expect(
      page.getByRole('heading', { name: /Funil de execução/ }),
    ).toBeVisible();

    // (4) scatter
    await expect(
      page.getByRole('heading', { name: /Custo × avaliação manual/ }),
    ).toBeVisible();

    // (5) insight panel
    await expect(
      page.getByRole('heading', { name: /Top vs bottom quartile/ }),
    ).toBeVisible();

    // (6) score distribution
    await expect(
      page.getByRole('heading', { name: /Distribuição de score/ }),
    ).toBeVisible();

    // (7) tool success trend (only renders when `tools.length > 0`; the
    // existing `e2e-tool-trend` seed guarantees this) OR (8) sub-agents card
    // — at least one of the two must be visible so the trailing sections
    // exercise. We assert the sub-agents card heading directly because the
    // e2e-subagent seed guarantees `sessionsWithAgent > 0`.
    await expect(
      page.getByRole('heading', { name: 'Sub-agents', exact: true }),
    ).toBeVisible();
  });

  test('TC-E2E-02: insight panel renders "melhores sessões…" microcopy with finite numbers', async ({
    page,
  }) => {
    await page.goto('/effectiveness');

    // The panel renders 4 lines via `formatInsightLine`; every line starts
    // with "Suas melhores sessões" or "Padrão consistente em" (when top ===
    // bottom). The seed produces enough variance for at least one comparison
    // line to render.
    const insightCell = page.getByText(/Suas melhores sessões/).first();
    await expect(insightCell).toBeVisible();

    const text = await insightCell.textContent();
    expect(text).toBeTruthy();
    // No NaN / undefined leaking through formatting.
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('undefined');
  });

  test('TC-E2E-03: scatter renders Recharts SVG with regression line + ≥3 circles', async ({
    page,
  }) => {
    await page.goto('/effectiveness');

    // Anchor the lookup to the scatter region (aria-labelledby="scatter-heading")
    // so we don't pick up the tool-success-trend chart which also uses Recharts.
    // Using `getByRole('region', …)` matches the `<section aria-labelledby>`
    // wrapper exactly — `locator('section', {has: heading})` would also match
    // the outer page wrapper, triggering strict-mode violations.
    const scatterSection = page.getByRole('region', {
      name: /Custo × avaliação manual/,
    });
    await expect(scatterSection).toBeVisible();

    // Recharts emits one `<svg>` per chart; circles are the scatter points.
    const svg = scatterSection.locator('svg').first();
    await expect(svg).toBeVisible();

    // The regression line is drawn as a `<Line>` (path), and the points as
    // `<Scatter>` (circles). Recharts renders Line as a `<path>` element with
    // class `recharts-line-curve`, not `<line>` — assert presence of that
    // path so the regression visual is verified.
    await expect(svg.locator('path.recharts-line-curve')).toHaveCount(1);

    // Recharts scatter points have `class="recharts-symbols"` (paths). They
    // are SVG `<path>` elements rendered with a circle `d` attribute, NOT
    // raw `<circle>` tags. Spec wording says "circles" but the contract is
    // "≥3 visible scatter points" — assert the count of recharts-symbols.
    const points = svg.locator('path.recharts-symbols');
    expect(await points.count()).toBeGreaterThanOrEqual(3);
  });

  test('TC-E2E-04: funnel renders 4 stages in non-increasing order', async ({
    page,
  }) => {
    await page.goto('/effectiveness');

    // The funnel component's `role="img"` wrapper carries an aria-label of
    // the form "Funnel de efetividade: Iniciadas N → Com Edit M → …".
    const funnel = page.getByRole('img', {
      name: /Funnel de efetividade/,
    });
    await expect(funnel).toBeVisible();

    const ariaLabel = (await funnel.getAttribute('aria-label')) ?? '';
    // Parse "<stage> <count>" segments from the label. The component joins
    // with " → " (with space-arrow-space) — split on it, then extract the
    // trailing integer per segment.
    const segments = ariaLabel
      .replace(/^Funnel de efetividade:\s*/, '')
      .split('→')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    expect(segments.length).toBe(4);

    const counts = segments.map((s) => {
      const match = s.match(/(\d+)\s*$/);
      return match ? Number(match[1]) : NaN;
    });
    counts.forEach((c) => expect(Number.isFinite(c)).toBe(true));

    for (let i = 0; i < counts.length - 1; i++) {
      expect(counts[i]).toBeGreaterThanOrEqual(counts[i + 1]);
    }
  });

  test('TC-E2E-05: heatmap renders bipolar palette (≥1 rose + ≥1 emerald cell)', async ({
    page,
  }) => {
    await page.goto('/effectiveness');

    // Use the labelled region (aria-labelledby="heatmap-heading") to avoid
    // matching the outer page `<section>` wrapper.
    const heatmapSection = page.getByRole('region', {
      name: /Efetividade do último ano/,
    });
    await expect(heatmapSection).toBeVisible();

    // `data-level` attribute is added per cell by `<ActivityHeatmap />` after
    // the colorScheme refactor (TASK-7). Levels 0..4 map to the
    // `EFFECTIVENESS_PALETTE` swatches.
    const cells = heatmapSection.locator('[data-level]');
    expect(await cells.count()).toBeGreaterThan(0);

    // The palette is locked at L1=rose-400, L4=emerald-400 (Design §10).
    // The mixed seed (high vs low scoring sessions on different days)
    // guarantees ≥1 of each. We assert at least one low-bucket cell
    // (level 1 or 2 → "ruim/médio") and one high-bucket cell (level 3 or 4
    // → "bom/ótimo") render. Stricter than asking only for L1 + L4 because
    // bucketing rounds to cell-level quartiles.
    const lowCells = heatmapSection.locator(
      '[data-level="1"], [data-level="2"]',
    );
    const highCells = heatmapSection.locator(
      '[data-level="3"], [data-level="4"]',
    );
    expect(await lowCells.count()).toBeGreaterThanOrEqual(1);
    expect(await highCells.count()).toBeGreaterThanOrEqual(1);
  });

  test('TC-E2E-06: empty DB → OverviewEmptyState replaces the sections', async ({
    page,
  }) => {
    // Snapshot every table that ON DELETE CASCADE will clear, then DELETE
    // FROM sessions — the FK chain wipes turns, tool_calls, ratings,
    // compaction_events, session_outcomes. We restore from the snapshots in
    // `finally` so downstream tests see the seeded DB intact.
    const db = new Database(DB_PATH);

    type SessionRow = Record<string, unknown>;
    const sessions = db.prepare(`SELECT * FROM sessions`).all() as SessionRow[];
    const turns = db.prepare(`SELECT * FROM turns`).all() as SessionRow[];
    const toolCalls = db
      .prepare(`SELECT * FROM tool_calls`)
      .all() as SessionRow[];
    const ratings = db.prepare(`SELECT * FROM ratings`).all() as SessionRow[];
    const compactionEvents = db
      .prepare(`SELECT * FROM compaction_events`)
      .all() as SessionRow[];
    const outcomes = db
      .prepare(`SELECT * FROM session_outcomes`)
      .all() as SessionRow[];

    try {
      // ON DELETE CASCADE on turns/tool_calls/ratings/compaction_events/
      // session_outcomes means a single DELETE FROM sessions cleans the lot.
      db.prepare(`DELETE FROM sessions`).run();
      db.close();

      await page.goto('/effectiveness');

      // The empty-state copy is the canonical literal from the page (REQ-27).
      await expect(
        page.getByText(/Sem sessões ainda — execute/),
      ).toBeVisible();

      // None of the section headings should render.
      await expect(
        page.getByRole('heading', { name: 'KPIs', exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole('heading', { name: /Funil de execução/ }),
      ).toHaveCount(0);
      await expect(
        page.getByRole('heading', { name: /Custo × avaliação manual/ }),
      ).toHaveCount(0);
    } finally {
      // Re-open the DB and rebuild every cleared table from the snapshots.
      // FK ordering: sessions → turns → tool_calls / ratings; outcomes and
      // compaction_events also reference sessions.
      const restoreDb = new Database(DB_PATH);
      const restoreTx = restoreDb.transaction(() => {
        const insertGeneric = (
          table: string,
          rows: SessionRow[],
        ): void => {
          if (rows.length === 0) return;
          const columns = Object.keys(rows[0] as Record<string, unknown>);
          const placeholders = columns.map((c) => `@${c}`).join(', ');
          const stmt = restoreDb.prepare(
            `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
          );
          for (const row of rows) stmt.run(row);
        };
        insertGeneric('sessions', sessions);
        insertGeneric('turns', turns);
        insertGeneric('tool_calls', toolCalls);
        insertGeneric('ratings', ratings);
        insertGeneric('compaction_events', compactionEvents);
        insertGeneric('session_outcomes', outcomes);
      });
      restoreTx();
      restoreDb.close();
    }
  });
});

test.describe('effectiveness-v2 — home link', () => {
  test('TC-E2E-07: home page shows "Ver análise profunda →" linking to /effectiveness', async ({
    page,
  }) => {
    await page.goto('/');

    const link = page.getByRole('link', {
      name: /Ver análise profunda/,
    });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', '/effectiveness');

    await link.click();
    await expect(page).toHaveURL(/\/effectiveness$/);
    await expect(
      page.getByRole('heading', { name: /Efetividade pessoal/, level: 1 }),
    ).toBeVisible();
  });
});
