import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as dbClient from '@/lib/db/client';
import { ensureFreshIngest } from './auto';
import type { WatcherHandle } from './watcher';

/**
 * TASK-5 (REQ-11) — coexistence between the pull-based `ensureFreshIngest`
 * and the push-based chokidar watcher. When the watcher is running it's the
 * authoritative source, so the on-page auto-ingest must short-circuit.
 */
describe('ensureFreshIngest — watcher coexistence', () => {
  let savedWatcher: WatcherHandle | undefined;
  let savedDisableAutoIngest: string | undefined;
  let savedWatchMode: string | undefined;

  beforeEach(() => {
    // Save & clear the watcher singleton so each test controls it explicitly.
    savedWatcher = globalThis.__tokenfxWatcher;
    globalThis.__tokenfxWatcher = undefined;

    // Save & unset env flags. TOKENFX_DISABLE_AUTO_INGEST would short-circuit
    // BEFORE our new watcher guard ran, masking the behavior under test.
    savedDisableAutoIngest = process.env.TOKENFX_DISABLE_AUTO_INGEST;
    savedWatchMode = process.env.TOKENFX_WATCH_MODE;
    delete process.env.TOKENFX_DISABLE_AUTO_INGEST;
    delete process.env.TOKENFX_WATCH_MODE;
  });

  afterEach(() => {
    globalThis.__tokenfxWatcher = savedWatcher;
    if (savedDisableAutoIngest === undefined) {
      delete process.env.TOKENFX_DISABLE_AUTO_INGEST;
    } else {
      process.env.TOKENFX_DISABLE_AUTO_INGEST = savedDisableAutoIngest;
    }
    if (savedWatchMode === undefined) {
      delete process.env.TOKENFX_WATCH_MODE;
    } else {
      process.env.TOKENFX_WATCH_MODE = savedWatchMode;
    }
    vi.restoreAllMocks();
  });

  it('TC-I-15 (REQ-11): short-circuits when watcher is running — no DB, no fs access', async () => {
    const stop = vi.fn(async () => {});
    const handle: WatcherHandle = { running: true, stop };
    globalThis.__tokenfxWatcher = handle;

    const getDbSpy = vi.spyOn(dbClient, 'getDb');
    const readdirSpy = vi.spyOn(fs.promises, 'readdir');

    await expect(ensureFreshIngest()).resolves.toBeUndefined();

    // Core assertion: the short-circuit prevented the ingest pipeline from
    // spinning up AT ALL — no DB handle was acquired, no fs scan happened.
    expect(getDbSpy).not.toHaveBeenCalled();
    expect(readdirSpy).not.toHaveBeenCalled();

    // Watcher handle untouched (we didn't call stop / mutate running).
    expect(handle.running).toBe(true);
    expect(stop).not.toHaveBeenCalled();
    expect(globalThis.__tokenfxWatcher).toBe(handle);
  });

  it('TC-I-16 (REQ-11, edge): runs normally when watcher singleton is present but NOT running', async () => {
    const stop = vi.fn(async () => {});
    const handle: WatcherHandle = { running: false, stop };
    globalThis.__tokenfxWatcher = handle;

    const getDbSpy = vi.spyOn(dbClient, 'getDb');

    // Should not short-circuit on the watcher guard — the normal path must
    // execute. With no matching JSONL files in the test env the run()
    // coroutine resolves cleanly (its try/catch swallows infra errors).
    await expect(ensureFreshIngest()).resolves.toBeUndefined();

    // Proof the normal path executed: getDb was called inside run().
    expect(getDbSpy).toHaveBeenCalled();

    // Watcher state remained untouched.
    expect(handle.running).toBe(false);
    expect(stop).not.toHaveBeenCalled();
  });
});
