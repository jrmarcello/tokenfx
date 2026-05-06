/**
 * Integration tests for the `org_settings` hoist + `authFn`/`afterFn` DI
 * seams in `apps/server/app/manager/_drilldown/render.tsx` —
 * TASK-5 of `.specs/manager-dashboard-v2-followups.md` (REQ-13..17).
 *
 * Scope:
 *   - The `org_settings.drilldown_notification_enabled` read is hoisted
 *     OUT of the `after()` callback so we can deterministically assert
 *     "after() was NOT registered" when the toggle is off.
 *   - `RenderDrilldownOptions` exposes two new optional DI seams:
 *     `authFn` (default = lazy `auth()` import) and `afterFn` (default =
 *     `after` from `next/server`). Tests inject hand-written stubs.
 *
 * TC mapping (per spec Test Plan):
 *   - TC-I-13 — happy: notification ON (explicit `true`) → channel.enqueue
 *     called once with the locked payload; audit row written.
 *   - TC-I-14 — happy: notification OFF (`false`) → channel NOT called;
 *     `afterFn` NOT invoked; audit row STILL written.
 *   - TC-I-15 — edge: `org_settings` row missing → defaults to ON
 *     (matches Q9 lock of parent spec). Behavior identical to TC-I-13.
 *   - TC-I-16 — idempotency: same drilldown twice same day → 1st call
 *     enqueues, 2nd call does NOT (audit.inserted === false on 2nd).
 *   - TC-I-17 — infra: `opts.authFn` ABSENT → lazy `auth()` import path
 *     resolves without throw. Asserted via the side-effect that
 *     `loadDrilldownData` reaches the `redirect('/api/auth/signin')`
 *     branch when the lazy session is null. Mechanism: monkey-patch the
 *     auth module via a hand-written stub set on `globalThis` before
 *     `loadDrilldownData` runs.
 *   - TC-I-20 — infra: `org_settings` SELECT throws → error propagates
 *     to the caller (the route's `error.tsx`). Audit row already written
 *     before the read; `afterFn` NOT registered.
 *
 * Postgres-backed via the shared Testcontainers setup (see
 * `tests/integration/setup-pg.ts`). Skipped under `SKIP_PG_TESTS=1`.
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
import type { after as nextAfter } from 'next/server';
import type { Session } from 'next-auth';
import { eq, sql } from 'drizzle-orm';
import { closeDb, getDb } from '@/lib/db/client';
import {
  managerDrilldownAudit,
  orgSettings,
  orgs,
  teams,
  users,
} from '@/lib/db/schema';
import {
  loadDrilldownData,
  type RenderDrilldownOptions,
} from '@/app/manager/_drilldown/render';
import type {
  EnqueueNotificationParams,
  NotificationChannel,
} from '@/lib/queries/notifications';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

type Seeded = {
  orgId: string;
  teamId: string;
  managerId: string;
  managerEmail: string;
  devId: string;
};

const seedOrgManagerDev = async (): Promise<Seeded> => {
  const db = getDb();
  const [org] = await db
    .insert(orgs)
    .values({ name: 'DrilldownNotifOrg' })
    .returning({ id: orgs.id });
  const [team] = await db
    .insert(teams)
    .values({ orgId: org.id, name: 'DrilldownNotifTeam' })
    .returning({ id: teams.id });
  const managerEmail = 'mgr@drilldown-notif.example';
  const [manager] = await db
    .insert(users)
    .values({
      orgId: org.id,
      teamId: team.id,
      email: managerEmail,
      displayName: 'Drilldown Manager',
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
      email: 'dev@drilldown-notif.example',
      displayName: 'Drilldown Dev',
      ssoProvider: null,
      ssoSubject: null,
      role: 'member',
    })
    .returning({ id: users.id });
  return {
    orgId: org.id,
    teamId: team.id,
    managerId: manager.id,
    managerEmail,
    devId: dev.id,
  };
};

/**
 * Hand-written `Session`-shaped stub honoring the manager role + orgId.
 * Mirrors the shape produced by `auth()` for a real manager — only the
 * fields `loadDrilldownData` actually reads are populated.
 */
const stubAuthFor = (s: {
  managerId: string;
  orgId: string;
  email: string;
}): (() => Promise<Session | null>) => {
  return async () => ({
    user: {
      id: s.managerId,
      orgId: s.orgId,
      email: s.email,
      role: 'manager',
    },
    expires: new Date(Date.now() + 60_000).toISOString(),
  } as unknown as Session);
};

/**
 * `afterFn` stub that runs the callback synchronously in the same turn
 * (fire-and-forget — `void cb()` suppresses the returned Promise). Used
 * by TCs that need to assert the channel was called immediately after
 * `loadDrilldownData` resolves.
 */
type AfterFn = typeof nextAfter;

const makeExecutingAfter = (): {
  fn: AfterFn;
  callCount: () => number;
  awaitPending: () => Promise<void>;
} => {
  let calls = 0;
  const pending: Array<Promise<unknown>> = [];
  const fn: AfterFn = ((cb: unknown) => {
    calls += 1;
    if (typeof cb === 'function') {
      const result = (cb as () => unknown)();
      if (result instanceof Promise) {
        pending.push(result);
      }
    }
  }) as unknown as AfterFn;
  return {
    fn,
    callCount: () => calls,
    awaitPending: async () => {
      // Drain any in-flight promises so async stubs can finish before
      // assertions read the captured payload.
      await Promise.allSettled(pending.splice(0));
    },
  };
};

/**
 * `afterFn` stub that NEVER invokes the callback. Used to assert "after
 * was registered N times" without side-effects.
 */
const makeCapturingAfter = (): {
  fn: AfterFn;
  callCount: () => number;
} => {
  let calls = 0;
  const fn: AfterFn = (() => {
    calls += 1;
  }) as unknown as AfterFn;
  return { fn, callCount: () => calls };
};

/**
 * Hand-written `NotificationChannel` capturing every enqueue call.
 */
const makeStubChannel = (): {
  channel: NotificationChannel;
  calls: ReadonlyArray<EnqueueNotificationParams>;
} => {
  const calls: EnqueueNotificationParams[] = [];
  const channel: NotificationChannel = {
    enqueue: async (_exec, params) => {
      calls.push(params);
    },
  };
  return { channel, calls };
};

const SOURCE_ROUTE: RenderDrilldownOptions['sourceRoute'] =
  '/manager/devs/[devId]';

skipDescribe('loadDrilldownData hoist + DI seams (Postgres integration)', () => {
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
    seeded = await seedOrgManagerDev();
  });

  afterEach(async () => {
    const db = getDb();
    await db.execute(sql`TRUNCATE TABLE
      manager_dismissed_anomalies, manager_anomalies, manager_drilldown_audit,
      manager_notifications, org_settings,
      tool_count_agg, model_breakdown_agg, sessions_agg,
      users, teams, orgs
      RESTART IDENTITY CASCADE`);
  });

  // ---------------------------------------------------------------------
  // TC-I-13 — happy path: notification ON (explicit true). Channel called
  // once with the locked payload; audit row written.
  // ---------------------------------------------------------------------
  it('TC-I-13: enqueues notification when org_settings.drilldown_notification_enabled = true', async () => {
    const db = getDb();
    await db.insert(orgSettings).values({
      orgId: seeded.orgId,
      drilldownNotificationEnabled: true,
    });

    const { channel, calls } = makeStubChannel();
    const after = makeExecutingAfter();
    const authFn = stubAuthFor({
      managerId: seeded.managerId,
      orgId: seeded.orgId,
      email: seeded.managerEmail,
    });

    const data = await loadDrilldownData(
      seeded.devId,
      { reason: 'cost-investigation' },
      {
        sourceRoute: SOURCE_ROUTE,
        notifyChannel: channel,
        authFn,
        afterFn: after.fn,
      },
    );
    await after.awaitPending();

    expect(calls.length).toBe(1);
    const call = calls[0];
    expect(call.template).toBe('MANAGER_DRILLDOWN_VIEW');
    expect(call.targetUserId).toBe(seeded.devId);
    expect(call.payload.reason).toBe('cost-investigation');
    expect(call.payload.managerName.length).toBeGreaterThan(0);
    expect(call.payload.viewedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(data.dev.id).toBe(seeded.devId);

    const auditRows = await db
      .select({ id: managerDrilldownAudit.id })
      .from(managerDrilldownAudit)
      .where(eq(managerDrilldownAudit.orgId, seeded.orgId));
    expect(auditRows.length).toBe(1);
  });

  // ---------------------------------------------------------------------
  // TC-I-14 — notification OFF: `org_settings.drilldown_notification_enabled
  // = false`. Channel NOT called; `afterFn` registered ZERO times (the
  // hoist gates BEFORE registering after); audit row STILL written.
  // ---------------------------------------------------------------------
  it('TC-I-14: skips enqueue + does not register afterFn when toggle is false', async () => {
    const db = getDb();
    await db.insert(orgSettings).values({
      orgId: seeded.orgId,
      drilldownNotificationEnabled: false,
    });

    const { channel, calls } = makeStubChannel();
    // Use executing variant — would actually run the cb if registered.
    const after = makeExecutingAfter();
    const authFn = stubAuthFor({
      managerId: seeded.managerId,
      orgId: seeded.orgId,
      email: seeded.managerEmail,
    });

    await loadDrilldownData(
      seeded.devId,
      { reason: 'training-check' },
      {
        sourceRoute: SOURCE_ROUTE,
        notifyChannel: channel,
        authFn,
        afterFn: after.fn,
      },
    );
    await after.awaitPending();

    expect(calls.length).toBe(0);
    expect(after.callCount()).toBe(0);

    const auditRows = await db
      .select({ id: managerDrilldownAudit.id })
      .from(managerDrilldownAudit)
      .where(eq(managerDrilldownAudit.orgId, seeded.orgId));
    expect(auditRows.length).toBe(1);
  });

  // ---------------------------------------------------------------------
  // TC-I-15 — edge: `org_settings` row missing for the org. Default ON.
  // Behavior identical to TC-I-13.
  // ---------------------------------------------------------------------
  it('TC-I-15: defaults to ON when org_settings row is missing', async () => {
    // No insert into org_settings — REQ-15b default-true path.
    const { channel, calls } = makeStubChannel();
    const after = makeExecutingAfter();
    const authFn = stubAuthFor({
      managerId: seeded.managerId,
      orgId: seeded.orgId,
      email: seeded.managerEmail,
    });

    await loadDrilldownData(
      seeded.devId,
      { reason: 'cost-investigation' },
      {
        sourceRoute: SOURCE_ROUTE,
        notifyChannel: channel,
        authFn,
        afterFn: after.fn,
      },
    );
    await after.awaitPending();

    expect(calls.length).toBe(1);
    expect(after.callCount()).toBe(1);
  });

  // ---------------------------------------------------------------------
  // TC-I-16 — idempotency: same drilldown twice on the same day
  // (audit ON CONFLICT DO NOTHING — `inserted === false` on the 2nd).
  // 1st call: 1 enqueue. 2nd call: NO new enqueue. `afterFn` registered
  // exactly once across both calls.
  // ---------------------------------------------------------------------
  it('TC-I-16: same-day re-render does not re-enqueue (audit.inserted === false)', async () => {
    const db = getDb();
    await db.insert(orgSettings).values({
      orgId: seeded.orgId,
      drilldownNotificationEnabled: true,
    });

    const { channel, calls } = makeStubChannel();
    const after = makeExecutingAfter();
    const authFn = stubAuthFor({
      managerId: seeded.managerId,
      orgId: seeded.orgId,
      email: seeded.managerEmail,
    });

    await loadDrilldownData(
      seeded.devId,
      { reason: 'cost-investigation' },
      {
        sourceRoute: SOURCE_ROUTE,
        notifyChannel: channel,
        authFn,
        afterFn: after.fn,
      },
    );
    await after.awaitPending();
    expect(calls.length).toBe(1);
    expect(after.callCount()).toBe(1);

    await loadDrilldownData(
      seeded.devId,
      { reason: 'cost-investigation' },
      {
        sourceRoute: SOURCE_ROUTE,
        notifyChannel: channel,
        authFn,
        afterFn: after.fn,
      },
    );
    await after.awaitPending();

    // No new enqueue — the second call is an ON CONFLICT DO NOTHING
    // refresh (audit.inserted === false, REQ-16 of parent spec).
    expect(calls.length).toBe(1);
    expect(after.callCount()).toBe(1);

    // Verify exactly one audit row in DB for this org/day.
    const auditRows = await db
      .select({ id: managerDrilldownAudit.id })
      .from(managerDrilldownAudit)
      .where(eq(managerDrilldownAudit.orgId, seeded.orgId));
    expect(auditRows.length).toBe(1);
  });

  // ---------------------------------------------------------------------
  // TC-I-17 — infra: `opts.authFn` is ABSENT. The default lazy `auth()`
  // import is invoked. We can't have a real NextAuth session in vitest,
  // so the narrowest assertion is: `loadDrilldownData` triggers the
  // sentinel `redirect('/api/auth/signin')` (since the lazy import yields
  // a null session in this test environment). Next.js's `redirect()`
  // throws a special error with `digest = NEXT_REDIRECT`; we catch and
  // assert on that — proving the lazy import resolved without throwing
  // its own "lazy import failed" error.
  // ---------------------------------------------------------------------
  it.skip('TC-I-17: omitting authFn falls back to the lazy auth() import (default seam wired) [DEFERRED — see reason]', async () => {
    // **DEFERRED** — vitest cannot fully resolve `next-auth` even with
    // `server.deps.inline: [/^next-auth/, /^next($|\/)/]` in
    // `vitest.config.ts`: next-auth's internal `import 'next/server'`
    // (no `.js`) hits Node's strict ESM resolver before vitest's
    // bundler intercepts. The previous OR-disjunction assertion
    // (NEXT_REDIRECT *or* module-resolution error) was too broad — it
    // passed on a broken seam (test-reviewer MAJOR self-review finding).
    //
    // The seam IS verified by:
    //   1. **TypeScript** (build-time): `loadDrilldownData` invokes
    //      `opts.authFn ?? (() => import('@/lib/auth/auth').then(m =>
    //      m.auth()))` with strict typing — a missing default would be a
    //      compile error.
    //   2. **Production**: `pnpm build` resolves next-auth via Next.js's
    //      bundler; the lazy import works there. E2E TC-E2E-08/09/10
    //      exercise this path against the real dev server (manager
    //      drilldown flow).
    //
    // Re-enable this TC if a future test environment can resolve
    // next-auth (e.g., a Next.js test runner replaces vitest at this
    // layer). The `it.skip(...)` keeps the TC-ID anchored to the spec
    // for traceability.
  });

  // ---------------------------------------------------------------------
  // TC-I-20 — infra: `org_settings` SELECT throws. Audit was already
  // written (separate transaction). The hoisted read is BEFORE
  // `after()`, so the error propagates synchronously to the caller —
  // `afterFn` is never registered. Mechanism: drop the `org_settings`
  // table mid-test so the SELECT fails with a Postgres error.
  // ---------------------------------------------------------------------
  it('TC-I-20: org_settings SELECT failure propagates; afterFn never registered; audit row persists', async () => {
    const db = getDb();
    // Drop the table to force the SELECT to throw. Recreated in afterEach
    // by the next test's TRUNCATE/seed (the migration ran globally in
    // setup-pg, so we DROP for this test only and rely on the suite-wide
    // setup not to need it again — afterEach just truncates, so we
    // recreate at the end of the test.)
    await db.execute(sql`DROP TABLE org_settings CASCADE`);

    const after = makeCapturingAfter();
    const { channel, calls } = makeStubChannel();
    const authFn = stubAuthFor({
      managerId: seeded.managerId,
      orgId: seeded.orgId,
      email: seeded.managerEmail,
    });

    let thrown: unknown = null;
    try {
      await loadDrilldownData(
        seeded.devId,
        { reason: 'cost-investigation' },
        {
          sourceRoute: SOURCE_ROUTE,
          notifyChannel: channel,
          authFn,
          afterFn: after.fn,
        },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).not.toBeNull();
    expect(after.callCount()).toBe(0);
    expect(calls.length).toBe(0);

    // Audit row was written BEFORE the org_settings read (separate tx,
    // already committed). Documented trade-off — REQ-15 of parent spec.
    const auditRows = await db
      .select({ id: managerDrilldownAudit.id })
      .from(managerDrilldownAudit)
      .where(eq(managerDrilldownAudit.orgId, seeded.orgId));
    expect(auditRows.length).toBe(1);

    // Recreate org_settings so subsequent tests' afterEach TRUNCATE
    // continues to find the table. Mirror the schema definition.
    await db.execute(sql`CREATE TABLE org_settings (
      org_id uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
      drilldown_notification_enabled boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  });
});
