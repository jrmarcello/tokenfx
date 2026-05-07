import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { log } from '@/lib/logger';
import {
  classifyGhResult,
  lookupMergedPrCount,
  type PrLookupOptions,
  type PrLookupResult,
  type PrRunImpl,
  type PrRunResult,
} from './pr-lookup';

/**
 * Hand-written stub builder for `runImpl`. Returns a stub function plus
 * a `calls` array so tests can assert on invocation count + args.
 *
 * NO mocking framework — just a closure over a counter + a queue of
 * scripted return values.
 */
const makeRunStub = (
  scripted: PrRunResult[],
): { stub: PrRunImpl; calls: Array<readonly string[]> } => {
  const calls: Array<readonly string[]> = [];
  let i = 0;
  const stub: PrRunImpl = (args) => {
    calls.push(args);
    const next = scripted[i] ?? scripted[scripted.length - 1];
    i += 1;
    if (next === undefined) {
      throw new Error('makeRunStub: no scripted result available');
    }
    return next;
  };
  return { stub, calls };
};

const makeFreshOptions = (
  overrides: Partial<PrLookupOptions> = {},
): PrLookupOptions => ({
  shaCache: new Map(),
  rateLimitRef: { limitedUntil: null },
  nowMs: () => 1_700_000_000_000,
  loggedReasons: new Set<string>(),
  ...overrides,
});

const FIXED_INPUT = { owner: 'octo', repo: 'demo', sha: 'abc123' } as const;

describe('classifyGhResult — pure classifier', () => {
  it('TC-U-17: stderr "HTTP 403: you are not authorized" → unauthorized (second arm)', () => {
    // Matches REQ-3 regex `HTTP 403.*not.*authorized` (case-insensitive).
    // The fixture string in the spec table was illustrative; the regex
    // explicitly requires the word "not" between 403 and "authorized".
    const result: PrRunResult = {
      stdout: '',
      stderr: 'HTTP 403: you are not authorized to access this resource',
      status: 1,
      signal: null,
    };
    const out = classifyGhResult(result);
    expect(out.status).toBe('unauthorized');
    expect(out.prNumbers).toEqual([]);
  });

  it('TC-U-18: stderr "Please run: gh auth login" → unauthorized (third arm)', () => {
    const result: PrRunResult = {
      stdout: '',
      stderr: 'Please run: gh auth login',
      status: 1,
      signal: null,
    };
    const out = classifyGhResult(result);
    expect(out.status).toBe('unauthorized');
  });

  it('TC-U-19: status=0, stdout=`[null]` → error (not Array<number>)', () => {
    const result: PrRunResult = {
      stdout: '[null]',
      stderr: '',
      status: 0,
      signal: null,
    };
    const out = classifyGhResult(result);
    expect(out.status).toBe('error');
    expect(out.prNumbers).toEqual([]);
  });

  it('TC-U-19b: status=0, stdout=`["42"]` → error (string elements not numbers)', () => {
    const result: PrRunResult = {
      stdout: '["42"]',
      stderr: '',
      status: 0,
      signal: null,
    };
    const out = classifyGhResult(result);
    expect(out.status).toBe('error');
  });

  it('TC-U-20: status=0, stdout="" (empty) → error (cannot parse, distinct from not-found)', () => {
    const result: PrRunResult = {
      stdout: '',
      stderr: '',
      status: 0,
      signal: null,
    };
    const out = classifyGhResult(result);
    expect(out.status).toBe('error');
  });

  // ---- v3 422-as-not-found arm ------------------------------------------
  // gh emits `gh: No commit found for SHA: <sha> (HTTP 422)` on stderr when
  // the SHA isn't on the remote (typical for local-only commits not yet
  // pushed). Map to `'not-found'` (count contribution 0), distinct from
  // `'error'` (NULL collapse). See .specs/outcome-integration-git-v3-422-as-not-found.md.

  it('TC-U-01 (v3): canonical 422 stderr with 12-char SHA → not-found', () => {
    const result: PrRunResult = {
      stdout: '',
      stderr: 'gh: No commit found for SHA: 328806d7924e (HTTP 422)\n',
      status: 1,
      signal: null,
    };
    expect(classifyGhResult(result)).toEqual({
      status: 'not-found',
      prNumbers: [],
    });
  });

  it('TC-U-02 (v3): full canonical 40-char SHA matches (max boundary inclusive)', () => {
    const result: PrRunResult = {
      stdout: '',
      stderr:
        'gh: No commit found for SHA: a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2 (HTTP 422)\n',
      status: 1,
      signal: null,
    };
    expect(classifyGhResult(result).status).toBe('not-found');
  });

  it('TC-U-03 (v3): 7-char SHA (regex {7,40} min boundary inclusive)', () => {
    const result: PrRunResult = {
      stdout: '',
      stderr: 'gh: No commit found for SHA: deadbee (HTTP 422)\n',
      status: 1,
      signal: null,
    };
    expect(classifyGhResult(result).status).toBe('not-found');
  });

  it('TC-U-03b (v3): 6-char hex (one below min) → error (regex rejects)', () => {
    const result: PrRunResult = {
      stdout: '',
      stderr: 'gh: No commit found for SHA: abc123 (HTTP 422)\n',
      status: 1,
      signal: null,
    };
    expect(classifyGhResult(result).status).toBe('error');
  });

  it('TC-U-03c (v3): 41-char hex matches first 40 (regex unanchored — locked decision, academic)', () => {
    const longHex = 'a'.repeat(41);
    const result: PrRunResult = {
      stdout: '',
      stderr: `gh: No commit found for SHA: ${longHex} (HTTP 422)\n`,
      status: 1,
      signal: null,
    };
    // Regex /[0-9a-f]{7,40}/ is unanchored; first 40 of 41 a's match.
    // Real gh always emits canonical 40-char SHA, so this branch is academic
    // but documents the locked permissive behavior.
    expect(classifyGhResult(result).status).toBe('not-found');
  });

  it('TC-U-04 (v3): mixed/upper case matches via /i (phrase + hex A-F)', () => {
    const result: PrRunResult = {
      stdout: '',
      stderr: 'NO COMMIT FOUND FOR SHA: ABC1234 (HTTP 422)\n',
      status: 1,
      signal: null,
    };
    expect(classifyGhResult(result).status).toBe('not-found');
  });

  it('TC-U-05 (v3): rate-limited wins precedence over no-commit-found in same stderr', () => {
    const result: PrRunResult = {
      stdout: '',
      stderr:
        'API rate limit exceeded.\nAdditionally: No commit found for SHA: deadbee1 (HTTP 422)\n',
      status: 1,
      signal: null,
    };
    // Rate-limited check fires first per insertion order (REQ-2).
    expect(classifyGhResult(result).status).toBe('rate-limited');
  });

  it('TC-U-05b (v3): rate-limited still wins when no-commit-found phrase appears FIRST in stderr (catches string-order bugs)', () => {
    // Same precedence as TC-U-05 but reversed string order — proves the
    // classifier respects insertion order in code, not first-match
    // position in the stderr string.
    const result: PrRunResult = {
      stdout: '',
      stderr:
        'No commit found for SHA: deadbee1 (HTTP 422)\nAdditionally: API rate limit exceeded.\n',
      status: 1,
      signal: null,
    };
    expect(classifyGhResult(result).status).toBe('rate-limited');
  });

  it('TC-U-06 (v3): other 422 (no SHA-not-found phrase) → error', () => {
    const result: PrRunResult = {
      stdout: '',
      stderr: 'gh: HTTP 422 Unprocessable Entity\n',
      status: 1,
      signal: null,
    };
    expect(classifyGhResult(result).status).toBe('error');
  });

  it('TC-U-07 (v3): non-hex chars in SHA position (8 g\'s, no contiguous 7-hex run) → error', () => {
    const result: PrRunResult = {
      stdout: '',
      stderr: 'gh: No commit found for SHA: gggggggg (HTTP 422)\n',
      status: 1,
      signal: null,
    };
    // 'g' is outside [0-9a-f]; no 7+ contiguous hex run → regex misses → fallback.
    expect(classifyGhResult(result).status).toBe('error');
  });

  it('TC-U-08 (v3): defensive — status=0 + matching stderr → status-0 path fires (new arm guarded by status !== 0)', () => {
    // Impossible with real gh, but the explicit `status !== 0` guard in the
    // new arm must hold. With status=0 + stdout='[]', the status-0 JSON-parse
    // block returns 'not-found' from its own empty-array branch — NOT via
    // the new arm. Confirms the guard is wired correctly.
    const result: PrRunResult = {
      stdout: '[]',
      stderr: 'gh: No commit found for SHA: deadbee1 (HTTP 422)\n',
      status: 0,
      signal: null,
    };
    expect(classifyGhResult(result).status).toBe('not-found');
  });
});

describe('lookupMergedPrCount', () => {
  // Hand-written log spy — TC-I-21 requires deterministic structure assertions.
  // We capture log.info calls for every test to allow assertions on shape.
  let infoCalls: Array<readonly unknown[]> = [];
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    infoCalls = [];
    infoSpy = vi.spyOn(log, 'info').mockImplementation((...args: unknown[]) => {
      infoCalls.push(args);
    });
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  it('TC-I-01: stub returns `[42, 99]` (status 0) → status="ok" with prNumbers=[42,99]', () => {
    const { stub, calls } = makeRunStub([
      { stdout: '[42, 99]', stderr: '', status: 0, signal: null },
    ]);
    const result = lookupMergedPrCount(
      FIXED_INPUT,
      makeFreshOptions({ runImpl: stub }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('ok');
      expect(result.value.prNumbers).toEqual([42, 99]);
    }
    expect(calls.length).toBe(1);
  });

  it('TC-I-02: stub spawnError ENOENT → status="error", logged once with reason=gh-cli-missing', () => {
    const enoent: NodeJS.ErrnoException = Object.assign(new Error('ENOENT'), {
      code: 'ENOENT',
    });
    const { stub } = makeRunStub([
      { stdout: '', stderr: '', status: null, signal: null, spawnError: enoent },
    ]);
    const result = lookupMergedPrCount(
      FIXED_INPUT,
      makeFreshOptions({ runImpl: stub }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('error');
      expect(result.value.prNumbers).toEqual([]);
    }
    // Logged once with reason=gh-cli-missing
    const ghMissingLogs = infoCalls.filter((args) => {
      const payload = args[1];
      return (
        typeof payload === 'object' &&
        payload !== null &&
        'reason' in payload &&
        (payload as { reason: unknown }).reason === 'gh-cli-missing'
      );
    });
    expect(ghMissingLogs.length).toBe(1);
  });

  it('TC-I-02b: ENOENT logged ONCE per invocation series — second call to a different SHA does not re-log', () => {
    const enoent: NodeJS.ErrnoException = Object.assign(new Error('ENOENT'), {
      code: 'ENOENT',
    });
    // We create a single options bag (sharing rateLimitRef + cache),
    // but ENOENT does NOT set the rate-limit flag. We rely on the
    // module-level "logged reasons" set to dedupe.
    const { stub } = makeRunStub([
      { stdout: '', stderr: '', status: null, signal: null, spawnError: enoent },
      { stdout: '', stderr: '', status: null, signal: null, spawnError: enoent },
    ]);
    const opts = makeFreshOptions({ runImpl: stub });
    lookupMergedPrCount(FIXED_INPUT, opts);
    lookupMergedPrCount({ ...FIXED_INPUT, sha: 'def456' }, opts);
    const ghMissingLogs = infoCalls.filter((args) => {
      const payload = args[1];
      return (
        typeof payload === 'object' &&
        payload !== null &&
        'reason' in payload &&
        (payload as { reason: unknown }).reason === 'gh-cli-missing'
      );
    });
    expect(ghMissingLogs.length).toBe(1);
  });

  it('TC-I-03: stderr "HTTP 401: bad credentials. Run gh auth login." → status=unauthorized, log reason=gh-auth-failure', () => {
    const { stub } = makeRunStub([
      {
        stdout: '',
        stderr: 'HTTP 401: bad credentials. Run gh auth login.',
        status: 1,
        signal: null,
      },
    ]);
    const result = lookupMergedPrCount(
      FIXED_INPUT,
      makeFreshOptions({ runImpl: stub }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('unauthorized');
    }
    const authLogs = infoCalls.filter((args) => {
      const payload = args[1];
      return (
        typeof payload === 'object' &&
        payload !== null &&
        'reason' in payload &&
        (payload as { reason: unknown }).reason === 'gh-auth-failure'
      );
    });
    expect(authLogs.length).toBe(1);
  });

  it('TC-I-04: stderr "API rate limit exceeded for user." → status=rate-limited; subsequent SHA short-circuits without spawning', () => {
    const { stub, calls } = makeRunStub([
      {
        stdout: '',
        stderr: 'API rate limit exceeded for user.',
        status: 1,
        signal: null,
      },
    ]);
    const opts = makeFreshOptions({ runImpl: stub });
    const first = lookupMergedPrCount(FIXED_INPUT, opts);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value.status).toBe('rate-limited');
    // Different SHA — should short-circuit (no spawn)
    const second = lookupMergedPrCount({ ...FIXED_INPUT, sha: 'def456' }, opts);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.status).toBe('rate-limited');
    // Stub called only once (second call short-circuited)
    expect(calls.length).toBe(1);
  });

  it('TC-I-05: stdout="[]" status=0 → status=not-found, NOT logged at warn', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const { stub } = makeRunStub([
      { stdout: '[]', stderr: '', status: 0, signal: null },
    ]);
    const result = lookupMergedPrCount(
      FIXED_INPUT,
      makeFreshOptions({ runImpl: stub }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('not-found');
      expect(result.value.prNumbers).toEqual([]);
    }
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('TC-I-06: stderr "tcp i/o timeout connecting to api.github.com" → status=error, log reason=gh-error', () => {
    const { stub } = makeRunStub([
      {
        stdout: '',
        stderr: 'tcp i/o timeout connecting to api.github.com',
        status: 1,
        signal: null,
      },
    ]);
    const result = lookupMergedPrCount(
      FIXED_INPUT,
      makeFreshOptions({ runImpl: stub }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('error');
    const errLogs = infoCalls.filter((args) => {
      const payload = args[1];
      return (
        typeof payload === 'object' &&
        payload !== null &&
        'reason' in payload &&
        (payload as { reason: unknown }).reason === 'gh-error'
      );
    });
    expect(errLogs.length).toBe(1);
  });

  it('TC-I-07: stdout="malformed{json" status=0 → status=error (JSON parse fail)', () => {
    const { stub } = makeRunStub([
      { stdout: 'malformed{json', stderr: '', status: 0, signal: null },
    ]);
    const result = lookupMergedPrCount(
      FIXED_INPUT,
      makeFreshOptions({ runImpl: stub }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('error');
  });

  it('TC-U-11: same SHA queried twice — second call hits cache, runImpl called once', () => {
    const { stub, calls } = makeRunStub([
      { stdout: '[7]', stderr: '', status: 0, signal: null },
    ]);
    const opts = makeFreshOptions({ runImpl: stub });
    const first = lookupMergedPrCount(FIXED_INPUT, opts);
    const second = lookupMergedPrCount(FIXED_INPUT, opts);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value.status).toBe('ok');
      expect(second.value.status).toBe('ok');
      expect(second.value.prNumbers).toEqual([7]);
    }
    expect(calls.length).toBe(1);
  });

  it('TC-U-12: first call returns error → second call re-queries (no negative cache)', () => {
    const { stub, calls } = makeRunStub([
      { stdout: '', stderr: 'tcp i/o timeout', status: 1, signal: null },
      { stdout: '[5]', stderr: '', status: 0, signal: null },
    ]);
    const opts = makeFreshOptions({ runImpl: stub });
    const first = lookupMergedPrCount(FIXED_INPUT, opts);
    const second = lookupMergedPrCount(FIXED_INPUT, opts);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok) expect(first.value.status).toBe('error');
    if (second.ok) expect(second.value.status).toBe('ok');
    expect(calls.length).toBe(2);
  });

  it('TC-U-13: rate-limited triggers process-wide flag — second call short-circuits', () => {
    const { stub, calls } = makeRunStub([
      { stdout: '', stderr: 'API rate limit exceeded', status: 1, signal: null },
    ]);
    const opts = makeFreshOptions({ runImpl: stub });
    lookupMergedPrCount(FIXED_INPUT, opts);
    // Different SHA — would re-query if not for the rate-limit flag
    const second = lookupMergedPrCount({ ...FIXED_INPUT, sha: 'zzzzz' }, opts);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.status).toBe('rate-limited');
    expect(calls.length).toBe(1);
  });

  it('TC-U-14: clock advances >60min via injected nowMs → next call invokes runImpl', () => {
    // We choose nowMs injection (per TASK-2 spec note) over vi.useFakeTimers().
    // The clock counter returns t0 for the first 2 calls (initial + immediate
    // short-circuit attempt), then t0 + 61min for the third.
    let tick = 0;
    const t0 = 1_700_000_000_000;
    const SIXTY_ONE_MIN = 61 * 60 * 1000;
    // nowMs is only called when limitedUntil is non-null (rate check) or
    // inside the 'rate-limited' switch arm. Trace:
    //   Call 1: limitedUntil=null → no rate-check call; switch arm calls
    //           nowMs once to compute limitedUntil. tick=1.
    //   Call 2: limitedUntil set → rate-check calls nowMs. tick=2. Must
    //           still be inside the window → return t0.
    //   Call 3: rate-check calls nowMs. tick=3. Must be PAST the window
    //           → return t0+61min, so the call spawns.
    const nowMs = (): number => {
      tick += 1;
      if (tick <= 2) return t0;
      return t0 + SIXTY_ONE_MIN;
    };
    const { stub, calls } = makeRunStub([
      { stdout: '', stderr: 'API rate limit exceeded', status: 1, signal: null },
      { stdout: '[1]', stderr: '', status: 0, signal: null },
    ]);
    const opts = makeFreshOptions({ runImpl: stub, nowMs });
    // Call 1 — sets rate-limit flag
    lookupMergedPrCount(FIXED_INPUT, opts);
    // Call 2 — within window, short-circuits (no spawn)
    lookupMergedPrCount({ ...FIXED_INPUT, sha: 'sha2' }, opts);
    // Call 3 — clock advanced past window, spawns again
    const third = lookupMergedPrCount({ ...FIXED_INPUT, sha: 'sha3' }, opts);
    expect(third.ok).toBe(true);
    if (third.ok) expect(third.value.status).toBe('ok');
    expect(calls.length).toBe(2);
  });

  it('TC-U-15: cache hit AFTER rate-limit set — cached SHA serves WITHOUT spawning', () => {
    const { stub, calls } = makeRunStub([
      // First call — populates cache for SHA "abc"
      { stdout: '[100]', stderr: '', status: 0, signal: null },
      // Second call — different SHA, triggers rate-limit
      { stdout: '', stderr: 'API rate limit exceeded', status: 1, signal: null },
    ]);
    const opts = makeFreshOptions({ runImpl: stub });
    lookupMergedPrCount({ owner: 'o', repo: 'r', sha: 'abc' }, opts);
    lookupMergedPrCount({ owner: 'o', repo: 'r', sha: 'rate-trigger' }, opts);
    // Re-query SHA "abc" — should hit cache, NOT spawn
    const cached = lookupMergedPrCount(
      { owner: 'o', repo: 'r', sha: 'abc' },
      opts,
    );
    expect(cached.ok).toBe(true);
    if (cached.ok) {
      expect(cached.value.status).toBe('ok');
      expect(cached.value.prNumbers).toEqual([100]);
    }
    // Total stub calls = 2 (initial abc + rate-trigger). The cache hit on
    // re-query of abc adds zero. The third call's short-circuit-by-rate-limit
    // is bypassed by the cache check (REQ-7).
    expect(calls.length).toBe(2);
  });

  it('TC-U-16: combined flow — error→rate-limited→short-circuit. Third call NOT spawned', () => {
    const { stub, calls } = makeRunStub([
      // First call: error (no cache, no rate-limit set)
      { stdout: '', stderr: 'tcp i/o', status: 1, signal: null },
      // Second call: same SHA re-queries (REQ-7b), returns rate-limited
      { stdout: '', stderr: 'API rate limit exceeded', status: 1, signal: null },
    ]);
    const opts = makeFreshOptions({ runImpl: stub });
    const first = lookupMergedPrCount(FIXED_INPUT, opts);
    const second = lookupMergedPrCount(FIXED_INPUT, opts);
    const third = lookupMergedPrCount(FIXED_INPUT, opts);
    if (first.ok) expect(first.value.status).toBe('error');
    if (second.ok) expect(second.value.status).toBe('rate-limited');
    if (third.ok) expect(third.value.status).toBe('rate-limited');
    expect(calls.length).toBe(2);
  });

  it('TC-I-21: log payload privacy — stderrTail capped at 200 chars, last-200-chars (not first), no extra fields', () => {
    const longStderr = 'feat: SECRET-FEATURE-NAME ' + 'x'.repeat(500);
    const { stub } = makeRunStub([
      { stdout: '', stderr: longStderr, status: 1, signal: null },
    ]);
    lookupMergedPrCount(FIXED_INPUT, makeFreshOptions({ runImpl: stub }));

    // Find the gh-error log call
    const errLogs = infoCalls.filter((args) => {
      const payload = args[1];
      return (
        typeof payload === 'object' &&
        payload !== null &&
        'reason' in payload &&
        (payload as { reason: unknown }).reason === 'gh-error'
      );
    });
    expect(errLogs.length).toBe(1);
    const firstErrLog = errLogs[0];
    expect(firstErrLog).toBeDefined();
    if (!firstErrLog) return;
    const payload = firstErrLog[1] as Record<string, unknown>;

    // (a) stderrTail length capped at 200
    const stderrTail = payload['stderrTail'];
    expect(typeof stderrTail).toBe('string');
    if (typeof stderrTail !== 'string') return;
    expect(stderrTail.length).toBeLessThanOrEqual(200);

    // (b) Allowed keys only — no PII fields like "message", "email", "sha"
    const allowed = new Set(['reason', 'code', 'stderrTail']);
    for (const key of Object.keys(payload)) {
      expect(allowed.has(key)).toBe(true);
    }

    // (c) stderrTail is the LAST 200 chars (truncation direction)
    expect(stderrTail).toBe(longStderr.slice(-200));
    // The leading "SECRET-FEATURE-NAME" prefix MUST have been dropped
    expect(stderrTail.includes('SECRET-FEATURE-NAME')).toBe(false);
  });

  it('TC-I-23: cache deduplicates across sessions — 2 sessions × 3 SHAs = 3 calls (not 6)', () => {
    // Simulate the evaluator pattern: two sessions sharing 3 SHAs each.
    // The cache (shared via the same options bag) collapses duplicates.
    const { stub, calls } = makeRunStub([
      { stdout: '[1]', stderr: '', status: 0, signal: null },
      { stdout: '[2]', stderr: '', status: 0, signal: null },
      { stdout: '[3]', stderr: '', status: 0, signal: null },
    ]);
    const opts = makeFreshOptions({ runImpl: stub });
    const shas = ['sha-a', 'sha-b', 'sha-c'] as const;
    // Session 1
    for (const sha of shas) {
      lookupMergedPrCount({ owner: 'o', repo: 'r', sha }, opts);
    }
    // Session 2 — same SHAs
    for (const sha of shas) {
      lookupMergedPrCount({ owner: 'o', repo: 'r', sha }, opts);
    }
    expect(calls.length).toBe(3);
  });

  it('TC-I-21b: typed result wrapper — lookupMergedPrCount returns Result<PrLookupResult, never>', () => {
    // Compile-time + runtime check: the .ok branch is always true.
    const { stub } = makeRunStub([
      { stdout: '[]', stderr: '', status: 0, signal: null },
    ]);
    const result = lookupMergedPrCount(
      FIXED_INPUT,
      makeFreshOptions({ runImpl: stub }),
    );
    expect(result.ok).toBe(true);
    // Type-narrowing demonstration: PrLookupResult is reachable without throw.
    if (result.ok) {
      const value: PrLookupResult = result.value;
      expect(value.status).toBe('not-found');
    }
  });
});
