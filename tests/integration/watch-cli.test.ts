import { spawn } from 'node:child_process';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

describe('pnpm watch CLI', () => {
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
          // Ensure no env gate interferes; CLI runs regardless
          TOKENFX_DISABLE_AUTO_INGEST: undefined,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    try {
      // Wait up to 15s for the [watch] ready line
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ready timeout')), 15_000);
        cli.stdout.on('data', (chunk: Buffer) => {
          if (chunk.toString().includes('[watch] ready')) {
            clearTimeout(timer);
            resolve();
          }
        });
        cli.stderr.on('data', (chunk: Buffer) => {
          if (chunk.toString().includes('[watch] ready')) {
            clearTimeout(timer);
            resolve();
          }
        });
        cli.on('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`CLI exited early with code ${code}`));
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
