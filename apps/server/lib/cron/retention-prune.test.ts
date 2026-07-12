/**
 * Tests for the 24-month retention prune.
 * Spec: .specs/data-retention-policy.md (REQ-1, REQ-2, REQ-3).
 *
 * Postgres-backed via the shared Testcontainers setup; skipped under
 * SKIP_PG_TESTS=1. Hand-written stubs (deps seams), no mocking framework.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, lt, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { closeDb, getDb } from '@/lib/db/client';
import {
  authEventLog,
  cronRuns,
  ingestionLog,
  managerAnomalies,
  managerDismissedAnomalies,
  managerDrilldownAudit,
  modelBreakdownAgg,
  onboardingAuditLog,
  onboardingRedemptionLog,
  orgs,
  sessionOutcomesAgg,
  sessionsAgg,
  teamMetricsDaily,
  teamOutcomesDaily,
  teams,
  toolCountAgg,
  users,
} from '@/lib/db/schema';
import {
  resolveRetentionMonths,
  runRetentionPrune,
} from './retention-prune';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

const monthsAgo = (m: number): Date => {
  const d = new Date();
  d.setMonth(d.getMonth() - m);
  return d;
};
const dateOnly = (d: Date): string => d.toISOString().slice(0, 10);

const OLD = monthsAgo(25);
const RECENT = monthsAgo(1);

describe('resolveRetentionMonths (TC-U-01)', () => {
  it.each<[string | undefined, number]>([
    [undefined, 24],
    ['', 24],
    ['12', 12],
    ['36', 36],
    ['11', 24], // below floor 12 → fallback
    ['0', 24],
    ['-1', 24],
    ['abc', 24],
  ])('RETENTION_MONTHS=%s → %d', (raw, expected) => {
    expect(resolveRetentionMonths({ RETENTION_MONTHS: raw })).toBe(expected);
  });
});

skipDescribe('runRetentionPrune (Postgres integration)', () => {
  const db = getDb();
  let orgId: string;
  let teamId: string;
  let userId: string;

  const wipe = async (): Promise<void> => {
    await db.execute(sql`TRUNCATE TABLE
      manager_dismissed_anomalies, manager_anomalies, manager_drilldown_audit,
      manager_notifications, team_metrics_daily, team_outcomes_daily, cron_runs,
      onboarding_redemption_log, onboarding_audit_log, onboarding_invites,
      auth_event_log, ingestion_log, model_breakdown_agg, tool_count_agg,
      session_outcomes_agg, sessions_agg, cost_calibration_per_user,
      user_machines, users, teams, orgs
      RESTART IDENTITY CASCADE`);
  };

  beforeEach(async () => {
    await wipe();
    const [org] = await db.insert(orgs).values({ name: 'RetentionOrg' }).returning({ id: orgs.id });
    orgId = org.id;
    const [team] = await db.insert(teams).values({ orgId, name: 'RetTeam' }).returning({ id: teams.id });
    teamId = team.id;
    const [u] = await db.insert(users).values({ orgId, email: 'dev@ret.example', role: 'member' }).returning({ id: users.id });
    userId = u.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  // --- per-table seeders: each inserts one row at `when` -------------------
  const seedSessionAgg = async (when: Date, sessionId: string): Promise<void> => {
    await db.insert(sessionsAgg).values({
      userId, sessionId, payloadHash: randomUUID(), startedAt: when, endedAt: when,
      projectSlug: 'p', totalInputTokens: 1, totalOutputTokens: 1,
      totalCacheReadTokens: 0, totalCacheCreationTokens: 0, totalCostUsd: '0',
      turnCount: 1, toolCallCount: 0,
    });
  };
  const seedTeamMetrics = async (day: Date): Promise<void> => {
    await db.insert(teamMetricsDaily).values({
      orgId, teamId, day: dateOnly(day), cacheHitRatioAvg: '0', goodSessionPct: '0',
      subagentAdoptionPct: '0', compositeAvg: '0', totalSessions: 1, totalDevs: 1,
    });
  };
  const seedTeamOutcomes = async (day: Date): Promise<void> => {
    await db.insert(teamOutcomesDaily).values({
      orgId, teamId, day: dateOnly(day), totalCommits: 0, totalLocAdded: 0,
      totalLocRemoved: 0, totalFilesChanged: 0, totalMergedPrCount: 0,
      totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: '0', sessionsWithOutcome: 0,
    });
  };
  const seedIngestion = async (when: Date): Promise<void> => {
    await db.insert(ingestionLog).values({
      userId, machineId: randomUUID(), keyId: `k_${randomUUID().slice(0, 12)}`,
      payloadSizeBytes: 1, acceptedCount: 1, skippedCount: 0, rejectedCount: 0,
      receivedAt: when,
    });
  };
  const seedRedemption = async (when: Date): Promise<void> => {
    await db.insert(onboardingRedemptionLog).values({
      tokenPrefix: 'abcdef01', emailDomain: 'x', emailHash: 'h', outcome: 'accepted-sso-auto',
      method: 'sso-auto', receivedAt: when,
    });
  };
  const seedAuthEvent = async (when: Date): Promise<void> => {
    await db.insert(authEventLog).values({
      ssoProvider: 'google', iss: 'https://issuer', emailHash: 'h',
      ssoSubjectHash: 'sh', ip: null, city: null, userAgent: null,
      outcome: 'accepted-sso-auto', occurredAt: when,
    });
  };
  const seedDrilldown = async (when: Date): Promise<void> => {
    await db.insert(managerDrilldownAudit).values({
      orgId, managerUserId: userId, targetUserId: userId, reason: 'training-check',
      sourceRoute: '/manager/devs/[devId]', viewedOn: dateOnly(when), viewedAt: when,
    });
  };
  const seedAnomaly = async (when: Date): Promise<void> => {
    await db.insert(managerAnomalies).values({
      orgId, teamId, targetUserId: userId, kind: 'spend-spike-30d',
      detectedOn: dateOnly(when), createdAt: when,
    });
  };
  const seedDismissed = async (
    dismissedAt: Date,
    dismissedUntil: Date,
    kind = 'spend-spike-30d',
  ): Promise<void> => {
    await db.insert(managerDismissedAnomalies).values({
      orgId, managerUserId: userId, targetUserId: userId, kind,
      dismissedUntil, dismissedAt,
    });
  };
  const seedAudit = async (when: Date): Promise<void> => {
    await db.insert(onboardingAuditLog).values({
      orgId, actorUserId: userId, action: 'invite-created', targetTokenPrefix: 'abcdef01',
      occurredAt: when,
    });
  };
  const seedCronRun = async (when: Date): Promise<void> => {
    await db.insert(cronRuns).values({ jobName: 'old-job', status: 'ok', startedAt: when });
  };

  const run = () => runRetentionPrune(db, { months: 24 });

  it('deletes old rows and keeps recent rows across all direct-delete tables (TC-I-01)', async () => {
    await seedSessionAgg(OLD, 's-old');
    await seedSessionAgg(RECENT, 's-new');
    await seedTeamMetrics(OLD); await seedTeamMetrics(RECENT);
    await seedTeamOutcomes(OLD); await seedTeamOutcomes(RECENT);
    await seedIngestion(OLD); await seedIngestion(RECENT);
    await seedRedemption(OLD); await seedRedemption(RECENT);
    await seedAuthEvent(OLD); await seedAuthEvent(RECENT);
    await seedDrilldown(OLD); await seedDrilldown(RECENT);
    await seedAnomaly(OLD); await seedAnomaly(RECENT);
    await seedDismissed(OLD, monthsAgo(-1), 'spend-spike-30d');
    await seedDismissed(RECENT, monthsAgo(-1), 'spend-spike-wow');
    await seedAudit(OLD); await seedAudit(RECENT);
    await seedCronRun(OLD); await seedCronRun(RECENT);

    const res = await run();
    expect(res.status).toBe('ok');

    // Every table has exactly one surviving (recent) row.
    const count = async (t: string): Promise<number> => {
      const r = await db.execute<{ n: number }>(sql.raw(`SELECT count(*)::int AS n FROM ${t}`));
      return Number(r.rows[0].n);
    };
    for (const t of [
      'sessions_agg', 'team_metrics_daily', 'team_outcomes_daily', 'ingestion_log',
      'onboarding_redemption_log', 'auth_event_log', 'manager_drilldown_audit',
      'manager_anomalies', 'manager_dismissed_anomalies', 'onboarding_audit_log',
    ]) {
      expect(await count(t), `${t} should keep 1 recent row`).toBe(1);
    }
    // cron_runs: the recent seeded 'old-job' survives + the prune's own run row.
    expect(await count('cron_runs')).toBe(2);
  });

  it('prunes manager_dismissed_anomalies by dismissed_at, never dismissed_until (TC-I-01b)', async () => {
    // Recent dismissal (dismissed_at 1mo ago) whose dismissed_until already expired.
    await seedDismissed(RECENT, monthsAgo(1));
    await run();
    const r = await db.select().from(managerDismissedAnomalies);
    expect(r.length).toBe(1); // NOT pruned — cutoff is dismissed_at (recent)
  });

  it('keeps a row just inside the cutoff and deletes one a day older (TC-I-02)', async () => {
    // The prune computes its cutoff at run time (~ms after these seeds). A row
    // 60s newer than monthsAgo(24) is safely INSIDE the window and must
    // survive; a row a full day older is outside and must be deleted. This
    // exercises the `<` (strict) boundary without a wall-clock race.
    const justInside = new Date(monthsAgo(24).getTime() + 60_000);
    const dayOutside = new Date(monthsAgo(24).getTime() - 24 * 60 * 60 * 1000);
    await seedIngestion(justInside);
    await seedIngestion(dayOutside);
    await run();
    const rows = await db.select({ at: ingestionLog.receivedAt }).from(ingestionLog);
    expect(rows.length).toBe(1); // only the day-older row deleted
  });

  it('sweeps orphaned child rows per table when sessions_agg is pruned (TC-I-03)', async () => {
    await seedSessionAgg(OLD, 's-old');
    await seedSessionAgg(RECENT, 's-new');
    // Child rows for both the old (→orphan) and new (→kept) session.
    for (const sid of ['s-old', 's-new']) {
      await db.insert(modelBreakdownAgg).values({ userId, sessionId: sid, model: 'm', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: '0' });
      await db.insert(toolCountAgg).values({ userId, sessionId: sid, toolName: 't', count: 1 });
      await db.insert(sessionOutcomesAgg).values({ userId, sessionId: sid });
    }
    await run();
    const c = async (t: typeof modelBreakdownAgg | typeof toolCountAgg | typeof sessionOutcomesAgg): Promise<string[]> =>
      (await db.select({ s: t.sessionId }).from(t)).map((r) => r.s);
    expect(await c(modelBreakdownAgg)).toEqual(['s-new']);
    expect(await c(toolCountAgg)).toEqual(['s-new']);
    expect(await c(sessionOutcomesAgg)).toEqual(['s-new']);
  });

  it('is idempotent and never deletes the in-flight cron_runs row (TC-I-04)', async () => {
    await seedIngestion(OLD);
    const first = await run();
    expect(first.deletedByTable.ingestion_log).toBe(1);
    const second = await run();
    expect(second.deletedByTable.ingestion_log).toBe(0);
    // Both prune runs left an 'ok' cron_runs row (neither deleted its own).
    const runs = await db.select().from(cronRuns).where(eq(cronRuns.jobName, 'retention-prune'));
    expect(runs.length).toBe(2);
    expect(runs.every((r) => r.status === 'ok')).toBe(true);
  });

  it('records failed in cron_runs and completes on a later run when a table delete throws (TC-I-05)', async () => {
    await seedIngestion(OLD);
    await seedAuthEvent(OLD);
    const res = await runRetentionPrune(
      db,
      { months: 24 },
      { deleteTable: async (name) => { if (name === 'auth_event_log') throw new Error('boom-table'); return 0; } },
    );
    expect(res.status).toBe('failed');
    const failedRun = await db.select().from(cronRuns).where(and(eq(cronRuns.jobName, 'retention-prune'), eq(cronRuns.status, 'failed')));
    expect(failedRun.length).toBe(1);
    // A subsequent clean run completes the remaining tables.
    const res2 = await run();
    expect(res2.status).toBe('ok');
    expect(await db.select().from(authEventLog)).toHaveLength(0);
  });

  it('rolls back the sessions group atomically when the sweep throws (TC-I-05b)', async () => {
    await seedSessionAgg(OLD, 's-old');
    await expect(
      runRetentionPrune(
        db,
        { months: 24 },
        {
          pruneSessionGroup: async (tx, cutoff) => {
            await tx.delete(sessionsAgg).where(lt(sessionsAgg.startedAt, cutoff));
            throw new Error('boom-sweep');
          },
        },
      ),
    ).resolves.toMatchObject({ status: 'failed' });
    // The old sessions_agg row is still present — the transaction rolled back.
    const rows = await db.select().from(sessionsAgg);
    expect(rows.length).toBe(1);
  });
});
