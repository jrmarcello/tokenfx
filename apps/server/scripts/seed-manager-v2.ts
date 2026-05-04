#!/usr/bin/env tsx
// apps/server/scripts/seed-manager-v2.ts
//
// Additive seed for manager-dashboard-v2 E2E tests (TASK-SMOKE-EFFECTIVENESS).
// Runs AFTER `seed-server.ts --e2e` and adds:
//
//   1. A third team on Alpha (`team-platform`) with one manager + members so
//      Alpha has >= 3 teams. TC-E2E-02 needs 3 polygons in the radar chart.
//   2. 30 days of deterministic `team_metrics_daily` rollups for ALL Alpha
//      teams (frontend / backend / platform). Values vary per team so the
//      radar normalization produces visibly distinct polygons; without
//      variance the polygons would collapse and the visual assertion would
//      be meaningless.
//   3. A *new* Gamma org with exactly ONE team and one manager. TC-E2E-13
//      asserts that a manager with < 2 teams sees NO radar section in the
//      DOM; we need a 1-team scenario the JWT-cookie helper can sign in as.
//      Gamma is also seeded with `team_metrics_daily` rows so the page
//      renders KPIs (otherwise the empty-org chrome short-circuits).
//
// All inserts use `.onConflictDoNothing()`/`.onConflictDoUpdate(...)` so a
// re-run is safe. Deterministic UUIDs come from `stableUuid()` (shared with
// `seed-server.ts` and the Playwright suite — see `lib/e2e/seed-ids.ts`).
//
// Usage:
//   tsx apps/server/scripts/seed-manager-v2.ts          # CLI entry
//
// Or imported from globalSetup:
//   import { seedManagerV2 } from './seed-manager-v2';
//   await seedManagerV2(getDb());
//
// SECURITY: refuses NODE_ENV=production unless ALLOW_PRODUCTION_SEED=1.

import bcrypt from 'bcrypt';
import { createHash } from 'node:crypto';
import { closeDb, getDb } from '@/lib/db/client';
import { BCRYPT_COST } from '@/lib/auth/bearer-auth';
import {
  orgs,
  teamMetricsDaily,
  teams,
  userMachines,
  users,
} from '@/lib/db/schema';
import { stableUuid } from '@/lib/e2e/seed-ids';

type Db = ReturnType<typeof getDb>;

type Role = 'admin' | 'manager' | 'member';

interface UserSpec {
  readonly localPart: string;
  readonly role: Role;
}

interface TeamSpec {
  readonly slug: string;
  readonly name: string;
  readonly users: readonly UserSpec[];
  /**
   * Per-team multipliers applied to the deterministic base metrics. Tweak
   * these to make each team's radar polygon visibly different. All values
   * must keep the resulting metric in its valid domain (cache_hit ∈ [0,1],
   * percentages ∈ [0,100]).
   */
  readonly metricBias: {
    readonly cacheHit: number;
    readonly goodSession: number;
    readonly subagent: number;
    readonly composite: number;
  };
}

interface OrgSpec {
  readonly slug: string;
  readonly name: string;
  readonly teams: readonly TeamSpec[];
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Alpha gets a NEW team `team-platform` (frontend + backend already seeded
 * by `seed-server.ts --e2e`). Frontend/Backend rows are listed here too so
 * the metrics seeding loop can compute deterministic values for ALL three
 * teams uniformly — no users are re-inserted (the conflict-do-nothing keeps
 * them stable) and the seed-server.ts members keep ownership of those teams.
 */
const ALPHA_SPEC: OrgSpec = {
  slug: 'org-alpha',
  name: 'Alpha Co',
  teams: [
    {
      slug: 'team-frontend',
      name: 'Frontend',
      // Pre-existing per seed-server.ts; listed only for metric seeding.
      users: [],
      metricBias: {
        cacheHit: 0.62,
        goodSession: 64,
        subagent: 18,
        composite: 68,
      },
    },
    {
      slug: 'team-backend',
      name: 'Backend',
      // Pre-existing.
      users: [],
      metricBias: {
        cacheHit: 0.71,
        goodSession: 58,
        subagent: 32,
        composite: 72,
      },
    },
    {
      slug: 'team-platform',
      name: 'Platform',
      // NEW team — manager-v2 introduces this so Alpha has 3 teams for
      // TC-E2E-02. Two members + one manager. The members are inserted
      // here too because seed-server.ts does not know about this team.
      users: [
        { localPart: 'paula', role: 'manager' },
        { localPart: 'quinn', role: 'member' },
        { localPart: 'rita', role: 'member' },
      ],
      metricBias: {
        cacheHit: 0.55,
        goodSession: 70,
        subagent: 24,
        composite: 65,
      },
    },
  ],
};

/**
 * Gamma org: ONE team, ONE manager. The Playwright suite signs in as the
 * manager and asserts the radar section is absent from the DOM (TC-E2E-13).
 */
const GAMMA_SPEC: OrgSpec = {
  slug: 'org-gamma',
  name: 'Gamma Co',
  teams: [
    {
      slug: 'team-solo',
      name: 'Solo',
      users: [
        { localPart: 'gabriela', role: 'manager' },
        { localPart: 'gustavo', role: 'member' },
      ],
      metricBias: {
        cacheHit: 0.6,
        goodSession: 60,
        subagent: 25,
        composite: 65,
      },
    },
  ],
};

// 30 days of metrics — matches the per-org page's WINDOW_DAYS = 30.
const METRIC_DAYS = 30;

// Anchor matches seed-server.ts: 2026-04-29 is "today" for the deterministic
// fixture. Using a stable anchor keeps test assertions reproducible across
// real-clock drift in CI environments.
const ANCHOR_UTC_MS = Date.UTC(2026, 3, 29, 0, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Insert helpers
// ---------------------------------------------------------------------------

/**
 * Idempotently insert org / team / user / user_machine rows for a spec.
 * Re-uses the same UUID/email derivation as `seed-server.ts` so the
 * deterministic fixture stays internally consistent — same email pattern
 * (`<localPart>@<orgSlug-without-prefix>.test`), same SSO provider/subject.
 */
const seedOrgAndUsers = async (db: Db, spec: OrgSpec): Promise<void> => {
  const orgId = stableUuid(`org:${spec.slug}`);
  await db
    .insert(orgs)
    .values({ id: orgId, name: spec.name })
    .onConflictDoNothing();

  for (const teamSpec of spec.teams) {
    const teamId = stableUuid(`team:${spec.slug}:${teamSpec.slug}`);
    await db
      .insert(teams)
      .values({ id: teamId, orgId, name: teamSpec.name })
      .onConflictDoNothing();

    for (const userSpec of teamSpec.users) {
      const userId = stableUuid(
        `user:${spec.slug}:${userSpec.localPart}`,
      );
      const email = `${userSpec.localPart}@${spec.slug.replace(/^org-/, '')}.test`;
      await db
        .insert(users)
        .values({
          id: userId,
          orgId,
          teamId,
          email,
          ssoProvider: 'e2e-seed',
          ssoSubject: `e2e:${email}`,
          role: userSpec.role,
        })
        .onConflictDoNothing();

      // Bearer machine — needed only for ingest tests, but we still mint a
      // deterministic credential so seed-manager-v2 mirrors seed-server.ts'
      // shape end-to-end. Plaintext is hashed; never written to stdout.
      const machineId = stableUuid(`machine:${spec.slug}:${userSpec.localPart}`);
      const keyId = `k_e2e_${spec.slug.replace(/^org-/, '')}_${userSpec.localPart}`;
      const plaintextSecret = createHash('sha256')
        .update(`e2e-secret:${spec.slug}:${userSpec.localPart}`)
        .digest('hex');
      const secretHash = await bcrypt.hash(plaintextSecret, BCRYPT_COST);
      await db
        .insert(userMachines)
        .values({
          id: stableUuid(`um:${spec.slug}:${userSpec.localPart}`),
          userId,
          machineId,
          keyId,
          secretHash,
        })
        .onConflictDoNothing();
    }
  }
};

/**
 * Compute one day's `team_metrics_daily` row for the given team. The values
 * are biased per team so radar normalization produces distinct polygons but
 * stay inside their valid domains (cache_hit ∈ [0,1], pcts ∈ [0,100]).
 *
 * `dayOffset` is the offset back from ANCHOR_UTC_MS — 0 == today, 1 == one
 * day ago, etc. The sinusoidal jitter keeps trends visually non-flat for the
 * 30-day chart assertions.
 */
const buildMetricRow = (
  orgId: string,
  teamId: string,
  bias: TeamSpec['metricBias'],
  dayOffset: number,
): typeof teamMetricsDaily.$inferInsert => {
  const dayMs = ANCHOR_UTC_MS - dayOffset * DAY_MS;
  const day = new Date(dayMs).toISOString().slice(0, 10); // YYYY-MM-DD
  const wave = Math.sin((dayOffset / METRIC_DAYS) * Math.PI * 2);
  // Clamp helpers — keep numeric domains valid.
  const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
  const clampPct = (n: number): number => Math.max(0, Math.min(100, n));

  const cacheHit = clamp01(bias.cacheHit + wave * 0.05);
  const goodSession = clampPct(bias.goodSession + wave * 6);
  const subagent = clampPct(bias.subagent + wave * 4);
  const composite = clampPct(bias.composite + wave * 5);

  // toolMixJson — small daily distribution. Edit/Read dominate so the
  // normalized "edit share" / "read share" axes on the radar have signal.
  const toolMix = {
    Edit: 30 + Math.round(wave * 5),
    Read: 25 + Math.round(wave * 4),
    Bash: 12,
    Agent: 8,
    Other: 5,
  };

  return {
    orgId,
    teamId,
    day,
    cacheHitRatioAvg: cacheHit.toFixed(4),
    goodSessionPct: goodSession.toFixed(2),
    subagentAdoptionPct: subagent.toFixed(2),
    compositeAvg: composite.toFixed(2),
    totalSessions: 12 + dayOffset,
    totalDevs: 4,
    toolMixJson: toolMix,
  };
};

const seedTeamMetrics = async (db: Db, spec: OrgSpec): Promise<number> => {
  const orgId = stableUuid(`org:${spec.slug}`);
  let rowsWritten = 0;
  for (const teamSpec of spec.teams) {
    const teamId = stableUuid(`team:${spec.slug}:${teamSpec.slug}`);
    const rows: Array<typeof teamMetricsDaily.$inferInsert> = [];
    for (let dayOffset = 0; dayOffset < METRIC_DAYS; dayOffset += 1) {
      rows.push(buildMetricRow(orgId, teamId, teamSpec.metricBias, dayOffset));
    }
    // Bulk insert — `onConflictDoUpdate` so a re-run refreshes values when
    // the bias formula changes. The PK is (org_id, team_id, day).
    if (rows.length > 0) {
      await db
        .insert(teamMetricsDaily)
        .values(rows)
        .onConflictDoUpdate({
          target: [
            teamMetricsDaily.orgId,
            teamMetricsDaily.teamId,
            teamMetricsDaily.day,
          ],
          set: {
            cacheHitRatioAvg: sqlExcluded('cache_hit_ratio_avg'),
            goodSessionPct: sqlExcluded('good_session_pct'),
            subagentAdoptionPct: sqlExcluded('subagent_adoption_pct'),
            compositeAvg: sqlExcluded('composite_avg'),
            totalSessions: sqlExcluded('total_sessions'),
            totalDevs: sqlExcluded('total_devs'),
            toolMixJson: sqlExcluded('tool_mix_json'),
            computedAt: sqlExcluded('computed_at'),
          },
        });
      rowsWritten += rows.length;
    }
  }
  return rowsWritten;
};

// Drizzle helper — `excluded.<col>` for ON CONFLICT DO UPDATE. Imported
// inline so seed callers don't need to depend on drizzle-orm sql tag.
import { sql } from 'drizzle-orm';
const sqlExcluded = (col: string): ReturnType<typeof sql.raw> =>
  sql.raw(`excluded.${col}`);

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Seed manager-dashboard-v2 fixtures. Idempotent. Safe to call from
 * Playwright globalSetup AFTER `seed-server.ts --e2e` has run.
 */
export const seedManagerV2 = async (db: Db): Promise<void> => {
  await seedOrgAndUsers(db, ALPHA_SPEC);
  await seedOrgAndUsers(db, GAMMA_SPEC);

  const alphaRows = await seedTeamMetrics(db, ALPHA_SPEC);
  const gammaRows = await seedTeamMetrics(db, GAMMA_SPEC);

  process.stdout.write(
    `[seed-manager-v2] alpha team_metrics_daily=${alphaRows} ` +
      `gamma team_metrics_daily=${gammaRows}\n`,
  );
};

// ---------------------------------------------------------------------------
// CLI shim
// ---------------------------------------------------------------------------

const isCli = (): boolean => {
  // `tsx scripts/seed-manager-v2.ts` sets process.argv[1] to the resolved
  // script path. Comparing against __filename works for both CJS (default
  // tsx mode) and a future ESM migration as long as the file is the entry.
  // We resolve via `path.basename` so symlink/canonicalization differences
  // don't cause false negatives in dev environments.
  const entry = process.argv[1];
  if (!entry) return false;
  return entry.endsWith('seed-manager-v2.ts') || entry.endsWith('seed-manager-v2.js');
};

if (isCli()) {
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.ALLOW_PRODUCTION_SEED !== '1'
  ) {
    process.stderr.write(
      'seed-manager-v2: refusing to run with NODE_ENV=production. ' +
        'Set ALLOW_PRODUCTION_SEED=1 to override.\n',
    );
    process.exit(1);
  }

  const main = async (): Promise<void> => {
    const db = getDb();
    try {
      await seedManagerV2(db);
    } finally {
      await closeDb();
    }
  };

  main().catch((err: unknown) => {
    process.stderr.write(
      `seed-manager-v2 failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    void closeDb().finally(() => process.exit(1));
  });
}
