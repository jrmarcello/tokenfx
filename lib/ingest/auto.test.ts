import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as dbClient from '@/lib/db/client';
import { ensureFreshIngest } from './auto';
import type { WatcherHandle } from './watcher';

/**
 * TASK-5 (REQ-11) — coexistence between the pull-based `ensureFreshIngest`
 * and the push-based chokidar watcher.
 *
 * Prior to v0.3.1 this module short-circuited when the watcher was running,
 * on the assumption that the watcher would always catch JSONL changes.
 * Field experience showed chokidar occasionally loses events under Next dev
 * + HMR, so the DB drifts minutes behind the JSONL with no recovery on F5.
 * The short-circuit was removed: pull now ALWAYS runs, self-skipping via
 * the mtime-vs-lastIngest compare when the DB is already fresh. Watcher
 * still provides real-time updates when it works; pull provides the safety
 * net when it doesn't.
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

  it(
    'TC-I-15 (REQ-11): pull runs as safety net even when watcher is running',
    async () => {
      const stop = vi.fn(async () => {});
      const handle: WatcherHandle = { running: true, stop };
      globalThis.__tokenfxWatcher = handle;

      const getDbSpy = vi.spyOn(dbClient, 'getDb');

      await expect(ensureFreshIngest()).resolves.toBeUndefined();

      // New behaviour: pull runs regardless. The previous short-circuit
      // was removed to recover from chokidar event-drop in dev mode.
      // Pull self-skips the expensive ingest when JSONLs are fresh, so
      // redundant runs alongside a healthy watcher are cheap.
      expect(getDbSpy).toHaveBeenCalled();

      // Watcher handle untouched — pull doesn't interact with the watcher.
      expect(handle.running).toBe(true);
      expect(stop).not.toHaveBeenCalled();
      expect(globalThis.__tokenfxWatcher).toBe(handle);
    },
    20_000,
  );

  // Extended timeout: the normal `ensureFreshIngest` path hits the filesystem
  // (listTranscriptFiles + statSync walk of ~/.claude/projects). Under
  // vitest parallel load that I/O can exceed the default 10s timeout.
  it(
    'TC-I-16 (REQ-11, edge): runs normally when watcher singleton is present but NOT running',
    async () => {
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
    },
    20_000,
  );
});
