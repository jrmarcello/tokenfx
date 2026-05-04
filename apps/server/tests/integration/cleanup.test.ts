/**
 * Integration tests for ingestion_log IP cleanup (TASK-16, REQ-27, TC-I-41).
 *
 * Sets `request_ip = NULL` on rows older than 30 days. Idempotent — re-running
 * is a no-op (the WHERE clause excludes already-nulled rows).
 *
 * Postgres-backed via Testcontainers. Skipped when `SKIP_PG_TESTS=1`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closeDb, getDb } from '@/lib/db/client';
import { ingestionLog, orgs, users } from '@/lib/db/schema';
import { cleanupOldIps } from '@/lib/queries/cleanup';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

const MACHINE_ID = '00000000-0000-4000-8000-000000000099';

let testUserId = '';

skipDescribe('cleanupOldIps (Postgres integration)', () => {
  beforeAll(async () => {
    const db = getDb();
    // TRUNCATE CASCADE clears all 9 spec-3 tables before seeding. Sibling
    // integration files (overview, teams, ingest) share the same
    // Testcontainers Postgres instance and seed conflicting rows
    // (`alpha@…`, `bob@…`, etc.). Without this wipe the test is order-
    // sensitive: if a neighbour TRUNCATEs after our seed, `testUserId`
    // points at a deleted row and assertions become silently vacuous.
    await db.execute(sql`TRUNCATE TABLE
      manager_dismissed_anomalies, manager_anomalies, manager_drilldown_audit,
      manager_notifications, team_metrics_daily, cron_runs, org_settings,
      onboarding_redemption_log, onboarding_audit_log, onboarding_invites,
      ingestion_log, model_breakdown_agg, tool_count_agg, sessions_agg,
      cost_calibration_per_user, user_machines, users, teams, orgs
      RESTART IDENTITY CASCADE`);
    const [org] = await db
      .insert(orgs)
      .values({ name: 'CleanupOrg' })
      .returning({ id: orgs.id });
    const [user] = await db
      .insert(users)
      .values({
        orgId: org.id,
        email: 'cleanup@example.com',
        ssoProvider: 'google',
        ssoSubject: 'sub-cleanup',
        role: 'member',
      })
      .returning({ id: users.id });
    testUserId = user.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  afterEach(async () => {
    const db = getDb();
    await db.delete(ingestionLog);
  });

  it('TC-I-41: nulls request_ip on rows older than 30 days, leaves newer rows untouched', async () => {
    const db = getDb();
    const now = Date.now();
    const oldReceivedAt = new Date(now - 31 * 24 * 60 * 60 * 1000); // 31d ago
    const newReceivedAt = new Date(now - 1 * 24 * 60 * 60 * 1000); // 1d ago

    await db.insert(ingestionLog).values([
      {
        userId: testUserId,
        machineId: MACHINE_ID,
        keyId: 'key_old',
        payloadSizeBytes: 100,
        acceptedCount: 1,
        skippedCount: 0,
        rejectedCount: 0,
        requestIp: '203.0.113.0/24',
        receivedAt: oldReceivedAt,
      },
      {
        userId: testUserId,
        machineId: MACHINE_ID,
        keyId: 'key_new',
        payloadSizeBytes: 100,
        acceptedCount: 1,
        skippedCount: 0,
        rejectedCount: 0,
        requestIp: '198.51.100.0/24',
        receivedAt: newReceivedAt,
      },
    ]);

    const result = await cleanupOldIps(db);
    expect(result.rowsUpdated).toBe(1);

    const rows: Array<{ keyId: string; requestIp: string | null }> = await db
      .select({
        keyId: ingestionLog.keyId,
        requestIp: ingestionLog.requestIp,
      })
      .from(ingestionLog)
      .where(eq(ingestionLog.userId, testUserId));

    const byKey = new Map<string, string | null>(
      rows.map((r): [string, string | null] => [r.keyId, r.requestIp]),
    );
    expect(byKey.get('key_old')).toBeNull();
    expect(byKey.get('key_new')).toBe('198.51.100.0/24');
  });

  it('is idempotent — running twice produces the same end-state, second run is a no-op', async () => {
    const db = getDb();
    const oldReceivedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);

    await db.insert(ingestionLog).values({
      userId: testUserId,
      machineId: MACHINE_ID,
      keyId: 'key_idem',
      payloadSizeBytes: 100,
      acceptedCount: 1,
      skippedCount: 0,
      rejectedCount: 0,
      requestIp: '203.0.113.0/24',
      receivedAt: oldReceivedAt,
    });

    const first = await cleanupOldIps(db);
    expect(first.rowsUpdated).toBe(1);

    const second = await cleanupOldIps(db);
    expect(second.rowsUpdated).toBe(0);

    const [row] = await db
      .select({ requestIp: ingestionLog.requestIp })
      .from(ingestionLog)
      .where(eq(ingestionLog.keyId, 'key_idem'));
    expect(row.requestIp).toBeNull();
  });
});
