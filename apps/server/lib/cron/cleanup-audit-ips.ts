/**
 * Daily cleanup cron — TWO operations wrapped in a single `cron_runs` row:
 *
 *   1. **REQ-15 IP retention**: `manager_drilldown_audit.ip_address_trunc`
 *      is set to NULL on rows whose `viewed_at` is older than 30 days. The
 *      truncated /24 IPv4 (or /48 IPv6) is retained for short-term
 *      forensics and then nulled to honor the privacy ceiling. Idempotent:
 *      already-null rows are excluded by the predicate.
 *
 *   2. **Notification prune**: rows in `manager_notifications` with
 *      `enqueued_at` older than 90 days are DELETEd regardless of status
 *      (prevents unbounded growth — see retention note in DDL). Idempotent:
 *      re-running on the same day finds no eligible rows.
 *
 * Invoked by `POST /api/internal/cron/cleanup-audit-ips`. The route name is
 * kept for compatibility; this handler now covers both operations.
 *
 * The whole invocation is bracketed by a `cron_runs` row:
 *   - INSERT 'running' before any work.
 *   - UPDATE to 'ok' (with rows_written = ipsCleared + notificationsDeleted)
 *     on success, or 'failed' (with error_message) on any thrown error.
 *
 * Raw `db.execute(sql\`...\`)` is used instead of Drizzle's query builder so
 * we can read `rowCount` directly from `pg`'s response and avoid the cost of
 * `RETURNING id` for what is fundamentally a bulk maintenance query.
 */
import { sql } from 'drizzle-orm';
import { cronRuns } from '@/lib/db/schema';
import type { getDb } from '@/lib/db/client';

type Db = ReturnType<typeof getDb>;

export type CleanupAuditIpsResult =
  | {
      status: 'ok';
      ipsCleared: number;
      notificationsDeleted: number;
      error?: undefined;
    }
  | {
      status: 'failed';
      ipsCleared: number;
      notificationsDeleted: number;
      error: string;
    };

const JOB_NAME = 'cleanup-audit-ips';

/**
 * Run both cleanup operations and write a single `cron_runs` row tracking
 * the invocation. Never throws — failures are reflected in the returned
 * status. The route handler maps the result to a JSON response shape.
 */
export const cleanupAuditIps = async (
  db: Db,
): Promise<CleanupAuditIpsResult> => {
  // 1) Open the cron_runs row in 'running' state. We capture the id so the
  // closing UPDATE targets exactly this invocation (concurrent cron runs
  // would each get their own row — no row-level contention).
  const [run] = await db
    .insert(cronRuns)
    .values({ jobName: JOB_NAME, status: 'running' })
    .returning({ id: cronRuns.id });
  const runId = run.id;

  let ipsCleared = 0;
  let notificationsDeleted = 0;

  try {
    // 2) IP retention — null out ip_address_trunc on rows older than 30d.
    // Predicate excludes already-null rows so re-runs are no-ops.
    const ipUpdate = await db.execute(sql`
      UPDATE manager_drilldown_audit
      SET ip_address_trunc = NULL
      WHERE viewed_at < now() - interval '30 days'
        AND ip_address_trunc IS NOT NULL
    `);
    ipsCleared = ipUpdate.rowCount ?? 0;

    // 3) Notification prune — delete rows older than 90d.
    const notifDelete = await db.execute(sql`
      DELETE FROM manager_notifications
      WHERE enqueued_at < now() - interval '90 days'
    `);
    notificationsDeleted = notifDelete.rowCount ?? 0;

    // 4) Close cron_runs row as 'ok'. rows_written tracks total work.
    await db.execute(sql`
      UPDATE cron_runs
      SET status = 'ok',
          rows_written = ${ipsCleared + notificationsDeleted},
          finished_at = now()
      WHERE id = ${runId}
    `);

    return { status: 'ok', ipsCleared, notificationsDeleted };
  } catch (err) {
    // Never echo full error chains to the cron_runs table — the column is
    // text but operators read it; a one-line summary is enough. Stack traces
    // belong in the logger (caller's responsibility).
    const message = err instanceof Error ? err.message : 'unknown error';
    try {
      await db.execute(sql`
        UPDATE cron_runs
        SET status = 'failed',
            rows_written = ${ipsCleared + notificationsDeleted},
            finished_at = now(),
            error_message = ${message}
        WHERE id = ${runId}
      `);
    } catch {
      // If the failure-bookkeeping write itself fails (e.g. DB connection
      // dropped), there is nothing more we can do here. Surfacing the
      // original error in the result is more useful than masking it with
      // a secondary failure.
    }
    return {
      status: 'failed',
      ipsCleared,
      notificationsDeleted,
      error: message,
    };
  }
};
