/**
 * Integration tests for `dismissAnomalyImpl` (the DI-seam'd core of the
 * `dismissAnomalyAction` Server Action) — TASK-2 of
 * `.specs/manager-dashboard-v2-followups.md`, REQ-7.
 *
 * Post-helper-extraction, the Server Action delegates the cross-org
 * guard + UPSERT to `performDismissAnomaly` (lib/queries/manager-dismissed.ts).
 * These tests verify the delegation contract end-to-end against real
 * Postgres + cover the action's own conditional branches (auth gate,
 * Zod parse) without dragging NextAuth into vitest's module graph.
 *
 * **Test seam pattern**: same as `route.test.ts` — call
 * `dismissAnomalyImpl(formData, { authFn, revalidatePathFn })` directly
 * with hand-written stubs. NO `vi.mock`. (Self-review M-code/M-test:
 * the earlier `vi.mock`-based version was rewritten to use the same
 * DI seam pattern the rest of the codebase uses.)
 *
 * TC mapping:
 *   - TC-I-07  (happy):       same-org manager + valid body →
 *                             { ok: true }; single row in DB;
 *                             `revalidatePathFn` called once.
 *   - TC-I-07b (security):    cross-org targetUserId →
 *                             { ok: false, code: 'forbidden' };
 *                             zero rows; revalidate NOT called.
 *   - TC-I-07c (security):    null session (unauthenticated) →
 *                             forbidden; zero rows.
 *   - TC-I-07d (validation):  missing/invalid body fields →
 *                             { ok: false, code: 'invalid_input' };
 *                             zero rows.
 *
 * Postgres testcontainer via shared `tests/integration/setup-pg.ts`.
 * Skipped under `SKIP_PG_TESTS=1`.
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
import type { Session } from 'next-auth';
import { closeDb, getDb } from '@/lib/db/client';
import {
  managerDismissedAnomalies,
  orgs,
  teams,
  users,
} from '@/lib/db/schema';
import {
  dismissAnomalyImpl,
  type AuthFn,
  type DismissAnomalyImplDeps,
} from './dismiss-action';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

// -------- Stubs ---------------------------------------------------------

const stubAuth = (session: Session | null): AuthFn => async () => session;

const makeRevalidateStub = (): {
  fn: (path: string) => void;
  calls: ReadonlyArray<string>;
} => {
  const calls: string[] = [];
  return {
    fn: (path: string) => {
      calls.push(path);
    },
    calls,
  };
};

const makeStubDeps = (
  session: Session | null,
): DismissAnomalyImplDeps & { revalidate: ReadonlyArray<string> } => {
  const revalidate = makeRevalidateStub();
  return {
    authFn: stubAuth(session),
    revalidatePathFn: revalidate.fn,
    revalidate: revalidate.calls,
  };
};

// -------- Fixtures ------------------------------------------------------

type Seeded = {
  orgAId: string;
  orgBId: string;
  teamAId: string;
  teamBId: string;
  managerAId: string;
  targetAId: string;
  targetBId: string;
};

const seed = async (): Promise<Seeded> => {
  const db = getDb();
  const [orgA] = await db
    .insert(orgs)
    .values({ name: 'DismissActionOrgA' })
    .returning({ id: orgs.id });
  const [orgB] = await db
    .insert(orgs)
    .values({ name: 'DismissActionOrgB' })
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
      email: 'mgr-a@dismiss-action.example',
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
      email: 'target-a@dismiss-action.example',
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
      email: 'target-b@dismiss-action.example',
      ssoProvider: null,
      ssoSubject: null,
      role: 'member',
    })
    .returning({ id: users.id });
  return {
    orgAId: orgA.id,
    orgBId: orgB.id,
    teamAId: teamA.id,
    teamBId: teamB.id,
    managerAId: managerA.id,
    targetAId: targetA.id,
    targetBId: targetB.id,
  };
};

const stubManagerSession = (managerId: string, orgId: string): Session =>
  ({
    user: {
      id: managerId,
      orgId,
      email: 'mgr-a@dismiss-action.example',
      role: 'manager',
    },
    expires: new Date(Date.now() + 60_000).toISOString(),
  }) as unknown as Session;

const makeFormData = (input: { targetUserId: string; kind: string }): FormData => {
  const fd = new FormData();
  fd.set('targetUserId', input.targetUserId);
  fd.set('kind', input.kind);
  return fd;
};

skipDescribe('dismissAnomalyImpl (Server Action core — Postgres integration)', () => {
  let seeded: Seeded;

  beforeAll(async () => {
    const db = getDb();
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
    seeded = await seed();
  });

  afterEach(async () => {
    const db = getDb();
    await db.execute(sql`TRUNCATE TABLE
      manager_dismissed_anomalies, users, teams, orgs
      RESTART IDENTITY CASCADE`);
  });

  // -------------------------------------------------------------------
  // TC-I-07 — happy path: same-org manager + valid target → ok + row +
  // revalidatePath called.
  // -------------------------------------------------------------------
  it('TC-I-07: same-org dismiss → ok + single row + dismissed_until ≈ now+7d + revalidate called', async () => {
    const deps = makeStubDeps(stubManagerSession(seeded.managerAId, seeded.orgAId));
    const before = Date.now();
    const result = await dismissAnomalyImpl(
      makeFormData({ targetUserId: seeded.targetAId, kind: 'spend-spike-30d' }),
      deps,
    );
    const after = Date.now();

    expect(result).toEqual({ ok: true });
    expect(deps.revalidate).toEqual(['/manager/health']);

    const db = getDb();
    const rows = await db.select().from(managerDismissedAnomalies);
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.orgId).toBe(seeded.orgAId);
    expect(row.managerUserId).toBe(seeded.managerAId);
    expect(row.targetUserId).toBe(seeded.targetAId);
    expect(row.kind).toBe('spend-spike-30d');
    const dismissedUntilMs = row.dismissedUntil.getTime();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(dismissedUntilMs).toBeGreaterThanOrEqual(before + sevenDaysMs - 100);
    expect(dismissedUntilMs).toBeLessThanOrEqual(after + sevenDaysMs + 100);
  });

  // -------------------------------------------------------------------
  // TC-I-07b — security: cross-org targetUserId → forbidden + 0 rows +
  // revalidate NOT called.
  // -------------------------------------------------------------------
  it('TC-I-07b: cross-org target → forbidden + 0 rows + no revalidate', async () => {
    const deps = makeStubDeps(stubManagerSession(seeded.managerAId, seeded.orgAId));
    const result = await dismissAnomalyImpl(
      makeFormData({ targetUserId: seeded.targetBId, kind: 'spend-spike-wow' }),
      deps,
    );

    expect(result).toEqual({ ok: false, code: 'forbidden' });
    expect(deps.revalidate).toEqual([]);

    const db = getDb();
    const rows = await db.select().from(managerDismissedAnomalies);
    expect(rows.length).toBe(0);
  });

  // -------------------------------------------------------------------
  // TC-I-07c — security: null session (unauthenticated caller).
  // (Self-review SHOULD-FIX: the action's null-session branch had no TC.)
  // -------------------------------------------------------------------
  it('TC-I-07c: null session → forbidden + 0 rows + no revalidate (auth gate short-circuits before DB)', async () => {
    const deps = makeStubDeps(null);
    const result = await dismissAnomalyImpl(
      makeFormData({ targetUserId: seeded.targetAId, kind: 'spend-spike-30d' }),
      deps,
    );

    expect(result).toEqual({ ok: false, code: 'forbidden' });
    expect(deps.revalidate).toEqual([]);

    const db = getDb();
    const rows = await db.select().from(managerDismissedAnomalies);
    expect(rows.length).toBe(0);
  });

  // -------------------------------------------------------------------
  // TC-I-07d — validation: missing targetUserId → invalid_input + 0 rows.
  // (Self-review SHOULD-FIX: Zod parse failure branch had no TC.)
  // -------------------------------------------------------------------
  it('TC-I-07d: missing targetUserId → invalid_input + 0 rows + no revalidate', async () => {
    const deps = makeStubDeps(stubManagerSession(seeded.managerAId, seeded.orgAId));
    const fd = new FormData();
    // targetUserId omitted; kind present.
    fd.set('kind', 'spend-spike-30d');
    const result = await dismissAnomalyImpl(fd, deps);

    expect(result).toEqual({ ok: false, code: 'invalid_input' });
    expect(deps.revalidate).toEqual([]);

    const db = getDb();
    const rows = await db.select().from(managerDismissedAnomalies);
    expect(rows.length).toBe(0);
  });
});
