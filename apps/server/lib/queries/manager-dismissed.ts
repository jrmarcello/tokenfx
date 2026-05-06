/**
 * `performDismissAnomaly()` — manager-dashboard-v2-followups REQ-4..6 (TASK-1).
 *
 * Shared helper for the "dismiss a manager-dashboard anomaly card for 7 days"
 * UPSERT, called from two sites that previously duplicated the SQL inline:
 *
 *   - `app/api/manager/dismiss-anomaly/route.ts` (POST)
 *   - `app/manager/health/dismiss-action.ts` (Server Action)
 *
 * The natural key is `(org_id, manager_user_id, target_user_id, kind)`; on
 * conflict we refresh `dismissed_until = now() + 7d` AND `dismissed_at = now()`
 * so the audit trail reflects the latest action and the row count never grows
 * past 1 for the same tuple.
 *
 * ## Failure-mode contract (mirror `writeAudit`, diverge in the validation flow)
 *
 * `lib/audit/drilldown-audit.ts:writeAudit` is the canonical reference for
 * audit/dismiss-style helpers in this module. Both helpers agree on **how DB
 * failures surface**: a thrown exception that the caller is responsible for
 * catching (route → 500, Server Action → uncaught propagates to the framework
 * boundary). They DIVERGE on the validation flow:
 *
 *   - `writeAudit` does not validate — the route layer enforces the cross-team
 *     gate before calling it; therefore `writeAudit` only ever signals success
 *     vs. DB failure (success = `{ inserted: boolean }`, DB failure = throws).
 *   - `performDismissAnomaly` DOES validate (cross-org guard inline) AND must
 *     surface that validation failure as **controlled flow**, not an exception:
 *     the Route Handler maps it to a 403 JSON response, the Server Action maps
 *     it to a `DismissResult` discriminated union. Throwing for "cross-org"
 *     would force both call sites into try/catch + instanceof checks just to
 *     differentiate "expected business denial" from "infrastructure failure" —
 *     that's exactly the noise the Result pattern exists to remove.
 *
 * Net contract:
 *
 *   - Validation/auth error (target missing or in another org) → returns
 *     `{ ok: false, code: 'cross-org' }`. NEVER throws. NEVER writes a row.
 *   - Same-org happy path → returns `{ ok: true }` after a successful UPSERT.
 *   - DB failure (connection drop, constraint violation other than the
 *     ON CONFLICT path, etc.) → THROWS. The caller is responsible for the
 *     try/catch if they need a non-500 surface; today neither call site adds
 *     one (the Next.js framework converts the throw to a 500, which is the
 *     correct outcome for "the database is unhealthy").
 *
 * ## Single source of truth for the TTL
 *
 * `DISMISS_DURATION_MS` lives here. The two call sites previously each
 * declared their own `DISMISS_DURATION_MS` constant — drift risk on any
 * future TTL change (or addition of a new dismiss site) is precisely what
 * extracting this helper resolves. Future call sites import the constant;
 * tests pin it (TC-U-01 companion `expect(DISMISS_DURATION_MS).toBe(...)`).
 *
 * ## Layering and security
 *
 * Authorization (manager / admin role + valid session) is the caller's job —
 * this helper assumes the caller has already validated `session.user.role`
 * and `session.user.orgId`. It performs ONLY the cross-org guard on the
 * target user, because that check requires a DB lookup against `users` and
 * is identical across both call sites.
 *
 * SQL is parameter-bound via Drizzle's query builder
 * (`db.insert(...).values(...).onConflictDoUpdate(...)`) — REQ-19
 * (parent spec). No raw template-string interpolation of user input.
 */
import { eq, sql } from 'drizzle-orm';
import type { getDb } from '@/lib/db/client';
import { managerDismissedAnomalies, users } from '@/lib/db/schema';

type Db = ReturnType<typeof getDb>;

export type DismissParams = {
  /** Manager's session orgId. Used to enforce the cross-org guard. */
  orgId: string;
  /** Manager's session userId — becomes `manager_user_id` in the row. */
  managerUserId: string;
  /** Dev being dismissed. Re-validated against `users.org_id` here. */
  targetUserId: string;
  /**
   * Anomaly kind tag (e.g. `'spend-spike-30d'`, `'spend-spike-wow'`,
   * `'dropoff-wow'`). The Zod schema at the caller's boundary
   * (`dismissAnomalySchema`) constrains this to a closed enum; the helper
   * accepts a plain `string` because it only forwards the value into the
   * UPSERT — it doesn't make business decisions on it.
   */
  kind: string;
};

export type DismissOutcome =
  | { ok: true }
  | { ok: false; code: 'cross-org' };

/**
 * 7 days TTL for a dismissal — single source of truth shared across both
 * call sites. Future TTL changes happen exactly here.
 */
export const DISMISS_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

export const performDismissAnomaly = async (
  db: Db,
  params: DismissParams,
): Promise<DismissOutcome> => {
  // 1. Cross-org guard. Look up the target user; if they don't exist OR
  // belong to a different org than the manager's session, reject as
  // 'cross-org'. Same status surface for "not found" vs. "wrong org" is
  // intentional — anti-probing (a manager should not be able to test the
  // existence of users in foreign orgs by inspecting the response shape).
  const [target] = await db
    .select({ orgId: users.orgId })
    .from(users)
    .where(eq(users.id, params.targetUserId))
    .limit(1);
  if (!target || target.orgId !== params.orgId) {
    return { ok: false, code: 'cross-org' };
  }

  // 2. Idempotent UPSERT on (org_id, manager_user_id, target_user_id, kind).
  // ON CONFLICT refreshes `dismissed_until` to a fresh now+7d so re-clicks
  // extend the silence window, AND `dismissed_at = now()` so the most recent
  // action is timestamped accurately. Drizzle binds every value as a
  // parameter — no SQL injection surface.
  const dismissedUntil = new Date(Date.now() + DISMISS_DURATION_MS);
  await db
    .insert(managerDismissedAnomalies)
    .values({
      orgId: params.orgId,
      managerUserId: params.managerUserId,
      targetUserId: params.targetUserId,
      kind: params.kind,
      dismissedUntil,
    })
    .onConflictDoUpdate({
      target: [
        managerDismissedAnomalies.orgId,
        managerDismissedAnomalies.managerUserId,
        managerDismissedAnomalies.targetUserId,
        managerDismissedAnomalies.kind,
      ],
      set: {
        dismissedUntil,
        dismissedAt: sql`now()`,
      },
    });

  return { ok: true };
};
