/**
 * Integration tests for the spawn-with-log pipeline (TASK-0 / TC-I-01..04
 * of `.specs/fix-sso-e2e-remaining-5.md`).
 *
 * These tests spawn real Node child processes and verify the log piping
 * pipeline end-to-end: stdio capture → readline line-by-line flush →
 * redaction transform → fs.WriteStream.
 *
 * No Postgres needed — the existing `tests/integration/setup-pg.ts` global
 * boot still runs (Vitest config), but these tests don't touch the DB.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pipeChildToFile } from './spawn-with-log';

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

describe('spawn-with-log integration', () => {
  let logsDir: string;

  beforeEach(async () => {
    logsDir = await mkdtemp(path.join(tmpdir(), 'tokenfx-logs-'));
  });

  afterEach(async () => {
    await rm(logsDir, { recursive: true, force: true });
  });

  it('TC-I-01 captures child stdout to .logs/<label>.log within 1s', async () => {
    const child = spawn(process.execPath, [
      '-e',
      'console.log("hello-from-child")',
    ]);
    await pipeChildToFile(child, 'child', logsDir);
    // Wait for the child to exit (close event guarantees stdout drained
    // through readline).
    await new Promise<void>((resolve) => child.on('close', () => resolve()));
    // Small grace period for the WriteStream `write()` callback to flush
    // the readline-emitted line. WriteStream flushes synchronously to the
    // OS buffer but the OS may take ms to make it visible via `readFile`.
    await sleep(50);
    const logPath = path.join(logsDir, 'child.log');
    const content = await readFile(logPath, 'utf8');
    expect(content).toContain('hello-from-child');
  });

  it('TC-I-02 mkdir failure surfaces error with the resolved path', async () => {
    // Use a path with a non-directory parent — mkdir(recursive:true) cannot
    // promote a regular file to a directory, so this is a deterministic
    // failure mode that doesn't depend on filesystem permissions
    // (CI runners often run as root and can mkdir anywhere).
    const blocker = path.join(logsDir, 'blocker-file');
    await import('node:fs/promises').then(({ writeFile }) =>
      writeFile(blocker, 'x'),
    );
    const badDir = path.join(blocker, 'cannot-be-a-dir');
    const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
    await expect(
      pipeChildToFile(child, 'child', badDir),
    ).rejects.toThrow(/cannot-be-a-dir|EEXIST|ENOTDIR/);
    // Cleanup the spawned child so the test doesn't leak processes.
    child.kill();
  });

  it('TC-I-03 writeStream error event does not kill the child process', async () => {
    // Long-running child so we can observe its survival after we close
    // the writeStream out from under it.
    const child = spawn(process.execPath, [
      '-e',
      'setInterval(() => console.log("tick"), 50); setTimeout(() => process.exit(0), 2000)',
    ]);
    const { writeStream } = await pipeChildToFile(child, 'child', logsDir);
    // Force a writeStream error by destroying it mid-pipe. The helper's
    // 'error' handler should log a warn and let the child keep running.
    writeStream.destroy(new Error('synthetic EBADF'));
    // Give the child time to keep ticking.
    await sleep(200);
    expect(child.killed).toBe(false);
    expect(child.exitCode).toBe(null);
    child.kill();
  });

  it('TC-I-04 redacts JWT-shaped lines before they hit disk', async () => {
    const child = spawn(process.execPath, [
      '-e',
      'console.log("id_token=eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.signature")',
    ]);
    await pipeChildToFile(child, 'child', logsDir);
    await new Promise<void>((resolve) => child.on('close', () => resolve()));
    await sleep(50);
    const logPath = path.join(logsDir, 'child.log');
    const content = await readFile(logPath, 'utf8');
    expect(content).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(content).toContain('[REDACTED]');
  });

  it('logs directory is created if missing (idempotency probe)', async () => {
    const nested = path.join(logsDir, 'nested', 'twice');
    const child = spawn(process.execPath, ['-e', 'console.log("ok")']);
    await pipeChildToFile(child, 'child', nested);
    await new Promise<void>((resolve) => child.on('close', () => resolve()));
    await sleep(50);
    const st = await stat(path.join(nested, 'child.log'));
    expect(st.isFile()).toBe(true);
  });

  it('appends to existing log file (preserves prior runs)', async () => {
    await mkdir(logsDir, { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    const logPath = path.join(logsDir, 'child.log');
    await writeFile(logPath, 'prior-content\n');
    const child = spawn(process.execPath, ['-e', 'console.log("appended")']);
    await pipeChildToFile(child, 'child', logsDir);
    await new Promise<void>((resolve) => child.on('close', () => resolve()));
    await sleep(50);
    const content = await readFile(logPath, 'utf8');
    expect(content).toContain('prior-content');
    expect(content).toContain('appended');
  });
});
