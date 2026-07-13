#!/usr/bin/env node
/**
 * Recompute cost data on the local DB.
 *
 * Three modes, dispatched by CLI flag:
 *
 * 1. **`--all` | `--since DATE` | `--session ID`** (default mode):
 *    recompute `turns.cost_usd` using the current pricing table and
 *    reconcile `sessions.total_cost_usd` rollups for the scoped subset.
 *    `sessions.total_cost_usd_otel` is never touched. Useful after a
 *    pricing fix when historical turns are frozen at wrong costs.
 *
 * 2. **`--prefer-otel`**: populate `sessions.total_cost_usd_otel` from
 *    `claude_code_cost_usage_total` scrapes in `otel_scrapes`. Only writes
 *    when stored value differs (idempotent re-runs).
 *
 * 3. **`--recalibrate`**: refresh the cost-calibration table from current
 *    OTEL data via `recomputeCostCalibration`.
 *
 * **`--dry-run`** modifier (any mode): runs the full logic inside a
 * transaction that ROLLS BACK at the end. Reports the would-be summary
 * with a `[dry-run]` log prefix.
 *
 * The default mode REQUIRES a scope filter — `--all` is no longer
 * implicit. Calling `tsx scripts/recompute-costs.ts` without flags prints
 * usage and exits 1 (safer than destructive default).
 *
 * Core logic exported as `recomputeCosts(opts)` so tests can exercise it
 * without spawning a child process; `main()` only runs when this file is
 * invoked directly.
 */
import { fileURLToPath } from 'node:url';
import { getDb } from '@/lib/db/client';
import { computeCost } from '@/lib/analytics/pricing';
import {
  reconcileAllSessions,
  reconcileSessionsByIds,
} from '@/lib/ingest/reconcile';
import { getOtelCostBySession } from '@/lib/queries/otel';
import { recomputeCostCalibration } from '@/lib/queries/calibration';
import { log } from '@tokenfx/shared/logger';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Scope =
  | { kind: 'all' }
  | { kind: 'since'; sinceMs: number }
  | { kind: 'session'; id: string };

export type ErrorReason =
  | 'no-filter'
  | 'invalid-date'
  | 'invalid-session'
  | 'mutually-exclusive'
  | 'incompatible-mode';

export type ParsedArgs =
  | { mode: 'default'; scope: Scope; dryRun: boolean }
  | { mode: 'prefer-otel'; dryRun: boolean }
  | { mode: 'recalibrate'; dryRun: boolean }
  | { mode: 'error'; reason: ErrorReason };

export type RecomputeSummary =
  | {
      mode: 'default';
      scope: Scope;
      dryRun: boolean;
      total: number;
      updated: number;
      unchanged: number;
      zeroedBefore: number;
      zeroedAfter: number;
    }
  | {
      mode: 'prefer-otel';
      dryRun: boolean;
      totalOtelSessions: number;
      updatedOtelCosts: number;
      unchangedOtelCosts: number;
    }
  | {
      mode: 'recalibrate';
      dryRun: boolean;
      familiesWritten: number;
      skippedOutOfBounds: number;
    };

// Legacy alias retained so existing tests pass `{ preferOtel, recalibrate }`
// directly without migrating. New callers use `ParsedArgs`. The runtime
// dispatch in `recomputeCosts` accepts either shape.
export type RecomputeOpts =
  | ParsedArgs
  | {
      preferOtel?: boolean;
      recalibrate?: boolean;
    };

// ---------------------------------------------------------------------------
// Internal: dry-run rollback via subclass error (idiomatic better-sqlite3)
// ---------------------------------------------------------------------------

class DryRunRollback extends Error {
  constructor() {
    super('dry-run rollback');
    this.name = 'DryRunRollback';
  }
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const parseDate = (input: string): number | null => {
  if (!DATE_RE.test(input)) return null;
  const [y, m, d] = input.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d);
  // Round-trip check rejects calendar-invalid dates like 2025-02-29 that
  // V8's Date.UTC silently rolls forward (→ 2025-03-01).
  if (new Date(ms).toISOString().slice(0, 10) !== input) return null;
  return ms;
};

export const parseArgs = (argv: readonly string[]): ParsedArgs => {
  const hasAll = argv.includes('--all');
  const hasPreferOtel = argv.includes('--prefer-otel');
  const hasRecalibrate = argv.includes('--recalibrate');
  const dryRun = argv.includes('--dry-run');

  const sinceIdx = argv.indexOf('--since');
  const sinceValue = sinceIdx >= 0 ? argv[sinceIdx + 1] ?? '' : null;
  const sessionIdx = argv.indexOf('--session');
  const sessionValue = sessionIdx >= 0 ? argv[sessionIdx + 1] ?? '' : null;

  const hasSince = sinceIdx >= 0;
  const hasSession = sessionIdx >= 0;

  // Filter mutual exclusion (default mode only): exactly one of all/since/session.
  const filterCount =
    (hasAll ? 1 : 0) + (hasSince ? 1 : 0) + (hasSession ? 1 : 0);
  if (filterCount > 1) return { mode: 'error', reason: 'mutually-exclusive' };

  // --session / --since incompatible with prefer-otel / recalibrate.
  if ((hasSession || hasSince) && (hasPreferOtel || hasRecalibrate)) {
    return { mode: 'error', reason: 'incompatible-mode' };
  }

  if (hasRecalibrate) return { mode: 'recalibrate', dryRun };
  if (hasPreferOtel) return { mode: 'prefer-otel', dryRun };

  if (hasAll) {
    return { mode: 'default', scope: { kind: 'all' }, dryRun };
  }

  if (hasSince) {
    const sinceMs = parseDate(sinceValue ?? '');
    if (sinceMs === null) return { mode: 'error', reason: 'invalid-date' };
    return { mode: 'default', scope: { kind: 'since', sinceMs }, dryRun };
  }

  if (hasSession) {
    const id = (sessionValue ?? '').trim();
    if (id.length === 0) return { mode: 'error', reason: 'invalid-session' };
    // Sanitize against log-injection (CR/LF/ANSI) and unbounded input.
    // Claude Code session IDs are UUID-ish; restricting to safe chars is
    // conservative without losing legitimate input.
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) {
      return { mode: 'error', reason: 'invalid-session' };
    }
    return { mode: 'default', scope: { kind: 'session', id }, dryRun };
  }

  return { mode: 'error', reason: 'no-filter' };
};

// ---------------------------------------------------------------------------
// Adapter: legacy `{ preferOtel, recalibrate }` → ParsedArgs
// ---------------------------------------------------------------------------

const toParsedArgs = (opts: RecomputeOpts): ParsedArgs => {
  // Already a ParsedArgs (has discriminant `mode`).
  if ('mode' in opts) return opts;
  if (opts.recalibrate) return { mode: 'recalibrate', dryRun: false };
  if (opts.preferOtel) return { mode: 'prefer-otel', dryRun: false };
  // Legacy default mode (no flags) — implicit `--all` for backward compat
  // with existing integration tests. New CLI invocations cannot reach this
  // path because parseArgs requires an explicit filter.
  return {
    mode: 'default',
    scope: { kind: 'all' },
    dryRun: false,
  };
};

// ---------------------------------------------------------------------------
// Default mode: scope-filtered turn recompute
// ---------------------------------------------------------------------------

type TurnRow = {
  id: string;
  session_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cache_creation_5m_tokens: number;
  cache_creation_1h_tokens: number;
  cost_usd: number;
};

const recomputeTurnsDefault = (
  scope: Scope,
  dryRun: boolean,
): RecomputeSummary => {
  const db = getDb();

  const baseSelectCols = `t.id, t.session_id, t.model, t.input_tokens,
    t.output_tokens, t.cache_read_tokens, t.cache_creation_tokens,
    t.cache_creation_5m_tokens, t.cache_creation_1h_tokens, t.cost_usd`;

  const rows: TurnRow[] =
    scope.kind === 'all'
      ? (db.prepare(`SELECT ${baseSelectCols} FROM turns t`).all() as TurnRow[])
      : scope.kind === 'since'
        ? (db
            .prepare(
              `SELECT ${baseSelectCols} FROM turns t
               JOIN sessions s ON s.id = t.session_id
               WHERE s.started_at >= ?`,
            )
            .all(scope.sinceMs) as TurnRow[])
        : (db
            .prepare(
              `SELECT ${baseSelectCols} FROM turns t WHERE t.session_id = ?`,
            )
            .all(scope.id) as TurnRow[]);

  // --session edge: ID not in DB → soft-fail (REQ-6).
  if (scope.kind === 'session' && rows.length === 0) {
    const sessionExists = db
      .prepare('SELECT 1 FROM sessions WHERE id = ?')
      .get(scope.id);
    if (!sessionExists) {
      const prefix = dryRun ? '[dry-run] ' : '';
      log.warn(`${prefix}recompute-costs`, {
        info: 'session-id-not-found',
        sessionId: scope.id,
      });
    }
    return {
      mode: 'default',
      scope,
      dryRun,
      total: 0,
      updated: 0,
      unchanged: 0,
      zeroedBefore: 0,
      zeroedAfter: 0,
    };
  }

  const update = db.prepare('UPDATE turns SET cost_usd = ? WHERE id = ?');

  let updated = 0;
  let unchanged = 0;
  let zeroedBefore = 0;
  let zeroedAfter = 0;
  const touchedSessionIds = new Set<string>();

  const runRecompute = (): void => {
    for (const r of rows) {
      // Prefer the split 5m/1h cache-creation buckets when present (1h bills
      // at 2x vs 1.25x for 5m — computeCost's REQ-12 priority rule); fall back
      // to the legacy aggregate (treated as 100% 5m) only when no split data.
      const hasSplit =
        r.cache_creation_5m_tokens > 0 || r.cache_creation_1h_tokens > 0;
      const newCost = computeCost({
        model: r.model,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        cacheReadTokens: r.cache_read_tokens,
        ...(hasSplit
          ? {
              cacheCreation5mTokens: r.cache_creation_5m_tokens,
              cacheCreation1hTokens: r.cache_creation_1h_tokens,
            }
          : { cacheCreationTokens: r.cache_creation_tokens }),
      });
      const rounded = Math.round(newCost * 1e6) / 1e6;
      if (r.cost_usd === 0) zeroedBefore += 1;
      if (rounded === 0) zeroedAfter += 1;
      if (Math.abs(rounded - r.cost_usd) > 5e-7) {
        update.run(rounded, r.id);
        updated += 1;
        touchedSessionIds.add(r.session_id);
      } else {
        unchanged += 1;
      }
    }
    // Reconcile only the sessions whose turns actually changed.
    if (scope.kind === 'all') {
      reconcileAllSessions(db);
    } else {
      reconcileSessionsByIds(db, Array.from(touchedSessionIds));
    }
  };

  const tx = db.transaction(() => {
    runRecompute();
    if (dryRun) throw new DryRunRollback();
  });

  try {
    tx();
  } catch (e) {
    if (!(e instanceof DryRunRollback)) throw e;
    // Expected: dry-run rolls back all writes; counters captured before throw.
  }

  return {
    mode: 'default',
    scope,
    dryRun,
    total: rows.length,
    updated,
    unchanged,
    zeroedBefore,
    zeroedAfter,
  };
};

// ---------------------------------------------------------------------------
// prefer-otel mode (unchanged semantics; dry-run added)
// ---------------------------------------------------------------------------

const recomputeOtelCosts = (dryRun: boolean): RecomputeSummary => {
  const db = getDb();
  const otelCosts = getOtelCostBySession(db);
  const storedRows = db
    .prepare('SELECT id, total_cost_usd_otel FROM sessions')
    .all() as Array<{ id: string; total_cost_usd_otel: number | null }>;
  const stored = new Map<string, number | null>();
  for (const r of storedRows) {
    stored.set(r.id, r.total_cost_usd_otel);
  }

  const update = db.prepare(
    'UPDATE sessions SET total_cost_usd_otel = ? WHERE id = ?',
  );

  let updatedOtelCosts = 0;
  let unchangedOtelCosts = 0;
  const EPS = 5e-7;

  const runUpdates = (): void => {
    for (const [sessionId, cost] of otelCosts) {
      if (!stored.has(sessionId)) continue;
      const current = stored.get(sessionId) ?? null;
      if (current !== null && Math.abs(current - cost) <= EPS) {
        unchangedOtelCosts += 1;
        continue;
      }
      update.run(cost, sessionId);
      updatedOtelCosts += 1;
    }
  };

  const tx = db.transaction(() => {
    runUpdates();
    if (dryRun) throw new DryRunRollback();
  });

  try {
    tx();
  } catch (e) {
    if (!(e instanceof DryRunRollback)) throw e;
  }

  return {
    mode: 'prefer-otel',
    dryRun,
    totalOtelSessions: otelCosts.size,
    updatedOtelCosts,
    unchangedOtelCosts,
  };
};

// ---------------------------------------------------------------------------
// recalibrate mode (unchanged; dry-run added)
// ---------------------------------------------------------------------------

const recalibrate = (dryRun: boolean): RecomputeSummary => {
  const db = getDb();

  if (dryRun) {
    // recomputeCostCalibration mutates outside a single transaction (legacy
    // contract); skip the actual call under dry-run to avoid partial writes,
    // and report the would-be summary with zeros to signal nothing changed.
    return {
      mode: 'recalibrate',
      dryRun: true,
      familiesWritten: 0,
      skippedOutOfBounds: 0,
    };
  }

  const result = recomputeCostCalibration(db);
  return {
    mode: 'recalibrate',
    dryRun: false,
    familiesWritten: result.familiesWritten,
    skippedOutOfBounds: result.skippedOutOfBounds,
  };
};

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export function recomputeCosts(opts: RecomputeOpts): RecomputeSummary {
  const parsed = toParsedArgs(opts);
  if (parsed.mode === 'error') {
    throw new Error(`recomputeCosts: ${parsed.reason}`);
  }
  if (parsed.mode === 'recalibrate') return recalibrate(parsed.dryRun);
  if (parsed.mode === 'prefer-otel') return recomputeOtelCosts(parsed.dryRun);
  return recomputeTurnsDefault(parsed.scope, parsed.dryRun);
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

const USAGE = `Usage:
  pnpm recompute-cost --all                  Recompute every session's turn costs
  pnpm recompute-cost --since YYYY-MM-DD     Recompute sessions started on/after the date
  pnpm recompute-cost --session <ID>         Recompute a single session
  pnpm recompute-cost --prefer-otel          Refresh sessions.total_cost_usd_otel from OTEL
  pnpm recompute-cost --recalibrate          Refresh the cost calibration table

  Add --dry-run to any mode to preview without writing.

  --all / --since / --session are mutually exclusive.
  --session / --since cannot combine with --prefer-otel / --recalibrate.
`;

const printUsage = (): void => {
  process.stderr.write(USAGE);
};

/**
 * Build the log message string for a summary, honoring the dry-run prefix.
 * Extracted so tests can verify REQ-9's `[dry-run]` prefix contract directly
 * without invoking `main()` (which calls `process.exit`).
 */
export const formatSummaryMessage = (summary: RecomputeSummary): string => {
  const prefix = summary.dryRun ? '[dry-run] ' : '';
  return `${prefix}recompute-costs`;
};

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.mode === 'error') {
    log.error('recompute-costs', { error: parsed.reason });
    printUsage();
    process.exit(1);
  }
  // Log the resolved DB path so operator sees which file will be touched.
  // Important for distinguishing the default `data/dashboard.db` from any
  // `DASHBOARD_DB_PATH` override.
  const dbPath = process.env.DASHBOARD_DB_PATH ?? './data/dashboard.db';
  log.info('recompute-costs target db', { dbPath, mode: parsed.mode });
  const summary = recomputeCosts(parsed);
  log.info(formatSummaryMessage(summary), summary);
}

const invokedAsScript =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (invokedAsScript) {
  main();
}
