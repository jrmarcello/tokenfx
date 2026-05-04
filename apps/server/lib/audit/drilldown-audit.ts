/**
 * `writeAudit()` — manager-dashboard-v2 REQ-15 / REQ-16 (TASK-AUDIT-LIB).
 *
 * Idempotent UPSERT into `manager_drilldown_audit`, keyed on the UNIQUE
 * `(manager_user_id, target_user_id, viewed_on, reason)` constraint. The
 * function returns `{ inserted: boolean }` derived from
 * `RETURNING (xmax = 0) AS inserted`:
 *
 *   - `xmax = 0` → row was a real INSERT (first view of the day for this
 *     reason) → caller (route layer in TASK-DRILLDOWN-PAGE) enqueues a
 *     REQ-16 notification for the target dev.
 *   - `xmax > 0` → ON CONFLICT DO UPDATE no-op (same-day refresh / link
 *     re-clicked) → caller does NOT enqueue a notification. Refreshes are
 *     silent (REQ-16).
 *
 * The UPDATE branch refreshes `viewed_at` and `ip_address_trunc` so the
 * audit row reflects the most recent observation. Everything else
 * (manager, target, reason, viewed_on, source_route, org, reason_text)
 * is part of the natural identity of the row — the UNIQUE constraint
 * guarantees they never need to mutate.
 *
 * ## Why raw SQL
 *
 * Drizzle's `.returning()` on `.insert(...).onConflictDoUpdate(...)` does
 * not surface Postgres SYSTEM columns like `xmax`. The `xmax` column is
 * the heap-tuple visibility marker: `0` for a row that THIS transaction
 * just inserted, the inserting xid for a row touched by ON CONFLICT
 * UPDATE. We need that boolean to drive REQ-16's notification gate, and
 * we need it inline (not a follow-up SELECT — a follow-up cannot tell
 * you whether the upsert was an INSERT or an UPDATE without racing).
 *
 * Hence we drop to `tx.execute(sql\`...\`)` — Drizzle's `sql` template
 * tag binds every interpolated value as a parameter (REQ-19), so SQL
 * injection is impossible despite the raw-SQL framing. Same pattern as
 * `apps/server/lib/queries/redeem.ts` for `SELECT ... FOR UPDATE`.
 *
 * ## Layering and security
 *
 * This helper does NOT enforce the cross-team / cross-org gate (REQ-9).
 * That gate lives in the drilldown route handler (TASK-DRILLDOWN-PAGE),
 * which checks team membership BEFORE calling `writeAudit`. By the time
 * we reach this function, the caller has already authorized the request
 * — `writeAudit` faithfully writes whatever `AuditContext` it receives.
 *
 * Defense in depth: the migration (TASK-MIGRATIONS) adds RLS column
 * grants on `manager_drilldown_audit` so the `app_runtime` role can
 * INSERT and SELECT, UPDATE only `viewed_at`/`ip_address_trunc`, and
 * never DELETE. Even if a bug elsewhere tries to mutate the row's
 * identity, the database refuses.
 */
import { sql } from 'drizzle-orm';
import type { getDb } from '@/lib/db/client';

type Db = ReturnType<typeof getDb>;
type DrizzleTx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Either the top-level Drizzle handle or a transaction handle. */
export type AuditExecutor = Db | DrizzleTx;

/**
 * Closed list of reason tags (REQ-15, item 7). The `reason_text`
 * free-text column is REQUIRED only when reason === 'other' — that
 * validation lives at the route's Zod boundary (TASK-ZOD), not here.
 */
export type AuditReason =
  | 'training-check'
  | 'quota-investigation'
  | 'cost-investigation'
  | 'other';

export type AuditContext = {
  orgId: string;
  managerUserId: string;
  targetUserId: string;
  reason: AuditReason;
  reasonText: string | null;
  sourceRoute: string;
  /** /24 IPv4 or /48 IPv6 truncated CIDR string; null when unknown. */
  ipAddressTrunc: string | null;
  /** 'YYYY-MM-DD' UTC — server-side date so refresh-at-midnight is safe. */
  viewedOn: string;
};

export type WriteAuditResult = {
  /**
   * `true` when the row was a real INSERT (first view of the day for
   * this manager/target/reason). `false` when ON CONFLICT DO UPDATE
   * fired (same-day refresh). REQ-16 notification gate: only enqueue
   * when `inserted === true`.
   */
  inserted: boolean;
};

type ExecRows = { rows: { inserted: boolean }[] };

/**
 * Insert a drilldown audit row, or update `viewed_at`/`ip_address_trunc`
 * if the same (manager, target, day, reason) tuple already exists.
 *
 * MUST be called from a context that's already authorized the
 * cross-team / cross-org gate. Pass either the top-level db handle or
 * a Drizzle transaction handle — when called from inside a transaction
 * (the canonical drilldown-route pattern: `db.transaction(async tx =>
 * { await writeAudit(tx, ctx); await fetchDevData(tx, devId); })`),
 * audit + data fetch are atomic. Audit failure → tx rollback → no data
 * leak (REQ-15, TC-I-27).
 */
export const writeAudit = async (
  exec: AuditExecutor,
  ctx: AuditContext,
): Promise<WriteAuditResult> => {
  const result = await exec.execute(sql`
    INSERT INTO manager_drilldown_audit
      (org_id, manager_user_id, target_user_id, reason, reason_text,
       source_route, ip_address_trunc, viewed_on)
    VALUES
      (${ctx.orgId}, ${ctx.managerUserId}, ${ctx.targetUserId},
       ${ctx.reason}, ${ctx.reasonText}, ${ctx.sourceRoute},
       ${ctx.ipAddressTrunc}, ${ctx.viewedOn})
    ON CONFLICT (manager_user_id, target_user_id, viewed_on, reason)
    DO UPDATE
      SET viewed_at = now(),
          ip_address_trunc = EXCLUDED.ip_address_trunc
    RETURNING (xmax = 0) AS inserted
  `);

  // node-postgres returns `{ rows: [...] }`; pg-array drivers return rows[].
  // Drizzle's `tx.execute` is the former in our setup, but be defensive.
  const rows = Array.isArray(result)
    ? (result as unknown as { inserted: boolean }[])
    : ((result as unknown as ExecRows).rows ?? []);
  return { inserted: rows[0]?.inserted ?? false };
};
