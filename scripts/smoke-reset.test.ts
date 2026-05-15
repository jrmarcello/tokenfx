import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { smokeReset } from './smoke-reset';

/**
 * Hand-written executor stub. Records every invocation and replies with a
 * scripted result. No mocking framework — pure closure.
 */
type ExecResult = { exitCode: number; stdout: string };
type Invocation = { cmd: string; args: readonly string[] };

const makeExecutorStub = (
  result: ExecResult,
): {
  executor: (cmd: string, args: string[]) => Promise<ExecResult>;
  calls: Invocation[];
} => {
  const calls: Invocation[] = [];
  const executor = async (cmd: string, args: string[]): Promise<ExecResult> => {
    calls.push({ cmd, args: [...args] });
    return result;
  };
  return { executor, calls };
};

/**
 * Hand-written fetch stub. Returns a minimal Response-shaped object covering
 * what `smokeReset` reads (`ok`, `status`). Records every request.
 */
type FetchCall = { url: string; init?: RequestInit };

type FetchResultShape = { ok: boolean; status: number };

const makeFetchStub = (
  result: FetchResultShape,
): {
  fetchFn: typeof fetch;
  calls: FetchCall[];
} => {
  const calls: FetchCall[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    return result as unknown as Response;
  };
  return { fetchFn, calls };
};

/**
 * Each test gets its own temp dir so file operations stay isolated. The
 * production code resolves db paths relative to `process.cwd()`, so we
 * `chdir` into the temp dir for the duration of the test and restore after.
 */
const withTempCwd = async (
  setup: (dir: string) => void | Promise<void>,
  body: () => Promise<void>,
): Promise<void> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenfx-smoke-reset-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    await setup(dir);
    await body();
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

describe('smokeReset', () => {
  // Track any leftover temp dirs in case a test forgot to clean up.
  const createdDirs: string[] = [];
  afterEach(() => {
    for (const d of createdDirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('TC-U-01 (happy): deletes SQLite db + WAL + SHM and returns ok', async () => {
    const { executor, calls: execCalls } = makeExecutorStub({
      exitCode: 0,
      stdout: 'server reset complete',
    });
    const { fetchFn, calls: fetchCalls } = makeFetchStub({
      ok: true,
      status: 200,
    });

    await withTempCwd(
      (dir) => {
        const dataDir = path.join(dir, 'data');
        fs.writeFileSync(path.join(dataDir, 'dashboard.db'), 'fake');
        fs.writeFileSync(path.join(dataDir, 'dashboard.db-wal'), 'fake');
        fs.writeFileSync(path.join(dataDir, 'dashboard.db-shm'), 'fake');
      },
      async () => {
        const result = await smokeReset({ executor, fetchFn });

        expect(result.ok).toBe(true);
        // SQLite files are gone
        expect(fs.existsSync('data/dashboard.db')).toBe(false);
        expect(fs.existsSync('data/dashboard.db-wal')).toBe(false);
        expect(fs.existsSync('data/dashboard.db-shm')).toBe(false);
        // docker exec was invoked correctly
        expect(execCalls).toHaveLength(1);
        expect(execCalls[0]?.cmd).toBe('docker');
        expect(execCalls[0]?.args).toEqual([
          'compose',
          '--profile',
          'smoke',
          'exec',
          '-T',
          '--workdir',
          '/app/apps/server',
          'tokenfx-server',
          'node',
          '/app/dist/scripts/smoke-reset.js',
        ]);
        // idp-stub reset POST was sent
        expect(fetchCalls).toHaveLength(1);
        expect(fetchCalls[0]?.url).toBe(
          'http://localhost:3001/admin/scenario/reset',
        );
        expect(fetchCalls[0]?.init?.method).toBe('POST');
      },
    );
  });

  it('TC-U-02 (edge): does not throw when SQLite files are already absent', async () => {
    const { executor } = makeExecutorStub({ exitCode: 0, stdout: '' });
    const { fetchFn } = makeFetchStub({ ok: true, status: 200 });

    await withTempCwd(
      () => {
        // intentionally no files created
      },
      async () => {
        const result = await smokeReset({ executor, fetchFn });
        expect(result.ok).toBe(true);
      },
    );
  });

  it('TC-U-03 (infra): returns Err when docker exec exits non-zero, message includes stdout', async () => {
    const { executor } = makeExecutorStub({
      exitCode: 1,
      stdout: 'fake error',
    });
    const { fetchFn, calls: fetchCalls } = makeFetchStub({
      ok: true,
      status: 200,
    });

    await withTempCwd(
      () => undefined,
      async () => {
        const result = await smokeReset({ executor, fetchFn });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(Error);
          expect(result.error.message).toMatch(/server reset failed/i);
          expect(result.error.message).toContain('fake error');
        }
        // idp-stub fetch must not have run after docker failure (fail-fast)
        expect(fetchCalls).toHaveLength(0);
      },
    );
  });

  it('TC-U-04 (infra): returns Err when idp-stub POST is non-ok, message includes status', async () => {
    const { executor } = makeExecutorStub({ exitCode: 0, stdout: '' });
    const { fetchFn } = makeFetchStub({ ok: false, status: 500 });

    await withTempCwd(
      () => undefined,
      async () => {
        const result = await smokeReset({ executor, fetchFn });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(Error);
          expect(result.error.message).toMatch(/idp-stub/i);
          expect(result.error.message).toContain('500');
        }
      },
    );
  });
});
