import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';

describe('pnpm watch CLI', () => {
  let tmpDb: string;
  let tmpRoot: string;

  beforeEach(() => {
    // Dedicated scratch DB + watch root per test so the subprocess doesn't
    // fight for locks on `data/dashboard.db` under Vitest's parallel pool
    // (SQLITE_BUSY was the failure mode observed pre-fix).
    tmpDb = path.join(
      os.tmpdir(),
      `watch-cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`,
    );
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-cli-root-'));
  });

  afterEach(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.rmSync(tmpDb + suffix);
      } catch {
        // missing — ignore
      }
    }
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('TC-I-17: starts, logs ready, and shuts down cleanly on SIGTERM', async () => {
    // Run the CLI via `node --import tsx scripts/watch.ts`. We deliberately
    // avoid spawning `pnpm watch` or the `node_modules/.bin/tsx` shell
    // wrapper — both intercept SIGTERM and report exit 143 instead of
    // forwarding the script's clean exit(0), which would defeat the
    // assertion. `node --import tsx` registers the loader in-process so
    // the signal reaches our `shutdown` handler untouched. This still
    // exercises the exact same entry point.
    const repoRoot = path.resolve(__dirname, '../..');
    const cli = spawn(
      process.execPath,
      ['--import', 'tsx', 'scripts/watch.ts'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          // Isolate from the shared `data/dashboard.db` so the subprocess
          // can't race for locks with parallel Vitest workers.
          DASHBOARD_DB_PATH: tmpDb,
          TOKENFX_WATCH_ROOT: tmpRoot,
          TOKENFX_WATCH_BACKFILL: '0',
          TOKENFX_DISABLE_AUTO_INGEST: undefined,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    // Capture stdout + stderr throughout so we can surface the real cause
    // if the subprocess dies early.
    let stdoutBuf = '';
    let stderrBuf = '';
    cli.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
    });
    cli.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    try {
      // Wait up to 15s for the [watch] ready line
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `ready timeout\n--- stdout ---\n${stdoutBuf}\n--- stderr ---\n${stderrBuf}`,
              ),
            ),
          15_000,
        );
        const check = (): void => {
          if (stdoutBuf.includes('[watch] ready') || stderrBuf.includes('[watch] ready')) {
            clearTimeout(timer);
            resolve();
          }
        };
        cli.stdout.on('data', check);
        cli.stderr.on('data', check);
        cli.on('exit', (code) => {
          clearTimeout(timer);
          reject(
            new Error(
              `CLI exited early with code ${code}\n--- stdout ---\n${stdoutBuf}\n--- stderr ---\n${stderrBuf}`,
            ),
          );
        });
      });

      // Graceful shutdown
      const exitPromise = new Promise<number>((resolve) => {
        cli.on('exit', (code) => resolve(code ?? -1));
      });
      cli.kill('SIGTERM');
      const exitCode = await Promise.race([
        exitPromise,
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error('shutdown timeout')), 5000),
        ),
      ]);
      expect(exitCode).toBe(0);
    } finally {
      if (!cli.killed) cli.kill('SIGKILL');
    }
  }, 30_000); // Generous overall test timeout
});
