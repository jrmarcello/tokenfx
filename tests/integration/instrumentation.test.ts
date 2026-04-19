/**
 * Integration tests for `startWatcherIfEnabled` — the env-gated entrypoint
 * that `instrumentation.ts.register()` wires `process.env` into. Calling
 * `register()` from Vitest doesn't exercise Next's hook pipeline, so we
 * test the underlying function directly with synthetic env fixtures.
 *
 * `globalThis.__tokenfxWatcher` is captured + restored in beforeEach /
 * afterEach to avoid bleed across tests (Vitest runs files in worker
 * processes but tests within a file share globals).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';
import {
  startWatcherIfEnabled,
  type WatcherHandle,
} from '@/lib/ingest/watcher';

describe('startWatcherIfEnabled (instrumentation entrypoint)', () => {
  let originalSingleton: WatcherHandle | undefined;
  let db: DB;

  beforeEach(() => {
    originalSingleton = globalThis.__tokenfxWatcher;
    globalThis.__tokenfxWatcher = undefined;
    db = openDatabase(':memory:');
    migrate(db);
  });

  afterEach(async () => {
    const handle = globalThis.__tokenfxWatcher;
    if (handle && handle.running) {
      await handle.stop();
    }
    globalThis.__tokenfxWatcher = originalSingleton;
    db.close();
  });

  it('TC-I-12: TOKENFX_WATCH_MODE unset → returns null; no singleton installed', async () => {
    const result = await startWatcherIfEnabled({}, { db, backfill: false });

    expect(result).toBeNull();
    expect(globalThis.__tokenfxWatcher).toBeUndefined();
  });

  it('TC-I-13: TOKENFX_DISABLE_AUTO_INGEST=1 beats TOKENFX_WATCH_MODE=1 → returns null', async () => {
    const result = await startWatcherIfEnabled(
      { TOKENFX_WATCH_MODE: '1', TOKENFX_DISABLE_AUTO_INGEST: '1' },
      { db, backfill: false },
    );

    expect(result).toBeNull();
    expect(globalThis.__tokenfxWatcher).toBeUndefined();
  });

  it('TC-I-14: TOKENFX_WATCH_MODE=1 with a tmp root → starts a live watcher singleton', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instr-test-'));
    try {
      const handle = await startWatcherIfEnabled(
        { TOKENFX_WATCH_MODE: '1' },
        { root: tmp, db, backfill: false },
      );

      expect(handle).not.toBeNull();
      expect(handle?.running).toBe(true);
      expect(globalThis.__tokenfxWatcher).toBe(handle);
    } finally {
      const installed = globalThis.__tokenfxWatcher;
      if (installed) await installed.stop();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
