// SEED VALUES (assert in runbook):
//   sessions:          seed-smoke-1, seed-smoke-2, seed-smoke-3
//   total_cost_usd:    10.00 + 15.00 + 17.50 = 42.50 USD
//   turn_count:        5, 8, 12
//   tool_call_count:   10, 15, 25
//   total_cost_usd_otel: NULL, 0.40, NULL  (mix exercises calibration code paths)
//
// `scripts/smoke-seed.ts` writes the dataset *directly* to SQLite (bypasses
// the JSONL parser). The intentional trade-off: exact values for runbook
// assertions. The parser's idempotency contract is covered separately by
// `tests/integration/ingest-idempotency.test.ts` (REQ-8 / TC-I-12).

import { openDatabase, type DB } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';
import { log } from '@tokenfx/shared/logger';
import type { Result } from '@/lib/result';

/**
 * The exact, immutable values produced by smokeSeed(). Exported so callers
 * (tests, runbook tooling, downstream cross-stack assertions in the reporter
 * integration test) can assert against a single source of truth.
 */
export const SMOKE_SEED_VALUES = {
  sessionCount: 3,
  totalCostUsdSum: 42.5,
  sessions: [
    {
      id: 'seed-smoke-1',
      total_cost_usd: 10.0,
      turn_count: 5,
      tool_call_count: 10,
      total_cost_usd_otel: null,
    },
    {
      id: 'seed-smoke-2',
      total_cost_usd: 15.0,
      turn_count: 8,
      tool_call_count: 15,
      total_cost_usd_otel: 0.4,
    },
    {
      id: 'seed-smoke-3',
      total_cost_usd: 17.5,
      turn_count: 12,
      tool_call_count: 25,
      total_cost_usd_otel: null,
    },
  ] as const,
} as const;

// Deterministic timestamps — no Date.now() in the payload so re-running the
// seed produces byte-identical rows (TC-U-06 idempotency).
// Anchor: 2026-01-01T00:00:00Z = 1767225600000 ms epoch.
const ANCHOR_MS = 1_767_225_600_000;
const HOUR_MS = 3_600_000;

type SmokeSession = {
  id: string;
  cwd: string;
  project: string;
  git_branch: string;
  cc_version: string;
  started_at: number;
  ended_at: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  total_cost_usd: number;
  total_cost_usd_otel: number | null;
  turn_count: number;
  tool_call_count: number;
  source_file: string;
  ingested_at: number;
};

const SMOKE_SESSIONS: readonly SmokeSession[] = [
  {
    id: 'seed-smoke-1',
    cwd: '/Users/smoke/project-a',
    project: 'smoke-project-a',
    git_branch: 'main',
    cc_version: '2.0.0',
    started_at: ANCHOR_MS,
    ended_at: ANCHOR_MS + 1 * HOUR_MS,
    total_input_tokens: 50_000,
    total_output_tokens: 8_000,
    total_cache_read_tokens: 100_000,
    total_cache_creation_tokens: 5_000,
    total_cost_usd: 10.0,
    total_cost_usd_otel: null,
    turn_count: 5,
    tool_call_count: 10,
    source_file: 'smoke://seed-smoke-1.jsonl',
    ingested_at: ANCHOR_MS,
  },
  {
    id: 'seed-smoke-2',
    cwd: '/Users/smoke/project-b',
    project: 'smoke-project-b',
    git_branch: 'main',
    cc_version: '2.0.0',
    started_at: ANCHOR_MS + 2 * HOUR_MS,
    ended_at: ANCHOR_MS + 4 * HOUR_MS,
    total_input_tokens: 80_000,
    total_output_tokens: 12_000,
    total_cache_read_tokens: 150_000,
    total_cache_creation_tokens: 8_000,
    total_cost_usd: 15.0,
    total_cost_usd_otel: 0.4,
    turn_count: 8,
    tool_call_count: 15,
    source_file: 'smoke://seed-smoke-2.jsonl',
    ingested_at: ANCHOR_MS,
  },
  {
    id: 'seed-smoke-3',
    cwd: '/Users/smoke/project-c',
    project: 'smoke-project-c',
    git_branch: 'main',
    cc_version: '2.0.0',
    started_at: ANCHOR_MS + 5 * HOUR_MS,
    ended_at: ANCHOR_MS + 8 * HOUR_MS,
    total_input_tokens: 120_000,
    total_output_tokens: 20_000,
    total_cache_read_tokens: 220_000,
    total_cache_creation_tokens: 12_000,
    total_cost_usd: 17.5,
    total_cost_usd_otel: null,
    turn_count: 12,
    tool_call_count: 25,
    source_file: 'smoke://seed-smoke-3.jsonl',
    ingested_at: ANCHOR_MS,
  },
] as const;

/**
 * Seeds the database with the deterministic smoke dataset.
 *
 * Idempotent: re-running deletes any pre-existing `seed-smoke-*` rows before
 * inserting, so counts stay constant across repeated runs (TC-U-06).
 *
 * Uses prepared statements with parameter binding throughout. Wrapped in a
 * single transaction so a mid-run failure leaves the DB unchanged.
 */
export const smokeSeed = (db: DB): Result<{ inserted: number }, Error> => {
  try {
    const deleteSessions = db.prepare(
      "DELETE FROM sessions WHERE id LIKE 'seed-smoke-%'",
    );
    const insertSession = db.prepare(
      `INSERT INTO sessions (
         id, slug, cwd, project, git_branch, cc_version,
         started_at, ended_at,
         total_input_tokens, total_output_tokens,
         total_cache_read_tokens, total_cache_creation_tokens,
         total_cost_usd, total_cost_usd_otel,
         turn_count, tool_call_count,
         source_file, ingested_at
       ) VALUES (
         @id, NULL, @cwd, @project, @git_branch, @cc_version,
         @started_at, @ended_at,
         @total_input_tokens, @total_output_tokens,
         @total_cache_read_tokens, @total_cache_creation_tokens,
         @total_cost_usd, @total_cost_usd_otel,
         @turn_count, @tool_call_count,
         @source_file, @ingested_at
       )`,
    );

    const runTx = db.transaction(() => {
      // Idempotency: remove any prior smoke seed rows (turns/tool_calls cascade
      // via FK ON DELETE CASCADE; reporter_pushed_sessions / session_outcomes
      // similarly cascade).
      deleteSessions.run();
      for (const s of SMOKE_SESSIONS) {
        insertSession.run(s);
      }
    });
    runTx();

    return { ok: true, value: { inserted: SMOKE_SESSIONS.length } };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
};

const seedRootSqlite = (): number => {
  const dbPath = process.env.DASHBOARD_DB_PATH ?? './data/dashboard.db';
  const db = openDatabase(dbPath);
  try {
    migrate(db);
    const result = smokeSeed(db);
    if (!result.ok) {
      log.error('smoke-seed failed:', result.error.message);
      return 1;
    }
    log.info(
      `smoke-seed: wrote ${result.value.inserted} sessions; SUM(total_cost_usd)=${SMOKE_SEED_VALUES.totalCostUsdSum} (db=${dbPath})`,
    );
    return 0;
  } catch (err) {
    log.error(
      'smoke-seed failed:',
      err instanceof Error ? err.message : String(err),
    );
    return 1;
  } finally {
    db.close();
  }
};

/**
 * Run the apps/server smoke-seed inside the tokenfx-server container, then
 * docker-cp the generated .env.smoke back to the host repo root. Splits
 * into two `docker compose exec` calls so the bundled smoke-seed writes
 * to `/work/.env.smoke` (a tmpfs path) and the host pulls it.
 *
 * Skipped when `SMOKE_SKIP_SERVER=1` (useful for SQLite-only validation).
 */
const seedServerPg = async (): Promise<number> => {
  if (process.env.SMOKE_SKIP_SERVER === '1') {
    log.info('SMOKE_SKIP_SERVER=1 — skipping server-side seed.');
    return 0;
  }
  const { spawnSync } = await import('node:child_process');
  // /tmp is world-writable; /app is root-owned and the container runs as
  // UID 1001 (tokenfx-server), so /tmp is the only writable target for a
  // host-relative .env.smoke artifact.
  const ENV_SMOKE_IN_CONTAINER = '/tmp/.env.smoke';
  const exec = (args: string[]): { exitCode: number; stdout: string; stderr: string } => {
    const r = spawnSync('docker', args, { encoding: 'utf-8' });
    return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };

  log.info('smoke-seed: running server seed via docker exec…');
  const seedRes = exec([
    'compose', '--profile', 'smoke', 'exec', '-T',
    '--workdir', '/app/apps/server',
    'tokenfx-server',
    'node', '/app/dist/scripts/smoke-seed.js', ENV_SMOKE_IN_CONTAINER,
  ]);
  if (seedRes.exitCode !== 0) {
    log.error('smoke-seed: server seed failed:', seedRes.stderr || seedRes.stdout);
    return 1;
  }
  log.info(seedRes.stdout.trim());

  const cpRes = exec([
    'compose', '--profile', 'smoke', 'cp',
    `tokenfx-server:${ENV_SMOKE_IN_CONTAINER}`,
    '.env.smoke',
  ]);
  if (cpRes.exitCode !== 0) {
    log.error('smoke-seed: docker cp .env.smoke failed:', cpRes.stderr);
    return 1;
  }
  log.info('smoke-seed: wrote .env.smoke (host)');

  // ALSO write `data/reporter-config.json` with the same secrets — that's
  // what `runReporter()` actually reads (config.ts:DEFAULT_CONFIG_PATH).
  // Without this step the runbook's `pnpm reporter:once` 401s because the
  // reporter sends the OLD secret from the pre-existing config file while
  // the server-side hash was rotated by this seed. The .env.smoke artifact
  // is what the user copies / sources for manual debugging; the JSON file
  // is what the reporter actually consumes.
  const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
  const envContents = readFileSync('.env.smoke', 'utf-8');
  const envMap: Record<string, string> = {};
  for (const line of envContents.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m && m[1] && m[2]) envMap[m[1]] = m[2];
  }
  const reporterConfig = {
    key_id: envMap.REPORTER_KEY_ID,
    secret: envMap.REPORTER_BEARER_SECRET,
    machine_id: '00000000-0000-4000-8000-aaaa0000aaaa',
    user_email: 'smoke-user-1@example.com',
    central_url: envMap.REPORTER_TARGET_URL,
    project_secret: envMap.REPORTER_PROJECT_SECRET,
  };
  mkdirSync('data', { recursive: true });
  writeFileSync(
    'data/reporter-config.json',
    JSON.stringify(reporterConfig),
    { mode: 0o600 },
  );
  log.info('smoke-seed: wrote data/reporter-config.json (host)');
  return 0;
};

const main = async (): Promise<number> => {
  const sqliteRc = seedRootSqlite();
  if (sqliteRc !== 0) return sqliteRc;
  return await seedServerPg();
};

// CLI entry — only run when invoked directly via tsx, not when imported by
// tests. `import.meta.url` matches `process.argv[1]` only at top-level.
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    const argvUrl = new URL(`file://${process.argv[1]}`).href;
    return import.meta.url === argvUrl;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  void main().then((code) => process.exit(code));
}
