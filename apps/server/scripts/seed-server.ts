#!/usr/bin/env tsx
// apps/server/scripts/seed-server.ts
//
// Admin seed: create org + (optional) team + user + user_machine for v0
// testing of the central server. Production onboarding (invite tokens,
// redeem flow, `pnpm reporter:setup`) lives in the carved-out spec
// `central-server-onboarding.md` — this script is the v0 stand-in so the
// reporter <-> central round-trip can be exercised end-to-end.
//
// Usage:
//   pnpm db:server:migrate                                       # ensure schema
//   tsx apps/server/scripts/seed-server.ts <org> <email> [team]  # seed a row set
//   tsx apps/server/scripts/seed-server.ts --e2e                 # seed deterministic E2E fixture
//
// Single-org mode prints the generated `key_id`, plaintext HMAC `secret`,
// and `machine_id` to stdout so the dev can hand-write
// `data/reporter-config.json` on the reporter side.
//
// E2E mode (TASK-22) seeds a deterministic fixture for Playwright:
//   - 2 orgs (org-alpha, org-beta) named "Alpha Co", "Beta Co"
//   - 2 teams per org (team-frontend, team-backend)
//   - 2-3 users per team with deterministic emails (alice@alpha.test, etc.)
//   - 1 admin + 1 manager per org, rest members
//   - 1 user_machines row per user with deterministic key_id/secret
//   - 30 sessions across users + last 7 days, varied cost/model/tools/rating
//
// E2E mode is fully idempotent: every insert uses
// `.onConflictDoNothing()` so a re-run on a primed DB is a no-op.
//
// DEVIATION (TASK-14): the column `user_machines.secret_hash` currently stores
// the HMAC secret as plaintext, NOT a bcrypt hash. The schema column name is
// kept ("secret_hash") for forward compatibility with the future bcrypt
// migration. Until then, this seed writes the plaintext secret directly.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { closeDb, getDb } from '@/lib/db/client';
import {
  modelBreakdownAgg,
  orgs,
  sessionsAgg,
  teams,
  toolCountAgg,
  userMachines,
  users,
} from '@/lib/db/schema';
import { stableUuid } from '@/lib/e2e/seed-ids';

// --- Single-org seed (preserved from TASK-15) -------------------------------

const printUsageAndExit = (): never => {
  process.stderr.write(
    'Usage: tsx apps/server/scripts/seed-server.ts <org-name> <user-email> [team-name]\n' +
      '       tsx apps/server/scripts/seed-server.ts --e2e\n',
  );
  process.exit(1);
};

const seedSingleOrg = async (
  orgName: string,
  userEmail: string,
  teamName: string | undefined,
): Promise<void> => {
  const db = getDb();

  // 1. Org
  const [org] = await db.insert(orgs).values({ name: orgName }).returning();
  if (!org) throw new Error('failed to insert org');
  process.stdout.write(`org: ${org.id} (${orgName})\n`);

  // 2. Team (optional)
  let teamId: string | null = null;
  if (teamName) {
    const [team] = await db
      .insert(teams)
      .values({ orgId: org.id, name: teamName })
      .returning();
    if (!team) throw new Error('failed to insert team');
    teamId = team.id;
    process.stdout.write(`team: ${team.id} (${teamName})\n`);
  }

  // 3. User (seeded user is the bootstrap admin for the org)
  const [user] = await db
    .insert(users)
    .values({
      orgId: org.id,
      teamId,
      email: userEmail,
      ssoProvider: 'manual-seed',
      ssoSubject: `seed:${userEmail}`,
      role: 'admin',
    })
    .returning();
  if (!user) throw new Error('failed to insert user');
  process.stdout.write(`user: ${user.id} (${userEmail}) role=admin\n`);

  // 4. Machine + HMAC secret
  const machineId = randomUUID();
  const keyId = `k_${randomBytes(8).toString('hex')}`;
  const secret = randomBytes(32).toString('hex');
  await db.insert(userMachines).values({
    userId: user.id,
    machineId,
    keyId,
    // Plaintext per TASK-14 deviation (see module header).
    secretHash: secret,
  });
  process.stdout.write(`machine: ${machineId}\n\n`);

  // 5. data/reporter-config.json template — the dev hand-writes this on
  // the reporter side. `project_secret` is generated locally on first run
  // by `pnpm reporter:setup` (32 random bytes hex), so it is omitted here.
  process.stdout.write('Hand-write this into data/reporter-config.json:\n\n');
  process.stdout.write(
    `${JSON.stringify(
      {
        key_id: keyId,
        secret,
        machine_id: machineId,
        user_email: userEmail,
        central_url: 'http://localhost:3232',
      },
      null,
      2,
    )}\n`,
  );
};

// --- E2E deterministic seed (TASK-22) ---------------------------------------
// `stableUuid` lives in `lib/e2e/seed-ids.ts` so the Playwright suite imports
// the same formula and mints JWTs with the matching orgId. See top-of-file
// imports.

type Role = 'admin' | 'manager' | 'member';

interface E2eUserSpec {
  readonly localPart: string;
  readonly role: Role;
}

interface E2eTeamSpec {
  readonly slug: string;
  readonly name: string;
  readonly users: readonly E2eUserSpec[];
}

interface E2eOrgSpec {
  readonly slug: string;
  readonly name: string;
  readonly teams: readonly E2eTeamSpec[];
}

const E2E_ORGS: readonly E2eOrgSpec[] = [
  {
    slug: 'org-alpha',
    name: 'Alpha Co',
    teams: [
      {
        slug: 'team-frontend',
        name: 'Frontend',
        users: [
          { localPart: 'alice', role: 'admin' },
          { localPart: 'bob', role: 'member' },
          { localPart: 'carol', role: 'member' },
        ],
      },
      {
        slug: 'team-backend',
        name: 'Backend',
        users: [
          { localPart: 'dave', role: 'manager' },
          { localPart: 'erin', role: 'member' },
        ],
      },
    ],
  },
  {
    slug: 'org-beta',
    name: 'Beta Co',
    teams: [
      {
        slug: 'team-frontend',
        name: 'Frontend',
        users: [
          { localPart: 'frank', role: 'admin' },
          { localPart: 'gina', role: 'member' },
        ],
      },
      {
        slug: 'team-backend',
        name: 'Backend',
        users: [
          { localPart: 'henry', role: 'manager' },
          { localPart: 'ivy', role: 'member' },
          { localPart: 'jack', role: 'member' },
        ],
      },
    ],
  },
];

const E2E_MODELS: readonly string[] = [
  'claude-sonnet-4-5-20250929',
  'claude-opus-4-5-20251020',
  'claude-haiku-4-5-20251101',
];

const E2E_TOOLS: readonly string[] = ['Read', 'Edit', 'Bash', 'Grep', 'Write'];

const seedE2e = async (): Promise<void> => {
  const db = getDb();
  let orgCount = 0;
  let teamCount = 0;
  let userCount = 0;
  let machineCount = 0;
  let sessionCount = 0;

  // Flatten user list so we can deterministically distribute sessions.
  const allUsers: { userId: string; orgSlug: string; teamSlug: string; localPart: string }[] = [];

  for (const orgSpec of E2E_ORGS) {
    const orgId = stableUuid(`org:${orgSpec.slug}`);
    await db
      .insert(orgs)
      .values({ id: orgId, name: orgSpec.name })
      .onConflictDoNothing();
    orgCount += 1;

    for (const teamSpec of orgSpec.teams) {
      const teamId = stableUuid(`team:${orgSpec.slug}:${teamSpec.slug}`);
      await db
        .insert(teams)
        .values({ id: teamId, orgId, name: teamSpec.name })
        .onConflictDoNothing();
      teamCount += 1;

      for (const userSpec of teamSpec.users) {
        const userId = stableUuid(`user:${orgSpec.slug}:${userSpec.localPart}`);
        const email = `${userSpec.localPart}@${orgSpec.slug.replace(/^org-/, '')}.test`;
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
        userCount += 1;

        const machineId = stableUuid(`machine:${orgSpec.slug}:${userSpec.localPart}`);
        const keyId = `k_e2e_${orgSpec.slug.replace(/^org-/, '')}_${userSpec.localPart}`;
        // Deterministic secret derived from local-part — never leaves the
        // test container, so a hash is acceptable here. Plaintext per
        // TASK-14 deviation.
        const secret = createHash('sha256')
          .update(`e2e-secret:${orgSpec.slug}:${userSpec.localPart}`)
          .digest('hex');
        await db
          .insert(userMachines)
          .values({
            id: stableUuid(`um:${orgSpec.slug}:${userSpec.localPart}`),
            userId,
            machineId,
            keyId,
            secretHash: secret,
          })
          .onConflictDoNothing();
        machineCount += 1;

        allUsers.push({
          userId,
          orgSlug: orgSpec.slug,
          teamSlug: teamSpec.slug,
          localPart: userSpec.localPart,
        });
      }
    }
  }

  // 30 sessions across the last 7 days, distributed round-robin across users.
  const TOTAL_SESSIONS = 30;
  const now = Date.UTC(2026, 3, 29, 12, 0, 0); // 2026-04-29T12:00:00Z (deterministic anchor)
  const dayMs = 24 * 60 * 60 * 1000;

  for (let i = 0; i < TOTAL_SESSIONS; i += 1) {
    const user = allUsers[i % allUsers.length];
    if (!user) continue;
    const dayOffset = i % 7; // last 7 days
    const startedAtMs = now - dayOffset * dayMs - (i % 5) * 60 * 60 * 1000;
    const endedAtMs = startedAtMs + (10 + (i % 50)) * 60 * 1000; // 10..60 min duration

    const sessionId = `e2e-session-${user.localPart}-${String(i).padStart(2, '0')}`;
    const inputTokens = 1_000 + i * 137;
    const outputTokens = 500 + i * 53;
    const cacheReadTokens = i * 211;
    const cacheCreationTokens = i * 91;
    const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
    // Deterministic cost between $0.10 and $5.00.
    const totalCostUsd = (0.1 + (i * 0.13) % 4.9).toFixed(6);
    const otelCostUsd = (Number(totalCostUsd) * 0.95).toFixed(6);
    const turnCount = 5 + (i % 12);
    const toolCallCount = 3 + (i % 8);
    const avgRating = (((i % 5) + 1) / 1).toFixed(3); // 1.000..5.000
    const cacheHitRatio = totalTokens === 0 ? '0.000' : (cacheReadTokens / totalTokens).toFixed(3);
    const outputInputRatio = inputTokens === 0 ? '0.0000' : (outputTokens / inputTokens).toFixed(4);
    const subagentUsageRatio = ((i % 4) / 10).toFixed(3);
    const projectSlug = `proj-${user.orgSlug}-${i % 3}`;
    const model = E2E_MODELS[i % E2E_MODELS.length] ?? E2E_MODELS[0];
    if (!model) continue;

    // payloadHash is the natural-key dedupe lever in the real ingest path;
    // for the seed we mint a deterministic value tied to the session id.
    const payloadHash = createHash('sha256').update(sessionId).digest('hex');

    await db
      .insert(sessionsAgg)
      .values({
        userId: user.userId,
        sessionId,
        payloadHash,
        startedAt: new Date(startedAtMs),
        endedAt: new Date(endedAtMs),
        projectSlug,
        gitBranch: i % 2 === 0 ? 'main' : 'feature/e2e',
        ccVersion: '1.0.0',
        totalInputTokens: inputTokens,
        totalOutputTokens: outputTokens,
        totalCacheReadTokens: cacheReadTokens,
        totalCacheCreationTokens: cacheCreationTokens,
        totalCostUsd,
        totalCostUsdOtel: otelCostUsd,
        turnCount,
        toolCallCount,
        avgRating,
        cacheHitRatio,
        outputInputRatio,
        subagentUsageRatio,
      })
      .onConflictDoNothing();

    await db
      .insert(modelBreakdownAgg)
      .values({
        userId: user.userId,
        sessionId,
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        costUsd: totalCostUsd,
      })
      .onConflictDoNothing();

    // 1-2 distinct tools per session.
    const toolPrimary = E2E_TOOLS[i % E2E_TOOLS.length];
    const toolSecondary = E2E_TOOLS[(i + 1) % E2E_TOOLS.length];
    if (toolPrimary) {
      await db
        .insert(toolCountAgg)
        .values({
          userId: user.userId,
          sessionId,
          toolName: toolPrimary,
          count: 2 + (i % 5),
        })
        .onConflictDoNothing();
    }
    if (toolSecondary && toolSecondary !== toolPrimary) {
      await db
        .insert(toolCountAgg)
        .values({
          userId: user.userId,
          sessionId,
          toolName: toolSecondary,
          count: 1 + (i % 3),
        })
        .onConflictDoNothing();
    }

    sessionCount += 1;
  }

  process.stdout.write(
    `[seed-e2e] orgs=${orgCount} teams=${teamCount} users=${userCount} machines=${machineCount} sessions=${sessionCount}\n`,
  );
};

// --- Entrypoint -------------------------------------------------------------

const main = async (): Promise<void> => {
  // Refuse to run against a production deployment. The single-org mode prints
  // plaintext HMAC secrets to stdout (TASK-15 v0 stand-in), the E2E mode
  // wipes existing rows via deterministic UUIDs that could collide with real
  // org IDs, and the schema column `secret_hash` currently stores plaintext
  // pending the bcrypt migration (TASK-14 deviation, documented at top of
  // file). All three are unsafe in production. Set ALLOW_PRODUCTION_SEED=1
  // only if you genuinely accept those trade-offs.
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.ALLOW_PRODUCTION_SEED !== '1'
  ) {
    process.stderr.write(
      'seed-server: refusing to run with NODE_ENV=production. ' +
        'Set ALLOW_PRODUCTION_SEED=1 to override.\n',
    );
    process.exit(1);
  }

  const args = process.argv.slice(2);

  try {
    if (args.includes('--e2e')) {
      await seedE2e();
      return;
    }

    const [orgName, userEmail, teamName] = args;
    if (!orgName || !userEmail) printUsageAndExit();
    await seedSingleOrg(orgName, userEmail, teamName);
  } finally {
    await closeDb();
  }
};

main().catch((err: unknown) => {
  process.stderr.write(`seed-server failed: ${err instanceof Error ? err.message : String(err)}\n`);
  void closeDb().finally(() => process.exit(1));
});
