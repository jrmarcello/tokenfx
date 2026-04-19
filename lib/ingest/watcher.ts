import { existsSync, realpathSync } from 'node:fs';
import pathMod from 'node:path';
import type { Database } from 'better-sqlite3';
import { getDb } from '@/lib/db/client';
import { claudeProjectsRoot } from '@/lib/fs-paths';
import { ingestAll, ingestSingleFile } from '@/lib/ingest/writer';
import { log } from '@/lib/logger';

/**
 * Resolve `rawPath` and verify it stays within `allowedRoot` (both after
 * realpath). Throws on `..` traversal (before normalization) or symlink
 * escape. Parameterized version of `resolveWithinClaudeProjects` so the
 * watcher can be tested against temp directories without touching the
 * real `~/.claude/projects/`.
 */
function resolveWithinRoot(rawPath: string, allowedRoot: string): string {
  const segments = rawPath.split(/[\\/]/);
  if (segments.includes('..')) {
    throw new Error('path escape: contains ".."');
  }
  const resolved = pathMod.resolve(rawPath);
  let realResolved = resolved;
  try {
    realResolved = realpathSync(resolved);
  } catch {
    // File doesn't exist yet — fall through to lexical check.
  }
  let realRoot = allowedRoot;
  try {
    realRoot = realpathSync(allowedRoot);
  } catch {
    // Root may not exist — caller guards this via existsSync pre-check.
  }
  if (
    realResolved !== realRoot &&
    !realResolved.startsWith(realRoot + pathMod.sep)
  ) {
    throw new Error(`path escape: ${rawPath} outside ${allowedRoot}`);
  }
  return realResolved;
}

/**
 * A live watcher handle stored on `globalThis` so it survives Next.js HMR
 * re-invocations of `register()`. Consumers of TASK-1's pure helpers never
 * create or mutate this value — TASK-3's `startWatcher` owns its lifecycle.
 */
export type WatcherHandle = {
  running: boolean;
  stop: () => Promise<void>;
};

/**
 * Subset of `process.env` that `shouldStart` inspects. Kept structural so
 * callers can pass `process.env` directly or build synthetic fixtures in
 * tests.
 */
export type WatcherEnv = {
  TOKENFX_WATCH_MODE?: string | undefined;
  TOKENFX_DISABLE_AUTO_INGEST?: string | undefined;
};

/**
 * Decides whether the watcher should spin up based on env flags.
 *
 * Precedence:
 * 1. `TOKENFX_DISABLE_AUTO_INGEST === '1'` wins — test harnesses and E2E
 *    rely on this flag to guarantee no watcher is ever spawned.
 * 2. Otherwise `TOKENFX_WATCH_MODE === '1'` enables the watcher.
 *
 * Strictly compares against the string `'1'` to avoid truthy ambiguity
 * (`'0'`, `'true'`, `'false'`, ...).
 */
export const shouldStart = (env: WatcherEnv): boolean => {
  if (env.TOKENFX_DISABLE_AUTO_INGEST === '1') return false;
  return env.TOKENFX_WATCH_MODE === '1';
};

/**
 * Per-path serialization queue. Tasks chained on the same `path` run
 * sequentially; tasks on different paths run in parallel because each
 * path keeps its own independent promise chain.
 *
 * Rejections are caught + logged so a single bad file cannot freeze the
 * watcher — follow-up tasks on the same path keep running.
 *
 * The map self-cleans via `.finally`: when a chain settles AND no new
 * task has been appended, the entry is removed.
 */
const queue = new Map<string, Promise<void>>();

export const enqueue = (path: string, task: () => Promise<void>): Promise<void> => {
  const prev = queue.get(path) ?? Promise.resolve();
  const next = prev.then(task).catch((err: unknown) => {
    log.error(`[watch] task failed on ${path}:`, err);
  });
  queue.set(path, next);
  next.finally(() => {
    if (queue.get(path) === next) queue.delete(path);
  });
  return next;
};

/**
 * Returns `true` iff a live watcher singleton is registered on
 * `globalThis` AND reports `running === true`. Used by `ensureFreshIngest`
 * to short-circuit the page-load auto-ingest when the push-based watcher
 * is authoritative.
 *
 * Strict `=== true` (not truthy) so partial/defective handles can't fool
 * the check.
 */
export const isWatcherRunning = (): boolean => {
  return globalThis.__tokenfxWatcher?.running === true;
};

// Global singleton marker. TASK-3's `startWatcher` assigns this value;
// this module only reads it.
declare global {
  var __tokenfxWatcher: WatcherHandle | undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// TASK-3: startWatcher + lifecycle
// ─────────────────────────────────────────────────────────────────────────

export type WatcherOptions = {
  root?: string; // defaults to claudeProjectsRoot()
  db?: Database; // defaults to getDb()
  backfill?: boolean; // defaults to true; runs ingestAll() in background
};

/**
 * Handler invoked by chokidar's `add` and `change` events (and callable
 * directly in tests). Validates the path stays within `allowedRoot` (the
 * configured watcher root), delegates to `ingestSingleFile`, and logs a
 * stable telemetry line.
 *
 * Never throws — chokidar's EventEmitter is unforgiving of handler
 * rejections, and a single bad path must not kill the watcher.
 */
export async function handleFileEvent(
  db: Database,
  event: 'add' | 'change',
  rawPath: string,
  allowedRoot: string = claudeProjectsRoot(),
): Promise<void> {
  let safePath: string;
  try {
    safePath = resolveWithinRoot(rawPath, allowedRoot);
  } catch {
    log.warn(`[watch] rejected (path escape): ${rawPath}`);
    return;
  }
  if (!safePath.endsWith('.jsonl')) return;
  try {
    const outcome = ingestSingleFile(db, safePath);
    if (outcome.kind === 'processed') {
      log.info(
        `[watch] ${event} ${safePath} → ${outcome.turnsUpserted} turns, ${outcome.toolCallsUpserted} tool_calls`,
      );
    } else if (outcome.kind === 'skipped-error') {
      log.warn(`[watch] ${event} ${safePath} skipped: ${outcome.error}`);
    }
    // skipped-unchanged: silent (mtime gate — noise otherwise)
  } catch (err) {
    log.error(`[watch] handler error on ${safePath}:`, err);
  }
}

async function loadChokidar(): Promise<typeof import('chokidar')> {
  // Dynamic import so the static build doesn't pull chokidar into bundles
  // that don't need it (production server without TOKENFX_WATCH_MODE).
  return import('chokidar');
}

/**
 * Spawns a chokidar watcher over `~/.claude/projects/**` (or the provided
 * root), registers shutdown hooks, and installs the singleton on
 * `globalThis.__tokenfxWatcher`. Idempotent: if a running singleton is
 * already present, its handle is returned untouched AND a warn is logged
 * so double-register surfaces (REQ-16).
 *
 * Non-blocking: the backfill `ingestAll()` runs in background. The
 * watcher starts receiving events immediately; idempotent writes
 * (ON CONFLICT DO UPDATE) cover any overlap between backfill and live
 * events.
 *
 * Safe on a missing root: logs a warning, returns a handle with
 * `running: false` so `isWatcherRunning()` correctly reports "not live"
 * and `ensureFreshIngest` takes over.
 */
export async function startWatcher(
  opts: WatcherOptions = {},
): Promise<WatcherHandle> {
  if (globalThis.__tokenfxWatcher?.running === true) {
    log.warn('[watch] startWatcher called but watcher already running');
    return globalThis.__tokenfxWatcher;
  }

  const root = opts.root ?? claudeProjectsRoot();
  const db = opts.db ?? getDb();

  if (!existsSync(root)) {
    log.warn(`[watch] root not found: ${root} — watcher idle`);
    const idleHandle: WatcherHandle = {
      running: false,
      stop: async () => {},
    };
    globalThis.__tokenfxWatcher = idleHandle;
    return idleHandle;
  }

  const chokidar = await loadChokidar();
  const watcher = chokidar.watch(root, {
    persistent: true,
    ignoreInitial: true,
    followSymlinks: false,
    ignored: /(^|[/\\])\../, // dotfiles
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100,
    },
  });

  // Await chokidar's initial scan so callers can start writing events
  // right after `startWatcher` resolves. Without this, a `writeFileSync`
  // firing immediately after startup can miss the registration window on
  // loaded systems (vitest parallel pool, CI).
  await new Promise<void>((resolve, reject) => {
    const onReady = (): void => {
      watcher.off('error', onEarlyError);
      resolve();
    };
    const onEarlyError = (err: unknown): void => {
      watcher.off('ready', onReady);
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    watcher.once('ready', onReady);
    watcher.once('error', onEarlyError);
  });

  const onAdd = (rawPath: string): void => {
    void enqueue(rawPath, () => handleFileEvent(db, 'add', rawPath, root));
  };
  const onChange = (rawPath: string): void => {
    void enqueue(rawPath, () => handleFileEvent(db, 'change', rawPath, root));
  };
  const onUnlink = (rawPath: string): void => {
    log.info(`[watch] unlink ${rawPath} — retained in DB`);
  };
  const onError = (err: unknown): void => {
    log.error('[watch] chokidar error:', err);
  };

  watcher.on('add', onAdd);
  watcher.on('change', onChange);
  watcher.on('unlink', onUnlink);
  watcher.on('error', onError);

  let stopped = false;
  const handle: WatcherHandle = {
    running: true,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      handle.running = false;
      await watcher.close();
    },
  };

  globalThis.__tokenfxWatcher = handle;

  // Non-blocking backfill — `ingestAll` can take tens of seconds on a
  // fresh DB; awaiting would stall Next.js boot. The ingest pipeline is
  // idempotent (ON CONFLICT DO UPDATE + `ingested_files` mtime gate), so
  // overlap with live events is safe.
  if (opts.backfill !== false) {
    void ingestAll({ db }).catch((err: unknown) => {
      log.error('[watch] backfill failed:', err);
    });
  }

  log.info(`[watch] ready — watching ${root}`);
  return handle;
}

/**
 * Env-gated convenience wrapper used by `instrumentation.ts.register()`
 * and the `pnpm watch` CLI. Testable as a pure function by injecting a
 * synthetic `WatcherEnv`.
 */
export async function startWatcherIfEnabled(
  env: WatcherEnv,
  opts?: WatcherOptions,
): Promise<WatcherHandle | null> {
  if (!shouldStart(env)) return null;
  // HMR path: close the old watcher before starting a new one so we never
  // have two chokidar instances on the same tree in a dev process.
  if (globalThis.__tokenfxWatcher?.running === true) {
    log.info('[watch] recompile detected, recreating watcher');
    await globalThis.__tokenfxWatcher.stop();
    globalThis.__tokenfxWatcher = undefined;
  }
  return startWatcher(opts);
}
