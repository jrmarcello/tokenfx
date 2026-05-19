/**
 * `spawn-with-log` — capture spawned-child stdout/stderr to a log file
 * with line-by-line flushing + id_token redaction.
 *
 * Spec: `.specs/fix-sso-e2e-remaining-5.md` TASK-0.
 *
 * Why we need this: the existing `global-setup.ts` spawns the dev-server
 * and idp-stub with `stdio: 'inherit'`. Inherited stderr goes to the
 * parent process's stderr, which Playwright's reporter does NOT persist
 * to disk — so when a test fails with a next-auth error, the diagnostic
 * line vanishes after the test run ends. This module replaces `inherit`
 * with `['ignore', 'pipe', 'pipe']` and routes each child's stdout/stderr
 * through readline (line-by-line flush) → redaction → fs.WriteStream.
 *
 * Why readline (not raw pipe): Node's `fs.WriteStream` is block-buffered
 * by the OS. Raw `child.stdout.pipe(writeStream)` writes chunks based
 * on buffer pressure, so a log line may sit in memory until pressure
 * builds. `readline.createInterface` emits `'line'` events as soon as
 * a `\n` is seen, giving us true line-by-line flushing — enabling
 * `tail -f` in a second terminal during a live test run.
 *
 * Why redaction: Threat Model item 3 of the spec — Auth.js v5 may log
 * `id_token=eyJ...` substrings in debug mode; captured log files must
 * not persist raw bearer tokens.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createWriteStream, type WriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { ChildProcess, StdioOptions } from 'node:child_process';

import { log as logger } from '@root/logger';

import { redactIdTokenLine } from './redact-id-token';

/**
 * Safe-label regex: lowercase letters, digits, hyphens. No path separators,
 * no parent traversal, no whitespace. Bounds the `<label>.log` filename
 * to a known shape so callers can't accidentally write to `/etc/passwd`
 * or escape `logsDir` via `..`.
 */
const SAFE_LABEL_RE = /^[a-z][a-z0-9-]*$/;

export type SpawnOptionsWithLog = Readonly<{
  /** Pinned spawn `stdio` triple — `'ignore'` stdin, `'pipe'` stdout+stderr. */
  stdio: StdioOptions;
  /** Absolute path of the destination log file (`<logsDir>/<label>.log`). */
  logPath: string;
}>;

/**
 * Build the `stdio` triple + resolved log path for a spawned child.
 * Pure function — does not touch the filesystem or call `spawn`. The
 * runtime pipe wiring happens in `pipeChildToFile`.
 */
export const buildSpawnOptions = (
  label: string,
  logsDir: string,
): SpawnOptionsWithLog => {
  if (!SAFE_LABEL_RE.test(label)) {
    throw new Error(
      `spawn-with-log: invalid label ${JSON.stringify(label)} — must match ${SAFE_LABEL_RE.source}`,
    );
  }
  return {
    stdio: ['ignore', 'pipe', 'pipe'] as const,
    logPath: path.resolve(logsDir, `${label}.log`),
  };
};

export type PipeChildToFileResult = Readonly<{
  /** The write stream piping the child output. Exposed so callers
   *  (e.g. integration tests) can force an error event for resilience
   *  assertions. */
  writeStream: WriteStream;
  /** Resolved log path used by the write stream. */
  logPath: string;
}>;

/**
 * Wires a spawned child's stdout + stderr through readline (line-by-line
 * flush) and the redaction transform into a `WriteStream` appending to
 * `<logsDir>/<label>.log`.
 *
 * Creates `logsDir` (recursively, idempotent) before opening the write
 * stream. Returns a Promise that resolves once both stdout and stderr
 * readline interfaces are attached — the child process will be running
 * by then; callers do NOT need to await before treating the child as
 * "alive".
 *
 * Failure modes:
 *   - mkdir failure (e.g. parent is a regular file, ENOENT, EACCES) →
 *     Promise rejects with the OS error, original path preserved in
 *     `err.path`.
 *   - WriteStream `'error'` event after wiring → logged as a warning;
 *     the child process is NOT killed (the parent test harness owns
 *     child lifecycle).
 */
export const pipeChildToFile = async (
  child: ChildProcess,
  label: string,
  logsDir: string,
): Promise<PipeChildToFileResult> => {
  if (!child.stdout || !child.stderr) {
    throw new Error(
      `pipeChildToFile(${label}): child stdout/stderr are not piped — spawn with stdio: ['ignore', 'pipe', 'pipe'].`,
    );
  }
  const { logPath } = buildSpawnOptions(label, logsDir);
  await mkdir(logsDir, { recursive: true });
  const writeStream = createWriteStream(logPath, { flags: 'a' });
  writeStream.on('error', (err) => {
    logger.warn('spawn-with-log: writeStream error', {
      label,
      error_message: err instanceof Error ? err.message : String(err),
    });
  });

  const writeLine = (line: string): void => {
    if (writeStream.destroyed || writeStream.closed) return;
    writeStream.write(`${redactIdTokenLine(line)}\n`);
  };

  const stdoutReader = createInterface({ input: child.stdout });
  const stderrReader = createInterface({ input: child.stderr });
  stdoutReader.on('line', writeLine);
  stderrReader.on('line', writeLine);

  child.once('close', () => {
    stdoutReader.close();
    stderrReader.close();
    if (!writeStream.destroyed) writeStream.end();
  });

  return { writeStream, logPath };
};
