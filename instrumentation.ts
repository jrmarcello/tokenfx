/**
 * Next.js 16 instrumentation hook. Runs once on server boot (dev, build,
 * start). We spawn the chokidar watcher here so it survives the lifetime
 * of the Node process; `startWatcherIfEnabled` is a no-op when the env
 * flags don't opt in.
 *
 * Kept thin on purpose — all env decisions + watcher lifecycle live in
 * `lib/ingest/watcher.ts`, which is unit-testable without Next.
 */
export async function register(): Promise<void> {
  // Gate by runtime — Next invokes `register` in the Node.js runtime
  // (and may in edge). chokidar only works on Node.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { startWatcherIfEnabled } = await import('@/lib/ingest/watcher');
  // `process.env` has an index signature (`[key: string]: string | undefined`)
  // which doesn't structurally assign to the narrow `WatcherEnv` shape —
  // project the two flags we care about so the contract stays explicit.
  const env = {
    TOKENFX_WATCH_MODE: process.env.TOKENFX_WATCH_MODE,
    TOKENFX_DISABLE_AUTO_INGEST: process.env.TOKENFX_DISABLE_AUTO_INGEST,
  };
  await startWatcherIfEnabled(env).catch((err: unknown) => {
    // Never let watcher failure kill the server.
    console.error('[instrumentation] watcher start failed:', err);
  });
}
