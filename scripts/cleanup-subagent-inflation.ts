#!/usr/bin/env node
/**
 * One-shot cleanup of DB rows inflated by the historical subagent-JSONL
 * ingestion bug (see `.specs/fix-ingest-skip-subagent-jsonls.md`).
 *
 * Pre-fix, `lib/fs-paths.ts:listTranscriptFiles` walked into
 * `<sessionId>/subagents/agent-*.jsonl` files and the writer UPSERTed them
 * onto the parent's `sessions` row — every subagent file overwrote the
 * parent's `started_at` / `ended_at` / `source_file`, inflating the session
 * window to the union of parent + all subagents. Downstream metrics
 * computed against that window (commit_count, loc_added, reverts_within_7d,
 * merged_pr_count) drift accordingly.
 *
 * This script wipes the local DB so re-ingest can rebuild from JSONLs
 * without the subagent inflation. Tables are deleted in dependency order
 * inside a single transaction (FK CASCADE acts as a safety net but the
 * explicit ordering documents the dependency and survives schema
 * evolution that might drop ON DELETE CASCADE).
 *
 * Usage:
 *   pnpm tsx scripts/cleanup-subagent-inflation.ts --dry-run   # report only (default)
 *   pnpm tsx scripts/cleanup-subagent-inflation.ts --yes       # actual delete (creates a .bak first)
 *
 * Default-safe: without `--yes` (and even if `--dry-run` is omitted), the
 * CLI runs in dry-run mode and emits row counts only. `--yes` is required
 * for the actual transaction; before any DELETE runs, the script copies
 * the SQLite file to `<dbPath>.pre-cleanup-<epochMs>.bak`. After running,
 * invoke `pnpm ingest` to rebuild the DB from JSONLs.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { openDatabase, type DB } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';
import { log } from '@tokenfx/shared/logger';

/**
 * Tables wiped by `cleanupSubagentInflation`, listed in delete order.
 *
 * The order respects FK dependencies (children before parents):
 * - `session_outcomes` / `compaction_events` / `reporter_pushed_sessions`
 *   reference `sessions(id)` (CASCADE).
 * - `ratings` / `tool_calls` reference `turns(id)` (CASCADE).
 * - `turns` references `sessions(id)` (CASCADE).
 * - `ingested_files` is FK-independent but MUST be cleared so re-ingest
 *   doesn't skip parent JSONLs whose mtime didn't advance after cleanup.
 */
export const TABLES_IN_DEPENDENCY_ORDER = [
  'session_outcomes',
  'compaction_events',
  'reporter_pushed_sessions',
  'ratings',
  'tool_calls',
  'turns',
  'sessions',
  'ingested_files',
] as const;

type TableName = (typeof TABLES_IN_DEPENDENCY_ORDER)[number];

export type CleanupOpts = {
  readonly dryRun: boolean;
};

export type CleanupResult = {
  readonly dryRun: boolean;
  readonly counts: Readonly<Record<TableName, number>>;
};

/**
 * Pure DB operation: count rows per table, then DELETE (unless dry-run)
 * inside a single transaction. Logging goes through `lib/logger`.
 *
 * Returns the row counts observed (= rows deleted on real-run; = rows
 * that WOULD be deleted on dry-run).
 */
export const cleanupSubagentInflation = (
  db: DB,
  opts: CleanupOpts,
): CleanupResult => {
  const counts = {} as Record<TableName, number>;

  // Pre-count before any DELETE so the dry-run and real-run report the
  // same shape. Table names are interpolated into SQL because SQLite does
  // not parameter-bind identifiers — but `TABLES_IN_DEPENDENCY_ORDER` is
  // a closed `as const` tuple of compile-time string literals (no user
  // input ever reaches this code path), so the interpolation is
  // safe-by-construction (security.md prepared-statement rule applies to
  // user-controlled values, not to typed allowlist constants).
  for (const table of TABLES_IN_DEPENDENCY_ORDER) {
    const row = db
      .prepare(`SELECT COUNT(*) AS c FROM ${table}`)
      .get() as { c: number };
    counts[table] = row.c;
  }

  if (opts.dryRun) {
    for (const table of TABLES_IN_DEPENDENCY_ORDER) {
      log.info(`[dry-run] would delete ${counts[table]} rows from ${table}`);
    }
    return { dryRun: true, counts };
  }

  const tx = db.transaction(() => {
    for (const table of TABLES_IN_DEPENDENCY_ORDER) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
  });
  tx();

  for (const table of TABLES_IN_DEPENDENCY_ORDER) {
    log.info(`deleted ${counts[table]} rows from ${table}`);
  }

  return { dryRun: false, counts };
};

const main = (): number => {
  try {
    const args = process.argv.slice(2);
    // Default-safe: require explicit `--yes` for a real run. Anything else
    // (including a missing flag) falls back to dry-run. `--dry-run` is
    // accepted explicitly for documentation parity but isn't required.
    const explicitYes = args.includes('--yes');
    const dryRun = !explicitYes;
    const dbPath = process.env.DASHBOARD_DB_PATH ?? './data/dashboard.db';

    if (!dryRun) {
      // Backup the SQLite file BEFORE opening the connection so a stray
      // failure (e.g. WAL flush mid-transaction) leaves the .bak intact.
      // Skip when the file doesn't exist yet — `openDatabase` creates it.
      if (fs.existsSync(dbPath)) {
        const backupPath = `${dbPath}.pre-cleanup-${Date.now()}.bak`;
        fs.copyFileSync(dbPath, backupPath);
        log.info(`pre-cleanup backup written to ${backupPath}`);
      }
    } else if (!args.includes('--dry-run')) {
      // The user neither asked for dry-run nor confirmed --yes; nudge them
      // toward the explicit flag.
      log.info(
        'no --yes flag — running in dry-run mode (pass --yes to actually delete)',
      );
    }

    const db = openDatabase(dbPath);
    migrate(db);
    const result = cleanupSubagentInflation(db, { dryRun });
    db.close();
    const totalRows = Object.values(result.counts).reduce(
      (acc, n) => acc + n,
      0,
    );
    log.info(
      `cleanup-subagent-inflation: ${
        result.dryRun ? 'DRY-RUN' : 'DELETED'
      } total=${totalRows} db=${dbPath}`,
    );
    return 0;
  } catch (err) {
    log.error(
      'cleanup-subagent-inflation failed:',
      err instanceof Error ? err.message : String(err),
    );
    return 1;
  }
};

// Only run `main()` when this file is the process entry point (not when
// imported by tests). `fileURLToPath(import.meta.url)` ≙ argv[1] when
// invoked directly via `tsx scripts/cleanup-subagent-inflation.ts`.
const invokedAsScript =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (invokedAsScript) {
  process.exit(main());
}
