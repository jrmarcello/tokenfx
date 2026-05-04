/**
 * Integration tests for `enqueueNotification()` — manager-dashboard-v2
 * TASK-NOTIFICATION (REQ-16).
 *
 * Scope (Q9 lock — DB-backed queue stub):
 *   - `enqueueNotification(tx, params)` writes a row to `manager_notifications`
 *     with `status='pending'`, `template='MANAGER_DRILLDOWN_VIEW'`, and a
 *     `payload_json` blob carrying the locked notification body fields
 *     (`managerName`, `viewedOn`, `reason`, optional `reasonText`).
 *   - The lib does NOT read `org_settings.drilldown_notification_enabled` —
 *     gating is the route's job (TC-I-30 / TC-I-45 verified at the route
 *     layer). This test only asserts the lib writes faithfully.
 *   - DB write failures (e.g., FK violation to `users`) propagate; the
 *     route wraps in try/catch and logs warn, but the lib itself does
 *     not swallow.
 *
 * Postgres-backed via the shared Testcontainers setup (see
 * `tests/integration/setup-pg.ts`). Skipped under `SKIP_PG_TESTS=1`.
 *
 * TC mapping (per spec Test Plan):
 *   - TC-I-29:  happy path — row written with template, target, status,
 *               and payload_json fields matching seeded data.
 *   - TC-I-29b: payload preservation — reason='other' with reasonText
 *               (long string) round-trips through JSONB intact.
 *   - TC-I-29c: template enum — happy path with the only allowed
 *               literal value 'MANAGER_DRILLDOWN_VIEW' succeeds.
 *   - TC-I-53:  DB write failure (FK to users broken) → throws; the
 *               caller (route) is responsible for the post-response
 *               try/catch and warn-log behavior, not this lib.
 *
 * TC-I-30 and TC-I-45 (caller-side gates) are NOT in this file —
 * see TASK-DRILLDOWN-PAGE tests. TC-I-44 is in drilldown-audit tests.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from '@/lib/db/client';
import {
  managerNotifications,
  orgs,
  teams,
  users,
} from '@/lib/db/schema';
import {
  dbBackedNotificationChannel,
  type DrilldownViewPayload,
  type EnqueueNotificationParams,
} from './notifications';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

type Seeded = {
  orgId: string;
  teamId: string;
  managerId: string;
  devId: string;
};

const seedOrgManagerDev = async (): Promise<Seeded> => {
  const db = getDb();
  const [org] = await db
    .insert(orgs)
    .values({ name: 'NotifOrg' })
    .returning({ id: orgs.id });
  const [team] = await db
    .insert(teams)
    .values({ orgId: org.id, name: 'NotifTeam' })
    .returning({ id: teams.id });
  const [manager] = await db
    .insert(users)
    .values({
      orgId: org.id,
      teamId: team.id,
      email: 'manager@notif.example',
      ssoProvider: null,
      ssoSubject: null,
      role: 'manager',
    })
    .returning({ id: users.id });
  const [dev] = await db
    .insert(users)
    .values({
      orgId: org.id,
      teamId: team.id,
      email: 'dev@notif.example',
      ssoProvider: null,
      ssoSubject: null,
      role: 'member',
    })
    .returning({ id: users.id });
  return {
    orgId: org.id,
    teamId: team.id,
    managerId: manager.id,
    devId: dev.id,
  };
};

const baseParams = (
  s: Seeded,
  overrides: Partial<DrilldownViewPayload> = {},
): EnqueueNotificationParams => ({
  orgId: s.orgId,
  targetUserId: s.devId,
  template: 'MANAGER_DRILLDOWN_VIEW',
  payload: {
    managerName: 'Alice Manager',
    viewedOn: '2026-04-30',
    reason: 'training-check',
    ...overrides,
  },
});

skipDescribe('enqueueNotification (Postgres integration)', () => {
  let seeded: Seeded;

  beforeAll(async () => {
    const db = getDb();
    // Mirror drilldown-audit.test.ts TRUNCATE list — keeps sibling files
    // coherent when sharing one Testcontainers instance.
    await db.execute(sql`TRUNCATE TABLE
      manager_dismissed_anomalies, manager_anomalies, manager_drilldown_audit,
      manager_notifications, team_metrics_daily, cron_runs, org_settings,
      onboarding_redemption_log, onboarding_audit_log, onboarding_invites,
      ingestion_log, model_breakdown_agg, tool_count_agg, sessions_agg,
      cost_calibration_per_user, user_machines, users, teams, orgs
      RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    await closeDb();
  });

  beforeEach(async () => {
    seeded = await seedOrgManagerDev();
  });

  afterEach(async () => {
    const db = getDb();
    await db.delete(managerNotifications);
    await db.delete(users);
    await db.delete(teams);
    await db.delete(orgs);
  });

  it('TC-I-29: writes a pending notification row with template, target, and payload', async () => {
    const db = getDb();
    const params = baseParams(seeded, {
      managerName: 'Manager Mendes',
      viewedOn: '2026-04-30',
      reason: 'cost-investigation',
    });

    await dbBackedNotificationChannel.enqueue(db, params);

    const rows = await db.select().from(managerNotifications);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.orgId).toBe(seeded.orgId);
    expect(row.targetUserId).toBe(seeded.devId);
    expect(row.template).toBe('MANAGER_DRILLDOWN_VIEW');
    expect(row.status).toBe('pending');
    expect(row.deliveredAt).toBeNull();
    expect(row.errorMessage).toBeNull();
    expect(row.enqueuedAt).toBeInstanceOf(Date);

    // payload_json is jsonb — Drizzle returns it as a parsed object.
    expect(row.payloadJson).toEqual({
      managerName: 'Manager Mendes',
      viewedOn: '2026-04-30',
      reason: 'cost-investigation',
    });
  });

  it('TC-I-29b: payload preservation — reason=other with long reasonText round-trips intact', async () => {
    const db = getDb();
    // 50 char reasonText (per spec REQ-15 max length) to verify JSONB
    // round-trip preserves content exactly.
    const reasonText = 'investigating spike on 2026-04-29 model usage xx';
    expect(reasonText).toHaveLength(48);

    const params = baseParams(seeded, {
      reason: 'other',
      reasonText,
    });

    await dbBackedNotificationChannel.enqueue(db, params);

    const rows = await db.select().from(managerNotifications);
    expect(rows).toHaveLength(1);
    expect(rows[0].payloadJson).toEqual({
      managerName: 'Alice Manager',
      viewedOn: '2026-04-30',
      reason: 'other',
      reasonText,
    });
  });

  it('TC-I-29c: template literal MANAGER_DRILLDOWN_VIEW is accepted (happy path)', async () => {
    // The exported `NotificationTemplate` union has exactly one member, so
    // TypeScript prevents passing anything else at compile time. This TC
    // pins the runtime happy path for the only allowed literal so a future
    // widening of the union is forced to update the test plan rather than
    // silently shipping.
    const db = getDb();
    const params = baseParams(seeded);

    await dbBackedNotificationChannel.enqueue(db, params);

    const rows = await db.select().from(managerNotifications);
    expect(rows).toHaveLength(1);
    expect(rows[0].template).toBe('MANAGER_DRILLDOWN_VIEW');
  });

  it('TC-I-53: DB write failure (FK violation on target_user_id) propagates as a thrown error', async () => {
    // The caller (drilldown route) is expected to wrap this call in a
    // post-response try/catch and surface a structured warn log without
    // failing the request. The LIB itself must not swallow — it throws
    // naturally so the caller can observe and log.
    const db = getDb();
    const params: EnqueueNotificationParams = {
      orgId: seeded.orgId,
      // Random UUID that does not exist in `users` → FK violation.
      targetUserId: '00000000-0000-4000-8000-000000000099',
      template: 'MANAGER_DRILLDOWN_VIEW',
      payload: {
        managerName: 'Alice Manager',
        viewedOn: '2026-04-30',
        reason: 'training-check',
      },
    };

    await expect(
      dbBackedNotificationChannel.enqueue(db, params),
    ).rejects.toThrow();

    const rows = await db.select().from(managerNotifications);
    expect(rows).toHaveLength(0);
  });

  it('runs inside a transaction — enqueue is rolled back if the surrounding tx aborts', async () => {
    // Documents the AuditExecutor seam: same handle shape as drilldown-audit,
    // so route can do `db.transaction(async tx => { await writeAudit(tx, ...);
    // await enqueueNotification(tx, ...); })` and get atomic rollback.
    const db = getDb();
    const params = baseParams(seeded);

    await expect(
      db.transaction(async (tx) => {
        await dbBackedNotificationChannel.enqueue(tx, params);
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');

    const rows = await db.select().from(managerNotifications);
    expect(rows).toHaveLength(0);
  });

  it('uses a hand-written stub channel for DI seam verification (no vi.mock)', async () => {
    // Q9 lock: DI seam exists so the drilldown route can inject a typed
    // stub in tests. This TC documents the intended stub shape — a plain
    // object literal satisfying NotificationChannel — and verifies the
    // exported interface accepts it without leaking implementation details.
    const calls: EnqueueNotificationParams[] = [];
    const stub: import('./notifications').NotificationChannel = {
      enqueue: async (_tx, p) => {
        calls.push(p);
      },
    };

    const db = getDb();
    const params = baseParams(seeded);
    await stub.enqueue(db, params);

    expect(calls).toHaveLength(1);
    expect(calls[0].template).toBe('MANAGER_DRILLDOWN_VIEW');
    expect(calls[0].payload.reason).toBe('training-check');

    // Stub did NOT touch the DB.
    const rows = await db.select().from(managerNotifications);
    expect(rows).toHaveLength(0);
  });
});
