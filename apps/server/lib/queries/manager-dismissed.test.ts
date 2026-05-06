/**
 * Tests for `performDismissAnomaly()` — manager-dashboard-v2-followups TASK-1.
 *
 * Helper extraction of the dismiss UPSERT logic shared by:
 *   - `app/api/manager/dismiss-anomaly/route.ts` (POST handler)
 *   - `app/manager/health/dismiss-action.ts` (Server Action)
 *
 * Contract (REQ-4..6):
 *   - cross-org / unknown user → returns `{ ok: false, code: 'cross-org' }`
 *     (NEVER throws, NEVER writes a row)
 *   - same-org happy path → UPSERT idempotent on
 *     `(org_id, manager_user_id, target_user_id, kind)`, returns
 *     `{ ok: true }`
 *   - DB failure during the UPSERT → THROWS (mirrors `writeAudit` pattern;
 *     caller is responsible for the catch)
 *
 * TC mapping:
 *   - TC-U-01 (unit, hand-written stub) — cross-org guard short-circuits
 *     before the UPSERT.
 *   - TC-I-03 (integration, happy) — first call writes a row with
 *     `dismissed_until ≈ now+7d`, `dismissed_at ≈ now()`.
 *   - TC-I-04 (integration, idempotency) — re-call refreshes both
 *     timestamps; row count stays at 1.
 *   - TC-I-05 (integration, security) — cross-org target → no row.
 *   - TC-I-06 (integration, edge) — UUID not in `users` → no row.
 *   - TC-I-21 (unit, hand-written stub) — DB error during UPSERT throws.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from '@/lib/db/client';
import { managerDismissedAnomalies, orgs, teams, users } from '@/lib/db/schema';
import {
  DISMISS_DURATION_MS,
  performDismissAnomaly,
  type DismissParams,
} from './manager-dismissed';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

const wipeAll = async (): Promise<void> => {
  const db = getDb();
  await db.execute(sql`TRUNCATE TABLE
    manager_dismissed_anomalies, manager_anomalies, manager_drilldown_audit,
    manager_notifications, team_metrics_daily, cron_runs, org_settings,
    onboarding_redemption_log, onboarding_audit_log, onboarding_invites,
    ingestion_log, model_breakdown_agg, tool_count_agg, sessions_agg,
    cost_calibration_per_user, user_machines, users, teams, orgs
    RESTART IDENTITY CASCADE`);
};

type Seeded = {
  orgAId: string;
  orgBId: string;
  managerAId: string;
  targetAId: string;
  targetBId: string;
};

const seedTwoOrgs = async (): Promise<Seeded> => {
  const db = getDb();
  const [orgA] = await db
    .insert(orgs)
    .values({ name: 'DismissOrgA' })
    .returning({ id: orgs.id });
  const [orgB] = await db
    .insert(orgs)
    .values({ name: 'DismissOrgB' })
    .returning({ id: orgs.id });
  const [teamA] = await db
    .insert(teams)
    .values({ orgId: orgA.id, name: 'TeamA' })
    .returning({ id: teams.id });
  const [teamB] = await db
    .insert(teams)
    .values({ orgId: orgB.id, name: 'TeamB' })
    .returning({ id: teams.id });
  const [managerA] = await db
    .insert(users)
    .values({
      orgId: orgA.id,
      teamId: teamA.id,
      email: 'mgrA@dismiss.example',
      ssoProvider: null,
      ssoSubject: null,
      role: 'manager',
    })
    .returning({ id: users.id });
  const [targetA] = await db
    .insert(users)
    .values({
      orgId: orgA.id,
      teamId: teamA.id,
      email: 'devA@dismiss.example',
      ssoProvider: null,
      ssoSubject: null,
      role: 'member',
    })
    .returning({ id: users.id });
  const [targetB] = await db
    .insert(users)
    .values({
      orgId: orgB.id,
      teamId: teamB.id,
      email: 'devB@dismiss.example',
      ssoProvider: null,
      ssoSubject: null,
      role: 'member',
    })
    .returning({ id: users.id });
  return {
    orgAId: orgA.id,
    orgBId: orgB.id,
    managerAId: managerA.id,
    targetAId: targetA.id,
    targetBId: targetB.id,
  };
};

const countDismissals = async (): Promise<number> => {
  const db = getDb();
  const rows = await db.select().from(managerDismissedAnomalies);
  return rows.length;
};

// ---------------------------------------------------------------------------
// TC-U-01 + TC-I-21: hand-written stub `db` (no testcontainer required).
// ---------------------------------------------------------------------------

describe('performDismissAnomaly (unit, hand-written stubs)', () => {
  it('TC-U-01: returns cross-org and never reaches db.insert when target user is missing', async () => {
    // Stub shape mirrors the call chain `db.select().from().where().limit()`
    // that the helper uses for the cross-org guard. The stub deliberately
    // OMITS `insert` — if the helper's guard regresses and lets the call
    // through, the missing method surfaces as a TypeError and fails the
    // test in a way that's impossible to mistake for a happy path.
    const calls = { selectCount: 0, limitArg: null as number | null };
    const stubDb = {
      select: () => {
        calls.selectCount += 1;
        return {
          from: () => ({
            where: () => ({
              limit: (n: number) => {
                calls.limitArg = n;
                return Promise.resolve([]);
              },
            }),
          }),
        };
      },
    } as unknown as Parameters<typeof performDismissAnomaly>[0];

    const result = await performDismissAnomaly(stubDb, {
      orgId: '00000000-0000-4000-8000-000000000001',
      managerUserId: '00000000-0000-4000-8000-000000000002',
      targetUserId: '00000000-0000-4000-8000-0000000000ff',
      kind: 'spend-spike-30d',
    });

    expect(result).toEqual({ ok: false, code: 'cross-org' });
    expect(calls.selectCount).toBe(1);
    expect(calls.limitArg).toBe(1);
  });

  it('TC-I-21: throws when db.insert rejects during UPSERT (caller responsibility)', async () => {
    // Same select stub as TC-U-01, but this time the lookup returns a
    // same-org row so the helper proceeds to the UPSERT, where `db.insert`
    // is wired to reject. We assert the rejection PROPAGATES (no Result
    // wrapping) — DB failure is exception, not controlled flow. Aligns
    // with `writeAudit` pattern in `lib/audit/drilldown-audit.ts`.
    const dbError = new Error('connection terminated unexpectedly');
    const stubDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () =>
              Promise.resolve([
                { orgId: '00000000-0000-4000-8000-000000000001' },
              ]),
          }),
        }),
      }),
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: () => Promise.reject(dbError),
        }),
      }),
    } as unknown as Parameters<typeof performDismissAnomaly>[0];

    const params: DismissParams = {
      orgId: '00000000-0000-4000-8000-000000000001',
      managerUserId: '00000000-0000-4000-8000-000000000002',
      targetUserId: '00000000-0000-4000-8000-000000000003',
      kind: 'spend-spike-30d',
    };

    await expect(performDismissAnomaly(stubDb, params)).rejects.toThrow(
      'connection terminated unexpectedly',
    );
  });

  it('exposes DISMISS_DURATION_MS = 7 days (single source of truth)', () => {
    // Pin the constant value so callers that previously duplicated it
    // (route.ts, dismiss-action.ts) don't accidentally drift.
    expect(DISMISS_DURATION_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// TC-I-03..06: Postgres-backed integration tests (skipped under SKIP_PG_TESTS).
// ---------------------------------------------------------------------------

skipDescribe('performDismissAnomaly (Postgres integration)', () => {
  let seeded: Seeded;

  beforeAll(async () => {
    await wipeAll();
    seeded = await seedTwoOrgs();
  });

  afterAll(async () => {
    await wipeAll();
    await closeDb();
  });

  it('TC-I-03: same-org happy path writes a row with dismissed_until ≈ now+7d', async () => {
    const db = getDb();
    const before = Date.now();

    const result = await performDismissAnomaly(db, {
      orgId: seeded.orgAId,
      managerUserId: seeded.managerAId,
      targetUserId: seeded.targetAId,
      kind: 'spend-spike-30d',
    });

    expect(result).toEqual({ ok: true });

    const rows = await db.select().from(managerDismissedAnomalies);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.orgId).toBe(seeded.orgAId);
    expect(row.managerUserId).toBe(seeded.managerAId);
    expect(row.targetUserId).toBe(seeded.targetAId);
    expect(row.kind).toBe('spend-spike-30d');

    const expectedUntil = before + DISMISS_DURATION_MS;
    const actualUntil = row.dismissedUntil.getTime();
    // Allow a generous 5s window — captures clock skew between Node.now()
    // and Postgres `now()` plus DB round-trip latency.
    expect(actualUntil).toBeGreaterThanOrEqual(expectedUntil - 1000);
    expect(actualUntil).toBeLessThanOrEqual(expectedUntil + 5000);
    expect(row.dismissedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);

    // Cleanup so TC-I-04 starts from row count = 1 (it re-calls).
    // Actually we rely on sequencing — TC-I-04 re-uses this exact row.
  });

  it('TC-I-04: idempotent re-call refreshes both timestamps; row count stays at 1', async () => {
    const db = getDb();

    const [first] = await db.select().from(managerDismissedAnomalies);
    expect(first).toBeDefined();
    const firstUntil = first.dismissedUntil.getTime();
    const firstAt = first.dismissedAt.getTime();

    // Sleep 10ms so `now()` strictly advances — guarantees a measurable
    // delta on `dismissed_at` and `dismissed_until` after the UPSERT.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = await performDismissAnomaly(db, {
      orgId: seeded.orgAId,
      managerUserId: seeded.managerAId,
      targetUserId: seeded.targetAId,
      kind: 'spend-spike-30d',
    });
    expect(result).toEqual({ ok: true });

    const rows = await db.select().from(managerDismissedAnomalies);
    expect(rows).toHaveLength(1);
    const refreshed = rows[0];
    expect(refreshed.dismissedUntil.getTime()).toBeGreaterThan(firstUntil);
    expect(refreshed.dismissedAt.getTime()).toBeGreaterThan(firstAt);
  });

  it('TC-I-05: cross-org target → cross-org code; no row inserted', async () => {
    const db = getDb();
    const baseline = await countDismissals();

    const result = await performDismissAnomaly(db, {
      orgId: seeded.orgAId,
      managerUserId: seeded.managerAId,
      // targetB belongs to orgB — manager from orgA must be rejected.
      targetUserId: seeded.targetBId,
      kind: 'spend-spike-30d',
    });

    expect(result).toEqual({ ok: false, code: 'cross-org' });
    expect(await countDismissals()).toBe(baseline);
  });

  it('TC-I-06: targetUserId is a valid UUID but does not exist in users → cross-org', async () => {
    const db = getDb();
    const baseline = await countDismissals();

    const result = await performDismissAnomaly(db, {
      orgId: seeded.orgAId,
      managerUserId: seeded.managerAId,
      targetUserId: '00000000-0000-4000-8000-0000000000aa', // not seeded
      kind: 'spend-spike-30d',
    });

    expect(result).toEqual({ ok: false, code: 'cross-org' });
    expect(await countDismissals()).toBe(baseline);
  });
});
