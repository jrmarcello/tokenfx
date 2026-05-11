/**
 * Seed deterministic outcome fixtures for E2E tests of
 * `manager-dashboard-v3-outcomes` (TC-E2E-01..03 of the spec).
 *
 * Depends on:
 *   1. `seed-server.ts --e2e` (creates Alpha Co + Gamma Co)
 *   2. `seed-manager-v2.ts` (creates teams + users + sessions_agg rows
 *      we reference here)
 *
 * Populates two tables:
 *   - `session_outcomes_agg` for ~5 of Alpha's sessions (so
 *     `/me/visibility` shows non-zero personal outcome KPIs)
 *   - `team_outcomes_daily` for Alpha (3 teams × 7 days; 21 rows)
 *     so `/manager/outcomes` renders KPIs + per-team table
 *
 * Gamma is **deliberately left without outcome data** — TC-E2E-02
 * exercises the empty/single-team branch of `/manager/outcomes`.
 *
 * Idempotent (`onConflictDoNothing` / `onConflictDoUpdate` everywhere)
 * so the seed can run repeatedly inside the same Postgres testcontainer.
 *
 * Production guard: refuses to run with `NODE_ENV=production` unless
 * `ALLOW_PRODUCTION_SEED=1` is set explicitly.
 */
import { eq, sql } from 'drizzle-orm';

import { stableUuid } from '@/lib/e2e/seed-ids';
import { closeDb, getDb } from '@/lib/db/client';
import {
  sessionOutcomesAgg,
  sessionsAgg,
  teamOutcomesDaily,
  teams,
} from '@/lib/db/schema';

type Db = ReturnType<typeof getDb>;

// Anchor matches v2 seed for date alignment in tests.
const ANCHOR_UTC_MS = Date.UTC(2026, 3, 29, 0, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO YYYY-MM-DD helper. */
const isoDay = (ms: number): string =>
  new Date(ms).toISOString().slice(0, 10);

/**
 * Populate `session_outcomes_agg` for ~5 of the user's sessions. Reads
 * the existing `sessions_agg` rows (seeded by v2) and writes outcome
 * rows linked by composite PK. Sessions without an `sessions_agg` row
 * yet are silently skipped.
 */
const seedPersonalOutcomes = async (
  db: Db,
  userId: string,
  count: number,
): Promise<number> => {
  const sessions = await db
    .select({ sessionId: sessionsAgg.sessionId })
    .from(sessionsAgg)
    .where(sql`${sessionsAgg.userId} = ${userId}`)
    .limit(count);

  let written = 0;
  for (const s of sessions) {
    await db
      .insert(sessionOutcomesAgg)
      .values({
        userId,
        sessionId: s.sessionId,
        commitCount: 2,
        locAdded: 40,
        locRemoved: 10,
        filesChanged: 3,
        revertsWithin7d: 0,
        mergedPrCount: 1,
        outcomeStatus: 'evaluated',
      })
      .onConflictDoUpdate({
        target: [sessionOutcomesAgg.userId, sessionOutcomesAgg.sessionId],
        set: {
          commitCount: 2,
          locAdded: 40,
          locRemoved: 10,
          filesChanged: 3,
          revertsWithin7d: 0,
          mergedPrCount: 1,
          outcomeStatus: 'evaluated',
        },
      });
    written += 1;
  }
  return written;
};

/**
 * Populate `team_outcomes_daily` directly (skips running the cron in
 * the seed). Creates 7 days × N teams of synthetic-but-realistic data.
 */
const seedTeamOutcomes = async (
  db: Db,
  orgId: string,
  teamIds: ReadonlyArray<string>,
  days = 7,
): Promise<number> => {
  let written = 0;
  for (let dayOffset = 0; dayOffset < days; dayOffset += 1) {
    const day = isoDay(ANCHOR_UTC_MS - dayOffset * DAY_MS);
    for (const [teamIdx, teamId] of teamIds.entries()) {
      // Vary numbers per team so the per-team table renders distinct
      // values (TC-E2E-01 visual sanity).
      const factor = teamIdx + 1;
      await db
        .insert(teamOutcomesDaily)
        .values({
          orgId,
          teamId,
          day,
          totalCommits: 5 * factor,
          totalLocAdded: 100 * factor,
          totalLocRemoved: 25 * factor,
          totalFilesChanged: 8 * factor,
          totalRevertsWithin7d: 1,
          totalMergedPrCount: 2 * factor,
          totalInputTokens: 10_000 * factor,
          totalOutputTokens: 5_000 * factor,
          totalCostUsd: (0.5 * factor).toFixed(6),
          sessionsWithOutcome: 5 * factor,
        })
        .onConflictDoUpdate({
          target: [
            teamOutcomesDaily.orgId,
            teamOutcomesDaily.teamId,
            teamOutcomesDaily.day,
          ],
          set: {
            totalCommits: 5 * factor,
            totalLocAdded: 100 * factor,
            totalLocRemoved: 25 * factor,
            totalFilesChanged: 8 * factor,
            totalRevertsWithin7d: 1,
            totalMergedPrCount: 2 * factor,
            totalInputTokens: 10_000 * factor,
            totalOutputTokens: 5_000 * factor,
            totalCostUsd: (0.5 * factor).toFixed(6),
            sessionsWithOutcome: 5 * factor,
          },
        });
      written += 1;
    }
  }
  return written;
};

export const seedManagerV3Outcomes = async (db: Db): Promise<void> => {
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.ALLOW_PRODUCTION_SEED !== '1'
  ) {
    throw new Error(
      'seedManagerV3Outcomes: refusing to run with NODE_ENV=production.',
    );
  }

  // Verify v2 seed has run (Alpha + at least one team must exist).
  const alphaOrgId = stableUuid('org:org-alpha');
  const result = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(teams)
    .where(eq(teams.orgId, alphaOrgId));
  const count = result[0]?.count ?? 0;
  if (count === 0) {
    throw new Error(
      'seed-manager-v3-outcomes: seed-manager-v2.ts must run first '
        + '(no teams under Alpha Co).',
    );
  }

  // Resolve Alpha team IDs. Match the slugs from seed-manager-v2.ts.
  const alphaTeamIds = [
    stableUuid('team:org-alpha:team-frontend'),
    stableUuid('team:org-alpha:team-backend'),
    stableUuid('team:org-alpha:team-platform'),
  ];

  // Seed personal outcomes for the alpha-frontend admin user (matches
  // seed-server.ts --e2e fixture).
  const adminUserId = stableUuid('user:org-alpha:alice');
  const personalCount = await seedPersonalOutcomes(db, adminUserId, 5);

  // Seed team rollups for Alpha (3 teams × 7 days).
  const teamRowsCount = await seedTeamOutcomes(db, alphaOrgId, alphaTeamIds);

  process.stdout.write(
    `seed-manager-v3-outcomes: ${personalCount} personal outcome rows, `
      + `${teamRowsCount} team_outcomes_daily rows for Alpha. `
      + 'Gamma left empty by design (TC-E2E-02 exercises empty branch).\n',
  );
};

// CLI shim — when invoked directly via tsx.
if (require.main === module) {
  void (async () => {
    try {
      const db = getDb();
      await seedManagerV3Outcomes(db);
      await closeDb();
      process.exit(0);
    } catch (e) {
      console.error(e);
      process.exit(1);
    }
  })();
}
