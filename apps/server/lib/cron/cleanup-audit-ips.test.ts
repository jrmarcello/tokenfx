/**
 * Integration tests for the daily cleanup cron (TASK-CRON-CLEANUP).
 *
 * Two operations, both idempotent, wrapped in a single `cron_runs` row:
 *  1. REQ-15 IP retention — `manager_drilldown_audit.ip_address_trunc` is
 *     nulled for rows whose `viewed_at` is older than 30 days.
 *  2. Notification prune — rows in `manager_notifications` with
 *     `enqueued_at` older than 90 days are deleted (regardless of status).
 *
 * Postgres-backed via Testcontainers. Skipped when `SKIP_PG_TESTS=1`.
 *
 * TC coverage:
 *   - TC-I-42: IP cleanup — 31d row nulled, 29d row untouched.
 *   - TC-I-43: idempotency — second run reports zero work, end-state unchanged.
 *   - TC-I-79: notification prune — 91d row deleted, 89d row present.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closeDb, getDb } from '@/lib/db/client';
import {
  cronRuns,
  managerDrilldownAudit,
  managerNotifications,
  orgs,
  users,
} from '@/lib/db/schema';
import { cleanupAuditIps } from './cleanup-audit-ips';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

let testOrgId = '';
let managerUserId = '';
let targetUserId = '';

const daysAgo = (days: number): Date =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000);

const dateOnly = (d: Date): string => d.toISOString().slice(0, 10);

skipDescribe('cleanupAuditIps (Postgres integration)', () => {
  beforeAll(async () => {
    const db = getDb();
    // Wipe all spec-3 + spec-2 manager tables to avoid cross-file seed
    // collisions. Same pattern used in cleanup.test.ts; tests share a single
    // Testcontainers Postgres instance, so we cannot rely on file-local
    // isolation alone.
    await db.execute(sql`TRUNCATE TABLE
      manager_dismissed_anomalies, manager_anomalies, manager_drilldown_audit,
      manager_notifications, team_metrics_daily, cron_runs, org_settings,
      onboarding_redemption_log, onboarding_audit_log, onboarding_invites,
      ingestion_log, model_breakdown_agg, tool_count_agg, sessions_agg,
      cost_calibration_per_user, user_machines, users, teams, orgs
      RESTART IDENTITY CASCADE`);

    const [org] = await db
      .insert(orgs)
      .values({ name: 'CleanupCronOrg' })
      .returning({ id: orgs.id });
    testOrgId = org.id;

    const [manager] = await db
      .insert(users)
      .values({
        orgId: testOrgId,
        email: 'manager-cleanup@example.com',
        ssoProvider: 'google',
        ssoSubject: 'sub-manager-cleanup',
        role: 'manager',
      })
      .returning({ id: users.id });
    managerUserId = manager.id;

    const [target] = await db
      .insert(users)
      .values({
        orgId: testOrgId,
        email: 'target-cleanup@example.com',
        ssoProvider: 'google',
        ssoSubject: 'sub-target-cleanup',
        role: 'member',
      })
      .returning({ id: users.id });
    targetUserId = target.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  afterEach(async () => {
    const db = getDb();
    // Order matters only loosely; both tables FK to users/orgs which we keep.
    await db.delete(managerDrilldownAudit);
    await db.delete(managerNotifications);
    await db.delete(cronRuns);
  });

  it('TC-I-42: nulls ip_address_trunc on rows older than 30d, leaves newer rows untouched', async () => {
    const db = getDb();
    const oldViewedAt = daysAgo(31);
    const newViewedAt = daysAgo(29);

    await db.insert(managerDrilldownAudit).values([
      {
        orgId: testOrgId,
        managerUserId,
        targetUserId,
        reason: 'training-check',
        sourceRoute: '/manager/check-in/old',
        ipAddressTrunc: '10.0.0.0/24',
        viewedOn: dateOnly(oldViewedAt),
        viewedAt: oldViewedAt,
      },
      {
        orgId: testOrgId,
        managerUserId,
        targetUserId,
        reason: 'quota-investigation',
        sourceRoute: '/manager/check-in/new',
        ipAddressTrunc: '10.0.1.0/24',
        viewedOn: dateOnly(newViewedAt),
        viewedAt: newViewedAt,
      },
    ]);

    const result = await cleanupAuditIps(db);
    expect(result.status).toBe('ok');
    expect(result.ipsCleared).toBe(1);
    expect(result.notificationsDeleted).toBe(0);
    expect(result.error).toBeUndefined();

    const rows: Array<{ sourceRoute: string; ipAddressTrunc: string | null }> =
      await db
        .select({
          sourceRoute: managerDrilldownAudit.sourceRoute,
          ipAddressTrunc: managerDrilldownAudit.ipAddressTrunc,
        })
        .from(managerDrilldownAudit)
        .where(eq(managerDrilldownAudit.orgId, testOrgId));

    const byRoute = new Map<string, string | null>(
      rows.map((r): [string, string | null] => [r.sourceRoute, r.ipAddressTrunc]),
    );
    expect(byRoute.get('/manager/check-in/old')).toBeNull();
    expect(byRoute.get('/manager/check-in/new')).toBe('10.0.1.0/24');

    // cron_runs row written with status='ok' and rows_written = ips + notifs.
    const runs = await db
      .select({
        jobName: cronRuns.jobName,
        status: cronRuns.status,
        rowsWritten: cronRuns.rowsWritten,
        finishedAt: cronRuns.finishedAt,
      })
      .from(cronRuns)
      .where(eq(cronRuns.jobName, 'cleanup-audit-ips'));
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('ok');
    expect(runs[0].rowsWritten).toBe(1);
    expect(runs[0].finishedAt).not.toBeNull();
  });

  it('TC-I-43: idempotent — second run reports zero work, end-state unchanged', async () => {
    const db = getDb();
    const oldViewedAt = daysAgo(31);

    await db.insert(managerDrilldownAudit).values({
      orgId: testOrgId,
      managerUserId,
      targetUserId,
      reason: 'training-check',
      sourceRoute: '/manager/check-in/idem',
      ipAddressTrunc: '10.0.2.0/24',
      viewedOn: dateOnly(oldViewedAt),
      viewedAt: oldViewedAt,
    });

    const first = await cleanupAuditIps(db);
    expect(first.status).toBe('ok');
    expect(first.ipsCleared).toBe(1);
    expect(first.notificationsDeleted).toBe(0);

    const second = await cleanupAuditIps(db);
    expect(second.status).toBe('ok');
    expect(second.ipsCleared).toBe(0);
    expect(second.notificationsDeleted).toBe(0);

    const [row] = await db
      .select({ ipAddressTrunc: managerDrilldownAudit.ipAddressTrunc })
      .from(managerDrilldownAudit)
      .where(eq(managerDrilldownAudit.sourceRoute, '/manager/check-in/idem'));
    expect(row.ipAddressTrunc).toBeNull();

    // Two cron_runs rows now (one per invocation), both 'ok'.
    const runs = await db
      .select({ status: cronRuns.status, rowsWritten: cronRuns.rowsWritten })
      .from(cronRuns)
      .where(eq(cronRuns.jobName, 'cleanup-audit-ips'));
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.status === 'ok')).toBe(true);
  });

  it('TC-I-79: deletes manager_notifications rows older than 90d, keeps newer ones', async () => {
    const db = getDb();
    const oldEnqueuedAt = daysAgo(91);
    const newEnqueuedAt = daysAgo(89);

    await db.insert(managerNotifications).values([
      {
        orgId: testOrgId,
        targetUserId,
        template: 'drilldown-viewed',
        payloadJson: { tag: 'old' },
        enqueuedAt: oldEnqueuedAt,
        status: 'pending',
      },
      {
        orgId: testOrgId,
        targetUserId,
        template: 'drilldown-viewed',
        payloadJson: { tag: 'new' },
        enqueuedAt: newEnqueuedAt,
        status: 'pending',
      },
    ]);

    const result = await cleanupAuditIps(db);
    expect(result.status).toBe('ok');
    expect(result.ipsCleared).toBe(0);
    expect(result.notificationsDeleted).toBe(1);

    const remaining: Array<{ payloadJson: unknown }> = await db
      .select({ payloadJson: managerNotifications.payloadJson })
      .from(managerNotifications)
      .where(eq(managerNotifications.orgId, testOrgId));
    expect(remaining).toHaveLength(1);
    const payload = remaining[0].payloadJson as { tag: string };
    expect(payload.tag).toBe('new');

    // rows_written reflects total work (ips + notifs).
    const runs = await db
      .select({ rowsWritten: cronRuns.rowsWritten })
      .from(cronRuns)
      .where(eq(cronRuns.jobName, 'cleanup-audit-ips'));
    expect(runs).toHaveLength(1);
    expect(runs[0].rowsWritten).toBe(1);
  });
});
