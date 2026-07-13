/**
 * retention-prune: daily deletion of time-series rows older than the retention
 * window (default 24 months). Spec: .specs/data-retention-policy.md (REQ-1..3).
 *
 * `sessions_agg` + its three session-keyed child tables are pruned inside a
 * single transaction (delete parent, then anti-join sweep the children) so a
 * mid-run crash can never leave orphans visible to standalone child-table
 * aggregations. Every other table is an individually idempotent DELETE.
 *
 * `manager_notifications` is intentionally NOT pruned here — the existing
 * `cleanup-audit-ips` cron already deletes it at a tighter 90-day window.
 *
 * Auth + cron_runs telemetry mirror `cleanup-audit-ips`.
 */
import { and, eq, lt, ne, sql } from 'drizzle-orm';
import type { getDb } from '@/lib/db/client';
import { log } from '@tokenfx/shared/logger';
import {
  authEventLog,
  cronRuns,
  ingestionLog,
  managerAnomalies,
  managerDismissedAnomalies,
  managerDrilldownAudit,
  modelBreakdownAgg,
  onboardingAuditLog,
  onboardingRedemptionLog,
  sessionOutcomesAgg,
  sessionsAgg,
  teamMetricsDaily,
  teamOutcomesDaily,
  toolCountAgg,
} from '@/lib/db/schema';

type Db = ReturnType<typeof getDb>;
type DrizzleTx = Parameters<Parameters<Db['transaction']>[0]>[0];

const DEFAULT_MONTHS = 24;
const MIN_MONTHS = 12;
const JOB_NAME = 'retention-prune';

/**
 * Resolve the retention window from env. Fail-safe: unset → 24; anything below
 * MIN_MONTHS (12) or non-integer → 24 with a loud warn. A stray
 * `RETENTION_MONTHS=1` would otherwise mass-delete almost everything across ALL
 * orgs — the floor makes a typo non-destructive.
 */
export const resolveRetentionMonths = (env: Record<string, string | undefined>): number => {
  const raw = env.RETENTION_MONTHS;
  if (raw === undefined || raw === '') return DEFAULT_MONTHS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_MONTHS) {
    log.warn('retention-prune: invalid RETENTION_MONTHS, falling back to default', {
      raw,
      fallback: DEFAULT_MONTHS,
      minMonths: MIN_MONTHS,
    });
    return DEFAULT_MONTHS;
  }
  return n;
};

const cutoffFor = (months: number): Date => {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d;
};

const dateOnly = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * The direct-delete tables (everything except the transactional sessions
 * group). Each entry knows how to delete its own stale rows and returns the
 * row count. Table/column names are static literals — no user input.
 */
type DirectDelete = (db: Db | DrizzleTx, cutoff: Date) => Promise<number>;

const DIRECT_DELETE_TABLES: ReadonlyArray<readonly [string, DirectDelete]> = [
  ['team_metrics_daily', async (db, c) =>
    (await db.delete(teamMetricsDaily).where(lt(teamMetricsDaily.day, dateOnly(c))).returning({ o: teamMetricsDaily.orgId })).length],
  ['team_outcomes_daily', async (db, c) =>
    (await db.delete(teamOutcomesDaily).where(lt(teamOutcomesDaily.day, dateOnly(c))).returning({ o: teamOutcomesDaily.orgId })).length],
  ['ingestion_log', async (db, c) =>
    (await db.delete(ingestionLog).where(lt(ingestionLog.receivedAt, c)).returning({ id: ingestionLog.id })).length],
  ['onboarding_redemption_log', async (db, c) =>
    (await db.delete(onboardingRedemptionLog).where(lt(onboardingRedemptionLog.receivedAt, c)).returning({ id: onboardingRedemptionLog.id })).length],
  ['auth_event_log', async (db, c) =>
    (await db.delete(authEventLog).where(lt(authEventLog.occurredAt, c)).returning({ id: authEventLog.id })).length],
  ['manager_drilldown_audit', async (db, c) =>
    (await db.delete(managerDrilldownAudit).where(lt(managerDrilldownAudit.viewedAt, c)).returning({ id: managerDrilldownAudit.id })).length],
  ['manager_anomalies', async (db, c) =>
    (await db.delete(managerAnomalies).where(lt(managerAnomalies.createdAt, c)).returning({ id: managerAnomalies.id })).length],
  // NOTE: cutoff column is `dismissed_at` (creation), NEVER `dismissed_until`
  // (a near-future expiry that would make rows never prune).
  ['manager_dismissed_anomalies', async (db, c) =>
    (await db.delete(managerDismissedAnomalies).where(lt(managerDismissedAnomalies.dismissedAt, c)).returning({ o: managerDismissedAnomalies.orgId })).length],
  ['onboarding_audit_log', async (db, c) =>
    (await db.delete(onboardingAuditLog).where(lt(onboardingAuditLog.occurredAt, c)).returning({ id: onboardingAuditLog.id })).length],
] as const;

// Runs OUTSIDE any transaction by design — each direct-delete table is
// individually idempotent (a partial failure is completed by the next run).
// Do NOT assume this participates in the sessions-group transaction.
export type DeleteTableFn = (name: string, cutoff: Date) => Promise<number>;

export type RetentionPruneDeps = {
  /** Override a single table's delete (tests inject a throwing stub). */
  deleteTable?: DeleteTableFn;
  /**
   * Override the transactional sessions-group prune (tests inject a stub that
   * deletes then throws, to prove the transaction rolls back).
   */
  pruneSessionGroup?: (tx: DrizzleTx, cutoff: Date) => Promise<Record<string, number>>;
};

export type RetentionPruneResult = {
  status: 'ok' | 'failed';
  deletedByTable: Record<string, number>;
  /** Total rows deleted across all tables — single source of truth. */
  rowsWritten: number;
  errorMessage?: string;
};

/** Transactional prune of sessions_agg + anti-join sweep of its child tables. */
const defaultPruneSessionGroup = async (
  tx: DrizzleTx,
  cutoff: Date,
): Promise<Record<string, number>> => {
  const sessions = await tx
    .delete(sessionsAgg)
    .where(lt(sessionsAgg.startedAt, cutoff))
    .returning({ u: sessionsAgg.userId, s: sessionsAgg.sessionId });

  const sweep = async (
    child: typeof modelBreakdownAgg | typeof toolCountAgg | typeof sessionOutcomesAgg,
  ): Promise<number> => {
    const res = await tx.execute(sql`
      DELETE FROM ${child} c
      WHERE NOT EXISTS (
        SELECT 1 FROM ${sessionsAgg} s
        WHERE s.user_id = c.user_id AND s.session_id = c.session_id
      )
    `);
    return res.rowCount ?? 0;
  };

  return {
    sessions_agg: sessions.length,
    model_breakdown_agg: await sweep(modelBreakdownAgg),
    tool_count_agg: await sweep(toolCountAgg),
    session_outcomes_agg: await sweep(sessionOutcomesAgg),
  };
};

/**
 * Prune all time-series tables older than `months`. Opens a `cron_runs` row,
 * runs the transactional sessions group then each direct-delete table, and
 * closes the row 'ok'/'failed'. Returns per-table counts.
 */
export const runRetentionPrune = async (
  db: Db,
  opts: { months: number },
  deps: RetentionPruneDeps = {},
): Promise<RetentionPruneResult> => {
  const cutoff = cutoffFor(opts.months);
  log.info('retention-prune: starting', { months: opts.months, cutoff: cutoff.toISOString() });

  const [run] = await db
    .insert(cronRuns)
    .values({ jobName: JOB_NAME, status: 'running' })
    .returning({ id: cronRuns.id });
  const runId = run.id;

  const deletedByTable: Record<string, number> = {};
  const pruneSessionGroup = deps.pruneSessionGroup ?? defaultPruneSessionGroup;
  const deleteTable: DeleteTableFn =
    deps.deleteTable ??
    (async (name, c) => {
      const entry = DIRECT_DELETE_TABLES.find(([n]) => n === name);
      if (!entry) throw new Error(`retention-prune: unknown table ${name}`);
      return entry[1](db, c);
    });

  try {
    // 1) Atomic sessions group.
    const grp = await db.transaction((tx) => pruneSessionGroup(tx, cutoff));
    Object.assign(deletedByTable, grp);

    // 2) Direct-delete tables, each individually idempotent.
    for (const [name] of DIRECT_DELETE_TABLES) {
      deletedByTable[name] = await deleteTable(name, cutoff);
    }

    // 3) cron_runs itself — old rows, but never the in-flight 'running' row.
    const cronDeleted = await db
      .delete(cronRuns)
      .where(and(lt(cronRuns.startedAt, cutoff), ne(cronRuns.status, 'running')))
      .returning({ id: cronRuns.id });
    deletedByTable.cron_runs = cronDeleted.length;

    const total = Object.values(deletedByTable).reduce((a, b) => a + b, 0);
    await db
      .update(cronRuns)
      .set({ status: 'ok', rowsWritten: total, finishedAt: new Date() })
      .where(eq(cronRuns.id, runId));

    log.info('retention-prune: done', { deletedByTable });
    return { status: 'ok', deletedByTable, rowsWritten: total };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    const total = Object.values(deletedByTable).reduce((a, b) => a + b, 0);
    try {
      await db
        .update(cronRuns)
        .set({ status: 'failed', rowsWritten: total, finishedAt: new Date(), errorMessage: message })
        .where(eq(cronRuns.id, runId));
    } catch {
      // Bookkeeping write failed too (e.g. connection dropped) — nothing more
      // to do; the thrown error is more useful than masking it.
    }
    log.error('retention-prune: failed', { message });
    return { status: 'failed', deletedByTable, rowsWritten: total, errorMessage: message };
  }
};
