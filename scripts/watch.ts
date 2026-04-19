#!/usr/bin/env tsx
/**
 * Standalone watcher CLI — `pnpm watch`.
 *
 * Reuses `startWatcher` so log lines + behavior match the Next.js
 * instrumentation path. The CLI is the "server-less" way to keep the
 * dashboard DB fresh in real time (e.g. ingesting while the UI is
 * offline). Ctrl+C / SIGTERM → graceful `watcher.stop()`.
 */
import { startWatcher } from '@/lib/ingest/watcher';
import { log } from '@/lib/logger';

async function main(): Promise<void> {
  const handle = await startWatcher();

  const shutdown = async (signal: string): Promise<void> => {
    log.info(`[watch] ${signal} received — stopping`);
    try {
      await handle.stop();
    } catch (err) {
      log.error('[watch] stop failed:', err);
    }
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  // Keep the process alive — chokidar holds the loop open via its
  // fs.watch handles, but an explicit hint doesn't hurt.
  return new Promise(() => {});
}

main().catch((err: unknown) => {
  console.error('[watch] fatal:', err);
  process.exit(1);
});
