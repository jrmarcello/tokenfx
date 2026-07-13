/**
 * Shared drilldown render helper for `/manager/check-in/[devId]` and
 * `/manager/devs/[devId]` (TASK-DRILLDOWN-PAGE of
 * `.specs/manager-dashboard-v2.md`).
 *
 * Both routes execute identical logic — auth + role gate, devId UUID
 * validation, Zod-validated `reason` query params, cross-team / cross-org
 * authorization, atomic `writeAudit + dev queries` transaction, then
 * post-response notification enqueue. Only the `sourceRoute` constant
 * differs. Co-locating the logic here (under the `_drilldown/` prefix
 * which Next.js excludes from the routing tree) avoids duplication and
 * keeps the route entry points trivial.
 *
 * # Server Component pattern (B11 lock from the spec)
 *
 *   - Missing/invalid `reason` → `redirect('/manager/health?error=...')`.
 *     Server Components cannot return HTTP error codes idiomatically; the
 *     redirect lands on `/manager/health` with an `?error=...` banner.
 *   - Cross-team / cross-org devId, or `devId` not in `users` →
 *     `notFound()` (Next.js 15 — renders the colocated `not-found.tsx`).
 *   - Audit insert failure → throws → bubbles to `error.tsx` (no dev
 *     data leaks; the audit + data fetch share a single Drizzle
 *     transaction so the rollback is atomic — REQ-15).
 *
 * # Notification enqueue (REQ-16)
 *
 *   - Only when `writeAudit` returns `inserted: true` (real INSERT, not
 *     ON CONFLICT no-op). Same-day refresh = silent (TC-I-45).
 *   - Only when the org's `org_settings.drilldown_notification_enabled`
 *     is not `false` (default `true` row OR row missing → enqueue).
 *   - Wrapped in `next/server`'s `after()` so the manager UX never
 *     blocks on notification deliverability (REQ-16: "Enqueueing happens
 *     after the response is sent — best-effort"). Failures inside
 *     `after()` are caught and logged at `warn` level (TC-I-53; route
 *     still returns 200).
 */
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { after } from 'next/server';
import { eq } from 'drizzle-orm';
import type { Session } from 'next-auth';
import { log as logger } from '@tokenfx/shared/logger';
// `auth` is lazy-loaded inside `loadDrilldownData` (default `authFn` path)
// so vitest doesn't pull next-auth into integration tests that inject
// `opts.authFn`. Mirrors the `lazyDefaultAuth` pattern in
// `app/api/manager/dismiss-anomaly/route.ts`.
import { writeAudit, type AuditContext } from '@/lib/audit/drilldown-audit';
import { getDb } from '@/lib/db/client';
import { orgSettings, users } from '@/lib/db/schema';
import {
  getDevSessionList,
  getDevSpendDetail,
  getDevToolUsage,
  type DevSessionRow,
  type DevSpendDetail,
  type DevToolUsage,
} from '@/lib/queries/manager-drilldown';
import {
  dbBackedNotificationChannel,
  type EnqueueNotificationParams,
  type NotificationChannel,
} from '@/lib/queries/notifications';
import { truncateIpForAudit } from '@/lib/util/ip';
import { displayLabelFor } from '@/lib/util/user-display';
import { drilldownParamsSchema } from '@/lib/zod/manager-v2-schemas';

/**
 * RFC 4122 UUID syntactic check. We accept any version since Postgres'
 * `uuid` type does the same — a syntactically valid UUID that doesn't
 * exist in `users` falls through to `notFound()` (TC-I-58).
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: string): boolean => UUID_RE.test(value);

/**
 * Best-effort extraction of the request IP. Reads `x-forwarded-for` (the
 * first comma-separated value is the client) and falls back to
 * `x-real-ip`. Returns the truncated CIDR string or `null` if no header
 * is present / parseable (TC-I-41 — null is a valid value, no crash).
 */
const extractTruncatedIp = async (): Promise<string | null> => {
  // `headers()` throws "outside a request scope" in vitest integration
  // tests (no request) — treat as a missing-IP scenario, matching
  // TC-I-41's null-valid contract. Production (Next.js request) always
  // has a scope.
  let h: Awaited<ReturnType<typeof headers>>;
  try {
    h = await headers();
  } catch {
    return null;
  }
  const forwarded = h.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) {
      const truncated = truncateIpForAudit(first);
      if (truncated) return truncated;
    }
  }
  const realIp = h.get('x-real-ip');
  if (realIp) {
    const truncated = truncateIpForAudit(realIp.trim());
    if (truncated) return truncated;
  }
  return null;
};

/** UTC `YYYY-MM-DD` — server-side date so the day-rollover is safe. */
const todayUtc = (): string => new Date().toISOString().slice(0, 10);

/** Closed map from reason tag → human-readable string for the notification body. */
const REASON_HUMAN: Record<AuditContext['reason'], string> = {
  'training-check': 'training check',
  'quota-investigation': 'quota investigation',
  'cost-investigation': 'cost investigation',
  other: 'other',
};

export type DrilldownData = {
  manager: { id: string; displayLabel: string; email: string };
  dev: { id: string; displayLabel: string; email: string; teamId: string | null };
  reason: AuditContext['reason'];
  reasonText: string | null;
  spend: DevSpendDetail | null;
  sessions: DevSessionRow[];
  tools: DevToolUsage;
};

/**
 * DI seam for the auth boundary. Tests inject a hand-written stub
 * returning a fake `Session`; production uses the lazy `auth()` import.
 * Mirrors the pattern in `app/api/manager/dismiss-anomaly/route.ts`.
 */
export type AuthFn = () => Promise<Session | null>;

/**
 * DI seam for `next/server`'s `after`. Tests inject either an executing
 * stub `(cb) => { void cb(); }` (run callback synchronously) or a
 * capturing stub `(_cb) => {}` (verify "registered N times" without
 * side-effects). Production uses the imported `after`.
 */
export type AfterFn = typeof after;

export type RenderDrilldownOptions = {
  /**
   * The route file's source path used to attribute each audit row to the
   * entry point that triggered it. Locked to one of the two drilldown
   * routes so logs / queries can filter by surface.
   */
  sourceRoute: '/manager/check-in/[devId]' | '/manager/devs/[devId]';
  /**
   * DI seam (Q9 lock) — tests inject a typed stub. Defaults to the
   * DB-backed channel which inserts a `pending` row into
   * `manager_notifications`.
   */
  notifyChannel?: NotificationChannel;
  /**
   * DI seam for the auth boundary. Default = lazy `auth()` import.
   * Tests inject a stub session function.
   */
  authFn?: AuthFn;
  /**
   * DI seam for `next/server`'s `after()`. Default = imported `after`.
   * Tests inject either an executing or capturing variant — see
   * `tests/integration/drilldown-notification.test.ts`.
   */
  afterFn?: AfterFn;
};

/**
 * Resolve auth, validate inputs, write the audit row, fetch the dev's
 * data, and (best-effort, after response) enqueue the REQ-16
 * notification. Returns the data payload for the caller's `page.tsx` to
 * render — the route file is then a thin presentational wrapper.
 *
 * Throws `redirect()` / `notFound()` (Next.js sentinel errors) for the
 * various early-exit branches; the framework unwinds them into the
 * appropriate response. Non-sentinel errors (e.g. audit insert failure)
 * propagate to the route's `error.tsx`.
 */
export const loadDrilldownData = async (
  rawDevId: string,
  rawSearchParams: { reason?: string; reasonText?: string },
  opts: RenderDrilldownOptions,
): Promise<DrilldownData> => {
  // 1. Auth + role gate (defense in depth — the layout already enforces
  //    this, but Server Components must not assume the layout ran).
  //    `opts.authFn` is the DI seam (tests inject a stub); production
  //    lazy-loads `auth()` from `@/lib/auth/auth` to keep next-auth out
  //    of vitest's module graph for tests that bypass the seam.
  const session = opts.authFn
    ? await opts.authFn()
    : await (async (): Promise<Session | null> => {
        const mod = await import('@/lib/auth/auth');
        return mod.auth();
      })();
  if (!session?.user?.id || !session.user.orgId) {
    redirect('/api/auth/signin');
  }
  const role = session.user.role;
  if (role !== 'manager' && role !== 'admin') {
    redirect('/manager');
  }
  const managerUserId = session.user.id;
  const orgId = session.user.orgId;

  // 2. devId syntactic validation. Non-UUID → redirect (TC-I-57).
  if (!isUuid(rawDevId)) {
    redirect('/manager/health?error=invalid-dev');
  }

  // 3. Reason / reasonText validation via the locked Zod schema.
  //    Distinct redirect targets for the three failure modes so the
  //    health-page banner can render specific copy (TC-I-20..25).
  const parsed = drilldownParamsSchema.safeParse({
    reason: rawSearchParams.reason,
    reasonText: rawSearchParams.reasonText,
    devId: rawDevId,
  });
  if (!parsed.success) {
    const issues = parsed.error.issues;
    const hasReasonIssue = issues.some(
      (i) => i.path.length > 0 && i.path[0] === 'reason',
    );
    const hasReasonTextIssue = issues.some(
      (i) => i.path.length > 0 && i.path[0] === 'reasonText',
    );
    if (hasReasonIssue) {
      redirect('/manager/health?error=missing-reason');
    }
    if (hasReasonTextIssue) {
      // Discriminate "missing" vs "wrong length" so the banner can
      // surface the right copy. `reason === 'other'` with no reasonText
      // → missing; with too-short / too-long reasonText → invalid.
      if (
        rawSearchParams.reason === 'other' &&
        (rawSearchParams.reasonText == null || rawSearchParams.reasonText === '')
      ) {
        redirect('/manager/health?error=missing-reason-text');
      }
      redirect('/manager/health?error=invalid-reason-text');
    }
    redirect('/manager/health?error=missing-reason');
  }
  const { reason, reasonText: parsedReasonText } = parsed.data;
  // Per TC-U-36 lock: reasonText is silently ignored when reason !== 'other'.
  const reasonTextForAudit: string | null =
    reason === 'other' ? (parsedReasonText ?? null) : null;

  // 4. Resolve the manager + target dev. Cross-team / cross-org →
  //    notFound() per REQ-15 (TC-I-28). devId not in users → notFound()
  //    per TC-I-58.
  const db = getDb();
  const managerRows = await db
    .select({
      id: users.id,
      orgId: users.orgId,
      teamId: users.teamId,
      email: users.email,
      displayName: users.displayName,
    })
    .from(users)
    .where(eq(users.id, managerUserId))
    .limit(1);
  if (managerRows.length === 0 || managerRows[0].orgId !== orgId) {
    // Manager record went missing or its org drifted from the JWT —
    // treat as auth failure rather than a 404 leak.
    redirect('/api/auth/signin');
  }
  const manager = managerRows[0];

  const devRows = await db
    .select({
      id: users.id,
      orgId: users.orgId,
      teamId: users.teamId,
      email: users.email,
      displayName: users.displayName,
    })
    .from(users)
    .where(eq(users.id, rawDevId))
    .limit(1);
  if (devRows.length === 0) {
    notFound();
  }
  const dev = devRows[0];

  // Cross-org leak guard (TC-I-36): even an admin in org A cannot
  // drilldown a user belonging to org B.
  if (dev.orgId !== orgId) {
    notFound();
  }

  // Cross-team check is intentionally absent: spec lock (line 14) — a
  // manager-role user manages their **entire org**, every team within it.
  // Admins also have org-wide visibility. The cross-org guard above is
  // the single isolation point. TC-I-28 (cross-team within different
  // org) is covered by the cross-org check; cross-team within the SAME
  // org is permitted by design.
  void role;

  // 5. Atomic transaction — audit row written BEFORE any dev data
  //    fetched, both within a single Drizzle transaction. Audit failure
  //    → tx rollback → no data leak (TC-I-27).
  const ipAddressTrunc = await extractTruncatedIp();
  const viewedOn = todayUtc();
  const auditCtx: AuditContext = {
    orgId,
    managerUserId: manager.id,
    targetUserId: dev.id,
    reason,
    reasonText: reasonTextForAudit,
    sourceRoute: opts.sourceRoute,
    ipAddressTrunc,
    viewedOn,
  };

  const result = await db.transaction(async (tx) => {
    const audit = await writeAudit(tx, auditCtx);
    const [spend, sessions, tools] = await Promise.all([
      getDevSpendDetail(tx, auditCtx, { userId: dev.id, days: 30 }),
      getDevSessionList(tx, auditCtx, { userId: dev.id, days: 30 }),
      getDevToolUsage(tx, auditCtx, { userId: dev.id, days: 30 }),
    ]);
    return { audit, spend, sessions, tools };
  });

  // 6. Notification enqueue (REQ-13..16, manager-dashboard-v2-followups).
  //    The `org_settings.drilldown_notification_enabled` read is hoisted
  //    BEFORE `afterFn(...)` so the gate is evaluated synchronously; if
  //    the toggle is OFF (or this read throws), `afterFn` is NEVER
  //    registered. Only on `result.audit.inserted === true` AND
  //    `notifyEnabled === true` do we schedule the post-response
  //    `channel.enqueue` via the DI-seam `afterFn` (default = `after`
  //    from `next/server`).
  if (result.audit.inserted) {
    // Hoisted read: REQ-13 (sync gate) + REQ-15b (missing row → default
    // ON, matches Q9 lock of parent spec). Errors propagate to the
    // caller (TC-I-20) — `after()` is never registered.
    const settingsRows = await db
      .select({ enabled: orgSettings.drilldownNotificationEnabled })
      .from(orgSettings)
      .where(eq(orgSettings.orgId, orgId))
      .limit(1);
    const notifyEnabled = settingsRows[0]?.enabled !== false;

    if (notifyEnabled) {
      const channel = opts.notifyChannel ?? dbBackedNotificationChannel;
      const managerDisplay = displayLabelFor({
        display_name: manager.displayName,
        email: manager.email,
      });
      const enqueueParams: EnqueueNotificationParams = {
        orgId,
        targetUserId: dev.id,
        template: 'MANAGER_DRILLDOWN_VIEW',
        payload: {
          managerName: managerDisplay,
          viewedOn,
          reason,
          ...(reasonTextForAudit ? { reasonText: reasonTextForAudit } : {}),
        },
      };

      const afterFn: AfterFn = opts.afterFn ?? after;
      afterFn(async () => {
        try {
          // `after()` runs after the response is flushed, so the request
          // transaction is gone — use the top-level db handle.
          // Failures are best-effort (REQ-16 + TC-I-53): log warn, never
          // re-throw, so a deliverability hiccup never bubbles into the
          // already-returned manager response.
          await channel.enqueue(db, enqueueParams);
        } catch (err) {
          // Privacy: log structured metadata only. Never include the
          // dev's email or PII payload — orgId + targetUserId are
          // sufficient to correlate with the audit row.
          logger.warn('manager_drilldown.notification.enqueue_failed', {
            orgId,
            targetUserId: dev.id,
            template: 'MANAGER_DRILLDOWN_VIEW',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    }
    // notifyEnabled === false → afterFn NOT registered (REQ-15).
  }
  // result.audit.inserted === false (ON CONFLICT no-op, same-day refresh)
  // → afterFn NOT registered (REQ-16, idempotency preserved).

  return {
    manager: {
      id: manager.id,
      displayLabel: displayLabelFor({
        display_name: manager.displayName,
        email: manager.email,
      }),
      email: manager.email,
    },
    dev: {
      id: dev.id,
      displayLabel: displayLabelFor({
        display_name: dev.displayName,
        email: dev.email,
      }),
      email: dev.email,
      teamId: dev.teamId,
    },
    reason,
    reasonText: reasonTextForAudit,
    spend: result.spend,
    sessions: result.sessions,
    tools: result.tools,
  };
};

const formatUsd = (n: number): string =>
  n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const formatCount = (n: number): string => n.toLocaleString('en-US');

/**
 * Render the drilldown page body. Pure presentation — no I/O. The route
 * entry points call `loadDrilldownData` and pass the result here so
 * the markup stays consistent across both surfaces.
 */
export const renderDrilldown = (data: DrilldownData): React.ReactElement => {
  const reasonHuman = REASON_HUMAN[data.reason];
  const totalToolCalls =
    data.tools.Edit +
    data.tools.Read +
    data.tools.Bash +
    data.tools.Agent +
    data.tools.Other;

  return (
    <div data-testid="drilldown-page" className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-bold text-neutral-900 dark:text-neutral-100">
          {data.dev.displayLabel}
        </h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Drilldown reason:{' '}
          <span data-testid="drilldown-reason">{reasonHuman}</span>
          {data.reasonText ? (
            <>
              {' · '}
              <span
                data-testid="drilldown-reason-text"
                className="italic"
              >
                {data.reasonText}
              </span>
            </>
          ) : null}
        </p>
      </header>

      <section
        data-testid="drilldown-spend"
        className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
      >
        <h2 className="mb-2 text-sm font-semibold text-neutral-700 dark:text-neutral-300">
          Spend (last 30 days)
        </h2>
        {data.spend ? (
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-neutral-500 dark:text-neutral-400">30-day total</dt>
              <dd className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
                {formatUsd(data.spend.thirtyDaySpendUsd)}
              </dd>
            </div>
            <div>
              <dt className="text-neutral-500 dark:text-neutral-400">7-day total</dt>
              <dd className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
                {formatUsd(data.spend.sevenDaySpendUsd)}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            No spend data in the last 30 days.
          </p>
        )}
      </section>

      <section
        data-testid="drilldown-sessions"
        className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
      >
        <h2 className="mb-2 text-sm font-semibold text-neutral-700 dark:text-neutral-300">
          Recent sessions ({data.sessions.length})
        </h2>
        {data.sessions.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            No sessions in the last 30 days.
          </p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-neutral-500 dark:text-neutral-400">
              <tr>
                <th className="py-1 pr-2">Started</th>
                <th className="py-1 pr-2">Cost</th>
                <th className="py-1 pr-2">Input</th>
                <th className="py-1 pr-2">Output</th>
                <th className="py-1 pr-2">Cache hit</th>
              </tr>
            </thead>
            <tbody>
              {data.sessions.map((s) => (
                <tr
                  key={s.sessionId}
                  className="border-t border-neutral-100 dark:border-neutral-800"
                >
                  <td className="py-1 pr-2 font-mono text-xs">
                    {s.startedAt.slice(0, 19).replace('T', ' ')}
                  </td>
                  <td className="py-1 pr-2">{formatUsd(s.totalCostUsd)}</td>
                  <td className="py-1 pr-2">{formatCount(s.totalInputTokens)}</td>
                  <td className="py-1 pr-2">{formatCount(s.totalOutputTokens)}</td>
                  <td className="py-1 pr-2">
                    {s.cacheHitRatio == null
                      ? '—'
                      : `${(s.cacheHitRatio * 100).toFixed(1)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section
        data-testid="drilldown-tools"
        className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
      >
        <h2 className="mb-2 text-sm font-semibold text-neutral-700 dark:text-neutral-300">
          Tool mix (last 30 days · {formatCount(totalToolCalls)} calls)
        </h2>
        <dl className="grid grid-cols-2 gap-4 text-sm md:grid-cols-5">
          {(['Edit', 'Read', 'Bash', 'Agent', 'Other'] as const).map((bucket) => (
            <div key={bucket}>
              <dt className="text-neutral-500 dark:text-neutral-400">{bucket}</dt>
              <dd className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
                {formatCount(data.tools[bucket])}
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
};
