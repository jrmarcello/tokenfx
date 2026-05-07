import { spawnSync } from 'node:child_process';
import type { Result } from '../../result';
import { log } from '../../logger';

/**
 * Per-SHA lookup of merged PRs via `gh api repos/{owner}/{repo}/commits/{sha}/pulls`.
 *
 * Returns `Result<PrLookupResult, never>` — the `Result` wrapper is kept
 * for symmetry with sibling helpers (`runGit`) and to communicate at the
 * type level that this function never throws. Every failure mode (missing
 * `gh` CLI, auth, rate limit, network, malformed JSON) is encoded in
 * `PrLookupResult.status`. Choosing `Result<T, never>` over a bare
 * `PrLookupResult` makes the "cannot fail" guarantee explicit — callers
 * pattern-match `result.ok` without a try/catch.
 */

export type PrLookupStatus =
  | 'ok'
  | 'rate-limited'
  | 'unauthorized'
  | 'not-found'
  | 'error';

export type PrLookupResult = {
  readonly status: PrLookupStatus;
  readonly prNumbers: readonly number[];
};

export type PrRunResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly spawnError?: NodeJS.ErrnoException;
};

export type PrRunImpl = (
  args: readonly string[],
  opts: { timeoutMs?: number },
) => PrRunResult;

export type PrLookupOptions = {
  readonly runImpl?: PrRunImpl;
  readonly shaCache?: Map<string, { status: 'ok'; prNumbers: readonly number[] }>;
  readonly rateLimitRef?: { limitedUntil: number | null };
  readonly nowMs?: () => number;
  /**
   * Set of reasons already logged (e.g. `'gh-cli-missing'`). Each reason
   * is logged at most ONCE per process invocation. Defaults to a
   * module-level singleton — fresh per `pnpm ingest`, persists across
   * calls within a single run. Tests pass a fresh `Set()` per case to
   * keep dedupe state isolated between TCs.
   */
  readonly loggedReasons?: Set<string>;
};

const DEFAULT_TIMEOUT_MS = 5000;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const STDERR_TAIL_MAX = 200;

/**
 * Default `runImpl` — spawns `gh` synchronously. Mirrors `runGit`'s
 * pattern (shell:false, argv-array, hardcoded timeout) but DROPS the
 * `cwd` parameter: `gh` calls the GitHub HTTP API, so cwd is irrelevant
 * AND no path-traversal guard is needed.
 *
 * Sets `GH_PROMPT_DISABLED=1` (analog to `GIT_TERMINAL_PROMPT=0` in
 * `runGit`) to prevent `gh` from prompting interactively on auth errors.
 */
const defaultRunImpl: PrRunImpl = (args, opts) => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const result = spawnSync('gh', args, {
    shell: false,
    timeout: timeoutMs,
    encoding: 'utf8',
    env: { ...process.env, GH_PROMPT_DISABLED: '1' },
  });
  return {
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? '',
    status: result.status,
    signal: result.signal,
    spawnError: result.error as NodeJS.ErrnoException | undefined,
  };
};

/**
 * Module-level singletons — one per process, fresh per `pnpm ingest`
 * invocation. Tests bypass these by passing fresh DI options per case.
 */
const moduleShaCache = new Map<
  string,
  { status: 'ok'; prNumbers: readonly number[] }
>();
const moduleRateLimitRef: { limitedUntil: number | null } = {
  limitedUntil: null,
};

/**
 * Module-level dedupe set — each (reason) is logged at most ONCE per
 * process invocation. Exposed via `PrLookupOptions.loggedReasons` so
 * tests can pass a fresh Set per case (without it, log-dedupe state
 * leaks across tests and turns "logged once" assertions into flakes).
 */
const moduleLoggedReasons = new Set<string>();

const logOnce = (
  loggedReasons: Set<string>,
  reason: string,
  payload: Record<string, unknown>,
): void => {
  if (loggedReasons.has(reason)) return;
  loggedReasons.add(reason);
  log.info('pr-lookup', payload);
};

/**
 * Pure classifier — exported for unit tests (TC-U-17..20). Maps a raw
 * `PrRunResult` to the canonical `PrLookupResult` per REQ-1..6.
 *
 * Order matters: ENOENT first, then auth/rate-limit stderr regexes (these
 * can fire on any non-zero status, including the rare case where the
 * process status is null), then status==0 JSON parsing, finally a generic
 * 'error' fallthrough.
 */
export const classifyGhResult = (result: PrRunResult): PrLookupResult => {
  if (result.spawnError?.code === 'ENOENT') {
    return { status: 'error', prNumbers: [] };
  }

  const stderr = result.stderr;
  if (/HTTP 401|HTTP 403.*not.*authorized|gh auth login/i.test(stderr)) {
    return { status: 'unauthorized', prNumbers: [] };
  }
  if (/rate.?limit|API rate limit exceeded|X-RateLimit-Remaining: 0/i.test(stderr)) {
    return { status: 'rate-limited', prNumbers: [] };
  }

  // SHA not on remote → permanent 'not-found' (count contribution 0). gh
  // emits this for HTTP 422 when the commit isn't on origin, typical for
  // local-only commits not yet pushed. Distinct from the catch-all 'error'
  // (NULL collapse). See .specs/outcome-integration-git-v3-422-as-not-found.md.
  // Rate-limited check above fires first if both patterns are present.
  if (
    result.status !== 0 &&
    /no commit found for sha: [0-9a-f]{7,40}/i.test(stderr)
  ) {
    return { status: 'not-found', prNumbers: [] };
  }

  if (result.status === 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return { status: 'error', prNumbers: [] };
    }
    if (!Array.isArray(parsed)) {
      return { status: 'error', prNumbers: [] };
    }
    if (parsed.length === 0) {
      return { status: 'not-found', prNumbers: [] };
    }
    if (!parsed.every((v) => typeof v === 'number')) {
      return { status: 'error', prNumbers: [] };
    }
    return { status: 'ok', prNumbers: parsed as number[] };
  }

  return { status: 'error', prNumbers: [] };
};

/**
 * Look up the merged PR numbers for a given (owner, repo, sha) via the
 * `gh` CLI. Synchronous; never throws. Failure modes are encoded in
 * `PrLookupResult.status`.
 *
 * Order of precedence (REQ-7 lock — cache wins over rate limit):
 *   1. SHA cache hit → return cached `'ok'` result.
 *   2. Rate-limit flag active → short-circuit to `'rate-limited'`.
 *   3. Spawn `gh`, classify, populate cache or set rate-limit flag.
 */
export const lookupMergedPrCount = (
  input: { owner: string; repo: string; sha: string },
  options: PrLookupOptions = {},
): Result<PrLookupResult, never> => {
  const runImpl = options.runImpl ?? defaultRunImpl;
  const shaCache = options.shaCache ?? moduleShaCache;
  const rateLimitRef = options.rateLimitRef ?? moduleRateLimitRef;
  const nowMs = options.nowMs ?? Date.now;
  const loggedReasons = options.loggedReasons ?? moduleLoggedReasons;

  // 1. Cache check — wins over rate limit per REQ-7.
  const cached = shaCache.get(input.sha);
  if (cached !== undefined) {
    return {
      ok: true,
      value: { status: 'ok', prNumbers: cached.prNumbers },
    };
  }

  // 2. Rate-limit short-circuit.
  const limitedUntil = rateLimitRef.limitedUntil;
  if (limitedUntil !== null && nowMs() < limitedUntil) {
    return { ok: true, value: { status: 'rate-limited', prNumbers: [] } };
  }

  // 3. Spawn + classify.
  const args = [
    'api',
    `repos/${input.owner}/${input.repo}/commits/${input.sha}/pulls`,
    '--jq',
    '[.[] | select(.merged_at != null) | .number]',
  ];
  const runResult = runImpl(args, {});
  const classified = classifyGhResult(runResult);

  switch (classified.status) {
    case 'ok': {
      shaCache.set(input.sha, {
        status: 'ok',
        prNumbers: classified.prNumbers,
      });
      return { ok: true, value: classified };
    }
    case 'rate-limited': {
      rateLimitRef.limitedUntil = nowMs() + RATE_LIMIT_WINDOW_MS;
      logOnce(loggedReasons, 'rate-limited', {
        reason: 'rate-limited',
        resetMin: 60,
      });
      return { ok: true, value: classified };
    }
    case 'unauthorized': {
      logOnce(loggedReasons, 'gh-auth-failure', { reason: 'gh-auth-failure' });
      return { ok: true, value: classified };
    }
    case 'not-found': {
      // NOT logged — legitimate "commit was direct-pushed, not via PR" case.
      return { ok: true, value: classified };
    }
    case 'error': {
      // ENOENT → distinct reason; everything else → 'gh-error'.
      if (runResult.spawnError?.code === 'ENOENT') {
        logOnce(loggedReasons, 'gh-cli-missing', {
          reason: 'gh-cli-missing',
        });
      } else {
        const stderrTail =
          runResult.stderr.length > STDERR_TAIL_MAX
            ? runResult.stderr.slice(-STDERR_TAIL_MAX)
            : runResult.stderr;
        const payload: Record<string, unknown> = {
          reason: 'gh-error',
          stderrTail,
        };
        if (runResult.status !== null) {
          payload['code'] = runResult.status;
        }
        logOnce(loggedReasons, 'gh-error', payload);
      }
      return { ok: true, value: classified };
    }
  }
};
