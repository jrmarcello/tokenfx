/**
 * Integration tests for `apps/server/scripts/smoke-seed.ts`
 * (TASK-SEED-SERVER of `.specs/cross-stack-smoke-validation.md`).
 *
 * Covers:
 *   - TC-U-08 (security): `.env.smoke` written with REPORTER_BEARER_SECRET (hex string,
 *     len > 32) AND REPORTER_PROJECT_SECRET (64 hex chars). Uses a temp dir for
 *     isolation — the smoke seed default writes to CWD-relative `.env.smoke`.
 *   - TC-I-10 (business): post-seed PG state — 1 org "Smoke Co", 2 users
 *     (manager + member), 1 machine, 1 invite (active, non-revoked), role `tokenfx`
 *     exists OR a warn was emitted by the seed when superuser rights are absent,
 *     0 ingestion_log rows.
 *   - TC-I-11 (infra): when `DATABASE_URL` points to an unreachable Postgres
 *     (e.g. `postgres://localhost:1` — connect refuses), the seed fails fast
 *     with an `ECONNREFUSED` error and does NOT hang.
 *
 * Postgres-backed (via the shared Testcontainer in `tests/integration/setup-pg.ts`)
 * for TC-I-10, and uses a deliberately unreachable URL for TC-I-11. Skipped when
 * `SKIP_PG_TESTS=1` for the PG-dependent TCs.
 *
 * No mocking framework — hand-written stubs / temp dirs only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from '@/lib/db/client';
import { runSmokeSeed } from './smoke-seed';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

const rowsOf = <T>(result: unknown): readonly T[] => {
  if (Array.isArray(result)) return result as readonly T[];
  const r = (result as { rows?: readonly T[] }).rows;
  return r ?? [];
};

const truncateAll = async (): Promise<void> => {
  const db = getDb();
  await db.execute(sql`TRUNCATE TABLE
    onboarding_redemption_log, onboarding_audit_log, onboarding_invites,
    ingestion_log, model_breakdown_agg, tool_count_agg, sessions_agg,
    cost_calibration_per_user, user_machines, users, teams, orgs
    RESTART IDENTITY CASCADE`);
};

const countOf = async (table: string): Promise<number> => {
  const db = getDb();
  const result = await db.execute<{ count: number }>(
    sql.raw(`SELECT COUNT(*)::int AS count FROM ${table}`),
  );
  const rows = rowsOf<{ count: number }>(result);
  return rows.length > 0 ? Number(rows[0].count) : 0;
};

/**
 * Capture a snapshot of warnings emitted by the seed. The seed surfaces a
 * structured `warnings` array on `SmokeSeedResult` so tests do not depend on
 * stderr scraping.
 */
const collectWarnings = (result: { warnings: readonly string[] }): readonly string[] => {
  return result.warnings;
};

skipDescribe('smoke-seed (apps/server) — TC-I-10 business', () => {
  let tempDir: string;

  beforeAll(async () => {
    // Confirm PG up via the shared testcontainer.
    await truncateAll();
  });

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'smoke-seed-test-'));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    await truncateAll();
    await closeDb();
  });

  it('seeds exactly 1 org "Smoke Co" + 2 users + 1 machine + 1 invite + 0 ingestion_log', async () => {
    const result = await runSmokeSeed({
      databaseUrl: process.env.DATABASE_URL ?? '',
      envSmokePath: join(tempDir, '.env.smoke'),
    });

    if (!result.ok) {
      throw new Error(`seed failed: ${result.error.message}`);
    }
    expect(result.ok).toBe(true);

    // Org
    const db = getDb();
    const orgRows = rowsOf<{ name: string }>(
      await db.execute<{ name: string }>(sql`SELECT name FROM orgs`),
    );
    expect(orgRows).toHaveLength(1);
    expect(orgRows[0]?.name).toBe('Smoke Co');

    // Users — 1 manager + 1 member
    const userRows = rowsOf<{ email: string; role: string }>(
      await db.execute<{ email: string; role: string }>(
        sql`SELECT email, role FROM users ORDER BY email`,
      ),
    );
    expect(userRows).toHaveLength(2);
    expect(userRows.map((u) => u.email)).toEqual([
      'smoke-user-1@example.com',
      'smoke-user-2@example.com',
    ]);
    expect(userRows.map((u) => u.role)).toEqual(['manager', 'member']);

    // Machine (1 — only for user-1)
    expect(await countOf('user_machines')).toBe(1);
    const machineRows = rowsOf<{ key_id: string }>(
      await db.execute<{ key_id: string }>(sql`SELECT key_id FROM user_machines`),
    );
    expect(machineRows[0]?.key_id).toBe('key-smoke-001');

    // Invite — active, non-revoked, valid expires_at, email_pattern matches user-3.
    const inviteRows = rowsOf<{
      email_pattern: string | null;
      revoked_at: Date | null;
      expires_at: Date;
    }>(
      await db.execute<{
        email_pattern: string | null;
        revoked_at: Date | null;
        expires_at: Date;
      }>(
        sql`SELECT email_pattern, revoked_at, expires_at FROM onboarding_invites`,
      ),
    );
    expect(inviteRows).toHaveLength(1);
    expect(inviteRows[0]?.email_pattern).toBe('smoke-user-3@example.com');
    expect(inviteRows[0]?.revoked_at).toBeNull();
    expect(new Date(inviteRows[0]!.expires_at).getTime()).toBeGreaterThan(Date.now());

    // Ingestion_log untouched by seed (it only writes via the ingest route).
    expect(await countOf('ingestion_log')).toBe(0);

    // role `tokenfx` either exists (we have superuser) OR a warn was emitted.
    const roleRows = rowsOf<{ rolname: string }>(
      await db.execute<{ rolname: string }>(
        sql`SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = 'tokenfx'`,
      ),
    );
    const roleExists = roleRows.length > 0;
    const warnings = collectWarnings(result.ok ? result.value : { warnings: [] });
    const warnedAboutRole = warnings.some((w) => /tokenfx/i.test(w) && /role/i.test(w));
    expect(roleExists || warnedAboutRole).toBe(true);
  });
});

skipDescribe('smoke-seed (apps/server) — TC-U-08 security: .env.smoke shape', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'smoke-seed-env-'));
    await truncateAll();
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    await truncateAll();
    await closeDb();
  });

  it('writes both REPORTER_BEARER_SECRET (hex, len > 32) and REPORTER_PROJECT_SECRET (64 hex chars) to .env.smoke', async () => {
    const envPath = join(tempDir, '.env.smoke');

    const result = await runSmokeSeed({
      databaseUrl: process.env.DATABASE_URL ?? '',
      envSmokePath: envPath,
    });

    expect(result.ok).toBe(true);
    expect(existsSync(envPath)).toBe(true);

    const content = readFileSync(envPath, 'utf-8');

    // REPORTER_BEARER_SECRET — hex (only [0-9a-f]), len > 32. Spec says
    // 32 random bytes → hex = 64 chars; > 32 is the explicit lower bound.
    const bearerMatch = content.match(/^REPORTER_BEARER_SECRET=([0-9a-f]+)$/m);
    expect(bearerMatch).not.toBeNull();
    expect(bearerMatch![1]!.length).toBeGreaterThan(32);

    // REPORTER_PROJECT_SECRET — 64 hex chars (32 random bytes).
    const projectMatch = content.match(/^REPORTER_PROJECT_SECRET=([0-9a-f]+)$/m);
    expect(projectMatch).not.toBeNull();
    expect(projectMatch![1]!.length).toBe(64);

    // REPORTER_KEY_ID + REPORTER_TARGET_URL also present (Design §4 invariants).
    expect(content).toMatch(/^REPORTER_KEY_ID=key-smoke-001$/m);
    // REPORTER_TARGET_URL is the BASE URL only (no /api/ingest suffix);
    // the reporter client appends the path itself. Changed in c1d37ef
    // (smoke gap-fix) — the previous form with the suffix double-pathed.
    expect(content).toMatch(/^REPORTER_TARGET_URL=http:\/\/localhost:3232$/m);
  });
});

// TC-I-11: unreachable PG → fail-fast with ECONNREFUSED message.
// This test does NOT need a working PG (it tests the failure mode), so it
// runs even when SKIP_PG_TESTS=1.
describe('smoke-seed (apps/server) — TC-I-11 infra: unreachable PG', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'smoke-seed-unreach-'));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fails fast with a clear ECONNREFUSED error when DATABASE_URL points to an unreachable PG (no hang)', async () => {
    // 127.0.0.1:1 — privileged port, nothing listens, connect refuses
    // immediately (kernel-level RST). No DNS round-trip, no timeout window.
    const unreachable = 'postgres://tokenfx:fake@127.0.0.1:1/tokenfx_smoke';

    const start = Date.now();
    const result = await runSmokeSeed({
      databaseUrl: unreachable,
      envSmokePath: join(tempDir, '.env.smoke'),
    });
    const elapsedMs = Date.now() - start;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Clear error message — ECONNREFUSED must be surfaced verbatim or the
      // operator cannot diagnose the failure.
      expect(result.error.message).toMatch(/ECONNREFUSED/);
    }
    // No hang — refuse-port failure should return well under a typical TCP
    // SYN retransmission window. 5s gives us margin while still catching a
    // pathological 60s default Pool timeout.
    expect(elapsedMs).toBeLessThan(5_000);
  }, 10_000);
});
