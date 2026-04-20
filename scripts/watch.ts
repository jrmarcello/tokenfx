#!/usr/bin/env tsx
/**
 * Standalone watcher CLI — `pnpm watch`.
 *
 * Reuses `startWatcher` so log lines + behavior match the Next.js
 * instrumentation path. The CLI is the "server-less" way to keep the
 * dashboard DB fresh in real time (e.g. ingesting while the UI is
 * offline). Ctrl+C / SIGTERM → graceful `watcher.stop()`.
 */
import type { WatcherOptions } from '@/lib/ingest/watcher';
import { startWatcher } from '@/lib/ingest/watcher';
import { log } from '@/lib/logger';

async function main(): Promise<void> {
  // Envs for integration testing — both are no-ops for normal CLI use.
  // `TOKENFX_WATCH_ROOT` overrides the watched directory (default
  // `~/.claude/projects`); `TOKENFX_WATCH_BACKFILL=0` skips the initial
  // `ingestAll()` pass so tests that spin up the CLI against a scratch
  // DB don't trigger a 400-file ingest on boot.
  const opts: WatcherOptions = {};
  if (process.env.TOKENFX_WATCH_ROOT) {
    opts.root = process.env.TOKENFX_WATCH_ROOT;
  }
  if (process.env.TOKENFX_WATCH_BACKFILL === '0') {
    opts.backfill = false;
  }

  // Register signal handlers BEFORE awaiting startWatcher so an early
  // SIGTERM (e.g. from a test harness racing the "ready" log) never hits
  // the default kernel handler — which exits with signal, not code 0.
  // The handle is late-bound: if SIGTERM arrives pre-ready, we exit with
  // a tombstone stop() attempt that no-ops.
  let handle: Awaited<ReturnType<typeof startWatcher>> | null = null;
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`[watch] ${signal} received — stopping`);
    try {
      await handle?.stop();
    } catch (err) {
      log.error('[watch] stop failed:', err);
    }
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  handle = await startWatcher(opts);

  // Keep the process alive — chokidar holds the loop open via its
  // fs.watch handles, but an explicit hint doesn't hurt.
  return new Promise(() => {});
}

main().catch((err: unknown) => {
  console.error('[watch] fatal:', err);
  process.exit(1);
});
