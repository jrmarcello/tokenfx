#!/usr/bin/env node
/**
 * Host-side smoke reset orchestrator (TASK-RESET-ROOT).
 *
 * Drives the three reset surfaces needed before every smoke run:
 *   1. Root SQLite — wipes `data/dashboard.db{,-wal,-shm}` so the host
 *      Next.js process re-creates an empty DB on next ingest. Idempotent:
 *      missing files are skipped without throwing.
 *   2. Server reset — invokes `apps/server/scripts/smoke-reset.ts` inside
 *      the `tokenfx-server` container via `docker compose exec`. The
 *      in-container script TRUNCATEs the PG schema. Fails fast on
 *      non-zero exit code, propagating stdout for diagnosability.
 *   3. idp-stub reset — POST to the in-container scenario admin endpoint
 *      to clear simulated user/session state. Fails fast on non-2xx.
 *
 * External effects (process spawn + HTTP) are injected via `opts.executor`
 * and `opts.fetchFn` so unit tests can exercise every branch without
 * Docker. Defaults use Node's stdlib (`child_process.spawn` + global
 * `fetch`) — no extra runtime dependency.
 *
 * Usage:
 *   pnpm tsx scripts/smoke-reset.ts
 */
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Result } from '@/lib/result';

/**
 * Minimal shape of a command-runner: enough for the orchestrator to
 * decide success/failure and surface diagnostic output. Kept narrow so
 * test stubs are trivial to author.
 */
export type Executor = (
  cmd: string,
  args: string[],
) => Promise<{ exitCode: number; stdout: string }>;

const SQLITE_FILES = [
  'data/dashboard.db',
  'data/dashboard.db-wal',
  'data/dashboard.db-shm',
] as const;

const IDP_RESET_URL = 'http://localhost:3001/admin/scenario/reset';

const SERVER_RESET_ARGS = [
  'compose',
  '--profile',
  'smoke',
  'exec',
  '-T',
  'tokenfx-server',
  'node',
  'dist/scripts/smoke-reset.js',
] as const;

const defaultExecutor: Executor = (cmd, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      // Surface stderr alongside stdout so the orchestrator's error
      // message captures everything the operator needs.
      const combined = stderr ? `${stdout}\n${stderr}` : stdout;
      resolve({ exitCode: code ?? 0, stdout: combined });
    });
  });

/**
 * Idempotent SQLite cleanup. Resolves paths against `process.cwd()` so the
 * caller controls the root via shell (consistent with `pnpm tsx`).
 */
const resetSqlite = (): void => {
  for (const rel of SQLITE_FILES) {
    const abs = join(process.cwd(), rel);
    if (existsSync(abs)) {
      unlinkSync(abs);
    }
  }
};

export const smokeReset = async (opts?: {
  executor?: Executor;
  fetchFn?: typeof fetch;
}): Promise<Result<void, Error>> => {
  const exec = opts?.executor ?? defaultExecutor;
  const fetchFn = opts?.fetchFn ?? fetch;

  // 1. SQLite root — must be idempotent.
  resetSqlite();

  // 2. Server reset inside container.
  const serverReset = await exec('docker', [...SERVER_RESET_ARGS]);
  if (serverReset.exitCode !== 0) {
    return {
      ok: false,
      error: new Error(`server reset failed: ${serverReset.stdout}`),
    };
  }

  // 3. idp-stub scenario reset.
  const stubReset = await fetchFn(IDP_RESET_URL, {
    method: 'POST',
    headers: { origin: 'http://localhost' },
  });
  if (!stubReset.ok) {
    return {
      ok: false,
      error: new Error(`idp-stub reset HTTP ${stubReset.status}`),
    };
  }

  return { ok: true, value: undefined };
};

// CLI entrypoint — only runs when invoked directly via `tsx scripts/smoke-reset.ts`,
// not when imported (e.g. by the test file).
const isDirectInvocation = (): boolean => {
  if (typeof process.argv[1] !== 'string') return false;
  try {
    return fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
};

if (isDirectInvocation()) {
  void (async () => {
    const result = await smokeReset();
    if (!result.ok) {
      // CLI exception: direct stderr write (no logger pull-in for a one-shot script).
      process.stderr.write(`smoke-reset failed: ${result.error.message}\n`);
      process.exit(1);
    }
    process.stdout.write('smoke-reset complete\n');
  })();
}
