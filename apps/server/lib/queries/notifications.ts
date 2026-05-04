/**
 * `enqueueNotification` queue lib + `NotificationChannel` DI seam —
 * manager-dashboard-v2 REQ-16 / TASK-NOTIFICATION (Q9 lock).
 *
 * ## Why a DB-backed queue stub
 *
 * Spec 1 didn't lock a notification channel. Rather than block REQ-16 on
 * a phantom email/Slack worker, we land a **DB-backed stub queue**: rows
 * written here with `status='pending'` are picked up by a follow-up
 * delivery spec. Tests query `manager_notifications` directly (NO mock
 * channel — Q9 lock; aligns with the project rule of hand-written stubs).
 *
 * ## DI seam (Q9 lock)
 *
 * The drilldown route accepts an optional `notifyChannel` parameter
 * defaulting to `dbBackedNotificationChannel`. Route tests inject a
 * plain object literal matching `NotificationChannel`:
 *
 * ```ts
 * const captured: EnqueueNotificationParams[] = [];
 * const stub: NotificationChannel = {
 *   enqueue: async (_tx, p) => { captured.push(p); },
 * };
 * await GET(req, { params, notifyChannel: stub });
 * ```
 *
 * Same DI pattern as `redeem.ts`'s `hashFn` seam (bcrypt). No mocking
 * frameworks; no `vi.mock`.
 *
 * ## Layering — call-site gating
 *
 * This lib is a thin INSERT. It does NOT read
 * `org_settings.drilldown_notification_enabled` and does NOT inspect the
 * `inserted` boolean returned by `writeAudit`. Both are the caller's
 * responsibility (the drilldown route handler in TASK-DRILLDOWN-PAGE):
 *
 *   1. The route calls `writeAudit(tx, ctx)` → `{ inserted }`.
 *   2. If `inserted === false` (same-day refresh, ON CONFLICT no-op) →
 *      do NOT call `enqueueNotification` (REQ-16 silent-refresh rule;
 *      TC-I-45).
 *   3. If `org_settings.drilldown_notification_enabled === false` →
 *      do NOT call `enqueueNotification` (TC-I-30).
 *   4. Otherwise → call `enqueueNotification(tx, params)` with the
 *      caller-prepared `managerName` (typically
 *      `displayLabelFor(manager)` from `@/lib/util/user-display`).
 *
 * Keeping the gate at the call site means this lib is trivially
 * testable and the gating logic stays visible in route code review.
 *
 * ## Failure semantics (TC-I-53)
 *
 * If the INSERT fails (e.g., FK violation on `target_user_id`), the
 * error propagates. The route wraps the call in a post-response
 * try/catch — REQ-16 mandates "best-effort enqueue: don't block manager
 * UX on notification deliverability". Logged via structured `warn`,
 * never `error`, since drilldown UX has already succeeded.
 */
import { managerNotifications } from '@/lib/db/schema';
import type { getDb } from '@/lib/db/client';

type DrizzleDb = ReturnType<typeof getDb>;
type DrizzleTx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

/**
 * Either the top-level Drizzle handle or a transaction handle. Mirrors
 * `AuditExecutor` in `lib/audit/drilldown-audit.ts` so the route can
 * pass the same `tx` to both within a single `db.transaction(...)`.
 */
export type AuditExecutor = DrizzleDb | DrizzleTx;

/**
 * Closed list of notification templates. Exactly one member today; the
 * union exists so future templates (e.g. anomaly-detected, quota-breach)
 * are forced to update this file and the type forces call sites to
 * narrow.
 */
export type NotificationTemplate = 'MANAGER_DRILLDOWN_VIEW';

/**
 * Payload schema for `MANAGER_DRILLDOWN_VIEW`. Fields chosen to match
 * the locked notification body in REQ-16:
 *
 *   "Your manager {managerName} viewed your usage on {viewedOn} for
 *    reason: {reasonHumanReadable}{reasonTextSuffixIfProvided}."
 *
 * `managerName` is the caller-resolved display string (typically
 * `displayLabelFor(manager)`). `viewedOn` is `YYYY-MM-DD` UTC matching
 * the audit row. `reasonText` MUST be present iff `reason === 'other'`
 * — that constraint is enforced at the route's Zod boundary, not here.
 */
export type DrilldownViewPayload = {
  managerName: string;
  viewedOn: string;
  reason: 'training-check' | 'quota-investigation' | 'cost-investigation' | 'other';
  reasonText?: string;
};

export type EnqueueNotificationParams = {
  orgId: string;
  targetUserId: string;
  template: NotificationTemplate;
  payload: DrilldownViewPayload;
};

/**
 * The DI seam (Q9 lock). The drilldown route accepts an optional
 * `notifyChannel: NotificationChannel` parameter and falls back to
 * `dbBackedNotificationChannel`. Tests inject a typed stub.
 */
export interface NotificationChannel {
  enqueue(exec: AuditExecutor, params: EnqueueNotificationParams): Promise<void>;
}

/**
 * Default channel — INSERTs a `pending` row into `manager_notifications`
 * via Drizzle. `payload_json` is `jsonb`, so Drizzle handles the
 * serialization; the parsed object round-trips on read.
 *
 * `status` and `enqueuedAt` use schema-level defaults (`'pending'` and
 * `now()` respectively) so we don't redundantly set them here. A future
 * delivery worker flips `status` to `'sent'` or `'failed'` and stamps
 * `delivered_at` / `error_message`.
 */
export const dbBackedNotificationChannel: NotificationChannel = {
  enqueue: async (exec, params) => {
    await exec.insert(managerNotifications).values({
      orgId: params.orgId,
      targetUserId: params.targetUserId,
      template: params.template,
      payloadJson: params.payload,
    });
  },
};
