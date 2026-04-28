import { test, expect } from '@playwright/test';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * outcome-integration-git — TASK-SMOKE (TC-E2E-01..05).
 *
 * Three seeded sessions cover the rendering branches of
 * `<SessionOutcomePanel>`:
 *   - `e2e-outcome-with-data`        → populated outcome (status=evaluated)
 *   - `e2e-outcome-cwd-missing`      → status=cwd-missing
 *   - `e2e-outcome-not-evaluated`    → no session_outcomes row
 *
 * The home page card (`<OutcomesCard>`) is exercised in two states:
 *   - VISIBLE when at least one session has commits / LOC (TC-E2E-04)
 *   - HIDDEN when no session has any outcome row (TC-E2E-05)
 *
 * TC-E2E-05 strategy
 * ------------------
 * The global-setup seed always populates outcomes for TC-E2E-04, so we can't
 * just "boot with empty outcomes". Two approaches were considered:
 *   1. Spin up a separate Playwright project with its own seed (forking the
 *      webServer) — too invasive.
 *   2. Mid-test, delete every row from `session_outcomes` via direct SQLite,
 *      reload `/`, assert the heading is gone, then restore. — chosen.
 *
 * Approach (2) is robust because:
 *   - The test reads/writes the same DB file the dev server uses (no race —
 *     `<OutcomesCard>` is a Server Component that re-runs the SELECT on each
 *     navigation; no Next caching layer between the query and SSR).
 *   - The restore happens in a `try/finally` so a mid-test failure still
 *     leaves the DB in the original shape for downstream tests in the file.
 *   - It's serial (Playwright config `workers: 1`), so no other test races
 *     the temporary DELETE.
 */

const DB_PATH = path.resolve(__dirname, '../../data/e2e-test.db');

test.describe('outcomes — session detail panel', () => {
  test('TC-E2E-01: populated outcome row renders metrics grid + heuristic tooltip', async ({
    page,
  }) => {
    await page.goto('/sessions/e2e-outcome-with-data');

    // The panel header is "Outcomes". Use a heading lookup so the assertion
    // doesn't false-positive on the home-page Outcomes section heading.
    await expect(
      page.getByRole('heading', { name: 'Outcomes', exact: true }),
    ).toBeVisible();

    // commit_count = 2 + label "Commits" inside the metrics grid.
    await expect(page.getByText('Commits', { exact: true })).toBeVisible();
    await expect(page.getByText('2', { exact: true }).first()).toBeVisible();

    // LOC: +120 / −15 (note minus is U+2212 in the panel).
    await expect(page.getByText('+120')).toBeVisible();
    await expect(page.getByText(/[−-]15/)).toBeVisible();

    // Files changed = 3
    await expect(page.getByText('Files changed')).toBeVisible();

    // Reverts (7d) header + heuristic tooltip trigger label.
    await expect(page.getByText(/Reverts \(7d\)/)).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Como reverts são contados?' }),
    ).toBeVisible();
  });

  test('TC-E2E-02: cwd-missing row renders unavailable copy', async ({ page }) => {
    await page.goto('/sessions/e2e-outcome-cwd-missing');
    await expect(
      page.getByText('Outcomes unavailable: cwd is not a git repository'),
    ).toBeVisible();
    // Metrics grid must NOT render — assert absence of the "Commits" label
    // (which only exists in the populated grid).
    await expect(page.getByText('Commits', { exact: true })).toHaveCount(0);
  });

  test('TC-E2E-03: missing outcome row renders not-yet-evaluated skeleton', async ({
    page,
  }) => {
    await page.goto('/sessions/e2e-outcome-not-evaluated');
    await expect(
      page.getByText(/Outcome not yet evaluated\. Run/),
    ).toBeVisible();
    // The hint mentions `pnpm ingest` literally.
    await expect(page.getByText('pnpm ingest')).toBeVisible();
  });
});

test.describe('outcomes — overview card', () => {
  test('TC-E2E-04: card visible with cost-per-LOC, revert rate, and high-cost list', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Outcomes', exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/Cost per LOC \(30d\)/)).toBeVisible();
    await expect(page.getByText(/Revert rate \(30d\)/)).toBeVisible();
    await expect(page.getByText(/High-cost no-output \(top 3\)/)).toBeVisible();
  });

  test('TC-E2E-05: card hidden when no session_outcomes rows exist', async ({
    page,
  }) => {
    // Strategy (documented at top of file): mid-test delete → reload → assert
    // → restore in `finally`. The seed populates 2 outcome rows; we snapshot
    // them, delete, exercise the empty branch, then re-insert.
    const db = new Database(DB_PATH);
    const snapshot = db
      .prepare(
        `SELECT session_id, commit_count, loc_added, loc_removed,
                files_changed, reverts_within_7d, merged_pr_count,
                status, last_evaluated_at
           FROM session_outcomes`,
      )
      .all() as Array<{
      session_id: string;
      commit_count: number;
      loc_added: number;
      loc_removed: number;
      files_changed: number;
      reverts_within_7d: number;
      merged_pr_count: number | null;
      status: string;
      last_evaluated_at: number;
    }>;

    try {
      db.prepare('DELETE FROM session_outcomes').run();
      db.close();

      await page.goto('/');
      // The home page's H1/H2 set still includes "Visão geral" etc — the
      // OutcomesCard renders its OWN h2 with id="outcomes-heading".
      // When `<OutcomesCard>` returns null, that heading must be absent.
      await expect(page.locator('#outcomes-heading')).toHaveCount(0);
      await expect(
        page.getByRole('heading', { name: 'Outcomes', exact: true }),
      ).toHaveCount(0);
    } finally {
      // Re-open and restore. The `db` connection above was closed before the
      // navigation to avoid holding a write FD while the dev server reads.
      const restoreDb = new Database(DB_PATH);
      const insert = restoreDb.prepare(
        `INSERT INTO session_outcomes (
           session_id, commit_count, loc_added, loc_removed, files_changed,
           reverts_within_7d, merged_pr_count, status, last_evaluated_at
         ) VALUES (
           @session_id, @commit_count, @loc_added, @loc_removed, @files_changed,
           @reverts_within_7d, @merged_pr_count, @status, @last_evaluated_at
         )`,
      );
      const tx = restoreDb.transaction(() => {
        for (const row of snapshot) insert.run(row);
      });
      tx();
      restoreDb.close();
    }
  });
});
