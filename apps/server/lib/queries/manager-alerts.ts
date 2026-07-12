/**
 * Manager-facing alert queries — first-auto-provision banner state
 * (central-server-onboarding-v2-sso manager-ui spec, REQ-1, REQ-2; TASK-5).
 *
 * # Scope
 *
 * Exposes a query/mutation pair that the manager dashboard uses to render
 * (and dismiss) the "developer auto-onboarded via SSO" banner:
 *
 *   - `loadFirstAutoProvisionAlert(db, orgId, managerId)` — reads
 *     `onboarding_redemption_log` rows with `method='sso-auto'` that
 *     belong to `orgId` (resolved via the JOIN
 *     `redemption_log.token_prefix → onboarding_invites.token →
 *     onboarding_invites.org_id`) AND that this specific manager has not
 *     yet acknowledged. Returns `null` when there are zero unacked events.
 *
 *   - `acknowledgeAlert(db, managerId, kind, eventId, orgId)` — idempotent
 *     INSERT into `manager_alert_acks` with ON CONFLICT DO NOTHING + an
 *     org-scope predicate (`WHERE EXISTS (... AND i.org_id = $orgId)`).
 *     The ON-CONFLICT branch preserves the FIRST `acked_at` timestamp —
 *     that is the forensic invariant ("when did each admin FIRST see this
 *     event"), so subsequent re-acks are silent no-ops by design.
 *     The org predicate atomically encodes the invariant "ack only if
 *     the event belongs to this org" — a tampered form payload pointing
 *     at a cross-org event_id is silently rejected (0 rows inserted)
 *     WITHOUT leaking the fact that the event exists in another org.
 *     Security context: `.specs/fix-manager-alert-ack-org-scoping.md`
 *     (closes M2 from PAUSE 2 of the manager-ui spec).
 *
 *     **Predicate scope**: the current `WHERE EXISTS` is valid ONLY for
 *     `alert_kind = 'first-auto-provision'` (it joins via the redemption-
 *     log → invite → org chain). If a future alert kind is added whose
 *     events do NOT originate from `onboarding_redemption_log`, DO NOT
 *     extend this function — introduce a new function OR add a
 *     `switch (alertKind)` choosing the correct predicate.
 *
 *   - `formatBannerCount(count)` — pure helper for unit tests + the UI
 *     copy. Maps `0 → null`, `1 → singular`, `N > 1 → plural`.
 *
 * # Role enforcement
 *
 * These functions are **thin DB helpers**. They DO NOT check the caller's
 * role. Decisão #14 (`spec §"Decisions already locked"`) places the
 * `manager | admin` gate in the page/Server Action layer (also enforced by
 * the middleware role gate at the route boundary). Defense-in-depth REQ-3
 * is implemented in the Server Action that wraps these calls — see TASK-7.
 *
 * # 7-day window
 *
 * REQ-1 phrases the banner as "developer was auto-onboarded via SSO in
 * the last 7 days". Spec discipline note: the cutoff is enforced HERE so
 * the page never needs to filter again. Older events remain in
 * `onboarding_redemption_log` for the audit-log view (REQ-4) but do not
 * surface in the banner.
 *
 * # Privacy
 *
 * The query returns only the first 8 characters of `email_hash`. Full
 * hashes never reach the UI; the prefix is a coarse signal for "is this
 * the same person as the event I saw an hour ago".
 */
import { and, desc, eq, gte, sql } from 'drizzle-orm';

import { managerAlertAcks, onboardingInvites, onboardingRedemptionLog } from '@/lib/db/schema';
import type { getDb } from '@/lib/db/client';

type Db = ReturnType<typeof getDb>;

/** Window enforced by `loadFirstAutoProvisionAlert` for banner inclusion. */
const BANNER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The discriminator for the single alert kind shipped in this spec. The DB
 * CHECK constraint on `manager_alert_acks.alert_kind` enforces the same
 * value at the schema layer; this TS literal catches typos at the call site.
 */
export type AlertKind = 'first-auto-provision';

export type FirstAutoProvisionEvent = {
  /** Matches `onboarding_redemption_log.id` (bigserial). */
  eventId: number;
  receivedAt: Date;
  /** First 8 chars of the peppered email hash. Full hash never reaches the UI. */
  emailHashPrefix: string;
  /** OIDC provider key (`google`, `microsoft`, …). NULL only for legacy rows. */
  ssoProvider: string | null;
};

export type FirstAutoProvisionAlert = {
  count: number;
  events: ReadonlyArray<FirstAutoProvisionEvent>;
  /** Convenience alias for `events[0].receivedAt` (events are DESC-ordered). */
  latestAt: Date;
};

/**
 * Load the unacknowledged first-auto-provision events visible to one
 * manager for one org, within the last 7 days. Returns `null` when there
 * are zero such events (signals the UI to render no banner).
 *
 * Role enforcement is the caller's responsibility — see module docstring.
 */
export const loadFirstAutoProvisionAlert = async (
  db: Db,
  orgId: string,
  managerId: string,
): Promise<FirstAutoProvisionAlert | null> => {
  const cutoff = new Date(Date.now() - BANNER_WINDOW_MS);

  // Anti-join via NOT IN (SELECT event_id FROM manager_alert_acks WHERE
  // manager_user_id = $managerId AND alert_kind = 'first-auto-provision').
  // Expressed as a Drizzle subquery so the parameterization is preserved
  // and the planner can use the `idx_manager_alert_acks_user_kind` covering
  // index on (manager_user_id, alert_kind).
  const ackedEventIdsSubquery = db
    .select({ eventId: managerAlertAcks.eventId })
    .from(managerAlertAcks)
    .where(
      and(
        eq(managerAlertAcks.managerUserId, managerId),
        eq(managerAlertAcks.alertKind, 'first-auto-provision'),
      ),
    );

  // The JOIN on `redemption_log.token_prefix = invites.token_prefix`
  // uses the index `idx_onboarding_invites_prefix` on the physical
  // `token_prefix` column (declared in `lib/db/schema.ts`), so it is index-backed.
  const rows = await db
    .select({
      eventId: onboardingRedemptionLog.id,
      receivedAt: onboardingRedemptionLog.receivedAt,
      emailHash: onboardingRedemptionLog.emailHash,
      ssoProvider: onboardingRedemptionLog.ssoProvider,
    })
    .from(onboardingRedemptionLog)
    .innerJoin(
      onboardingInvites,
      eq(onboardingRedemptionLog.tokenPrefix, onboardingInvites.tokenPrefix),
    )
    .where(
      and(
        eq(onboardingRedemptionLog.method, 'sso-auto'),
        eq(onboardingInvites.orgId, orgId),
        gte(onboardingRedemptionLog.receivedAt, cutoff),
        sql`${onboardingRedemptionLog.id} NOT IN ${ackedEventIdsSubquery}`,
      ),
    )
    .orderBy(desc(onboardingRedemptionLog.receivedAt));

  if (rows.length === 0) return null;

  const events: FirstAutoProvisionEvent[] = rows.map((r) => ({
    eventId: r.eventId,
    receivedAt: r.receivedAt,
    emailHashPrefix: r.emailHash.slice(0, 8),
    ssoProvider: r.ssoProvider,
  }));

  return {
    count: events.length,
    events,
    latestAt: events[0].receivedAt,
  };
};

/**
 * Idempotent INSERT into `manager_alert_acks` with org-scope predicate.
 *
 * Composite primary key `(manager_user_id, alert_kind, event_id)` combined
 * with `ON CONFLICT DO NOTHING` guarantees:
 *
 *   - First call writes a row with `acked_at = now()`.
 *   - Subsequent calls with the same triple are no-ops; `acked_at` of the
 *     existing row is preserved (forensic invariant).
 *
 * The `WHERE EXISTS` predicate enforces "event belongs to `orgId`":
 *
 *   INSERT ... SELECT ... WHERE EXISTS (
 *     SELECT 1 FROM onboarding_redemption_log r
 *     JOIN onboarding_invites i ON r.token_prefix = i.token_prefix
 *     WHERE r.id = $eventId AND i.org_id = $orgId
 *   ) ON CONFLICT DO NOTHING
 *
 * - Predicate false (cross-org event_id) → INSERT inserts 0 rows; caller
 *   receives no error.
 * - ON CONFLICT (re-ack of legitimate event) → also 0 rows; identical
 *   shape from the caller's perspective (idempotent contract preserved).
 * - The two rejection paths look identical to the caller — silent ignore
 *   is deliberate (info-leak primitive avoidance — see security context
 *   in module docstring).
 *
 * SQL is parameterized via Drizzle's `sql` tag (no string interpolation
 * of values). Pattern precedent: `lib/queries/overview.ts`,
 * `lib/cron/cleanup-audit-ips.ts` both use `db.execute(sql\`...\`)`.
 *
 * Role gating is the Server Action's job (see module docstring).
 *
 * @param orgId — the manager's org. The caller (Server Action) reads
 *   this from `session.user.orgId`. Pass an empty string to deliberately
 *   reject (fail-safe), but the action's auth-narrow MUST reject missing
 *   orgId before this function is called.
 */
export const acknowledgeAlert = async (
  db: Db,
  managerId: string,
  alertKind: AlertKind,
  eventId: number,
  orgId: string,
): Promise<void> => {
  // Fail-safe: empty orgId would crash Postgres on `''::uuid`. The
  // Server Action's auth-narrow guarantees orgId is non-empty before
  // this point, but defensive early-return preserves silent-ignore
  // semantics for any future caller that drops the guard.
  if (orgId.length === 0) {
    return;
  }
  // The `::uuid` / `::bigint` casts after each `${...}` binding are
  // required because the SELECT has no FROM clause — Postgres cannot
  // infer the target column types from a placeholder alone. The casts
  // make the bound parameter types explicit. Drizzle's `sql` tag still
  // parameterizes the value; the cast is appended to the placeholder.
  await db.execute(sql`
    INSERT INTO manager_alert_acks (manager_user_id, alert_kind, event_id)
    SELECT ${managerId}::uuid, ${alertKind}, ${eventId}::bigint
    WHERE EXISTS (
      SELECT 1
      FROM onboarding_redemption_log r
      JOIN onboarding_invites i ON r.token_prefix = i.token_prefix
      WHERE r.id = ${eventId}::bigint
        AND i.org_id = ${orgId}::uuid
    )
    ON CONFLICT (manager_user_id, alert_kind, event_id) DO NOTHING
  `);
};

/**
 * Pure helper for banner copy. Returns `null` when there are zero
 * unacknowledged events (the UI uses the null to skip rendering entirely),
 * the singular phrase for `1`, and the plural phrase for any `N > 1`.
 *
 * Negative inputs are coerced to `null` (defensive — the count is
 * computed by `loadFirstAutoProvisionAlert`, which never returns negative,
 * but a stray caller passing `-1` should not break the UI).
 */
export const formatBannerCount = (count: number): string | null => {
  if (!Number.isFinite(count) || count <= 0) return null;
  if (count === 1) {
    return '1 developer was auto-onboarded via SSO in the last 7 days';
  }
  return `${count} developers were auto-onboarded via SSO in the last 7 days`;
};

