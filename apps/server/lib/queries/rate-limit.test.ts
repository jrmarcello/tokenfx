/**
 * Unit tests for the rate limiter (TASK-6c, REQ-27 step 0).
 *
 * Pure-unit suite — no Postgres, no Drizzle, no Express. Uses vitest's
 * built-in fake timers (NOT a 3rd-party mocking framework, allowed under
 * the project's "hand-written stubs in test files" rule because fake timers
 * are part of vitest itself) so the sliding-window assertions can advance
 * the clock deterministically.
 *
 * TC mappings:
 *   - TC-I-31 single-IP (10/min) — 11th rejected with retryAfterSec.
 *     (Unit-flavoured here; the integration test in TASK-8 covers the
 *     route-level wiring.)
 *   - TC-I-32 per-token cap (3/min) — 4th rejected reports `dimension:'token'`.
 *   - TC-I-33 per-IP cap fires across distinct tokens.
 *   - sliding window expiry — t=0 .. t=30s rejected, t=60s+ → fresh window.
 *   - both dimensions exceeded → first one (deterministic ordering).
 *   - memory pruning — 1000 hits stay bounded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __counterSize,
  __resetRateLimits,
  checkRateLimits,
} from './rate-limit';

const IP_LIMIT = 10;
const TOKEN_LIMIT = 3;
const WINDOW_MS = 60_000;

const ipDim = (key: string) => ({
  name: 'ip' as const,
  key,
  limit: IP_LIMIT,
  windowMs: WINDOW_MS,
});
const tokenDim = (key: string) => ({
  name: 'token' as const,
  key,
  limit: TOKEN_LIMIT,
  windowMs: WINDOW_MS,
});

describe('rate-limit (TASK-6c, REQ-27 step 0)', () => {
  beforeEach(() => {
    __resetRateLimits();
    vi.useFakeTimers();
    // Anchor at a fixed instant so window math is easy to read.
    vi.setSystemTime(new Date('2026-05-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetRateLimits();
  });

  // -------------------------------------------------------------------------
  // Single dimension — 10 ok, 11th rejected.
  // -------------------------------------------------------------------------
  it('single IP dimension: 10 calls accepted, 11th returns retryAfterSec and dimension=ip', () => {
    const ip = '203.0.113.0/24';

    for (let i = 0; i < IP_LIMIT; i += 1) {
      const r = checkRateLimits([ipDim(ip)]);
      expect(r.ok).toBe(true);
    }

    const eleventh = checkRateLimits([ipDim(ip)]);
    expect(eleventh.ok).toBe(false);
    if (eleventh.ok) throw new Error('unreachable');
    expect(eleventh.dimension).toBe('ip');
    // Window is 60s; the OLDEST in-window timestamp is t=0 → retryAfter is
    // ~60s. Implementation rounds up + clamps to >=1.
    expect(eleventh.retryAfterSec).toBeGreaterThan(0);
    expect(eleventh.retryAfterSec).toBeLessThanOrEqual(60);
  });

  // -------------------------------------------------------------------------
  // Sliding-window expiry.
  // -------------------------------------------------------------------------
  it('sliding window: 10 hits at t=0 + 9 at t=30s rejected; after t=60s a fresh window of 10 fits', () => {
    const ip = '198.51.100.0/24';

    // t=0: fill the window.
    for (let i = 0; i < IP_LIMIT; i += 1) {
      const r = checkRateLimits([ipDim(ip)]);
      expect(r.ok).toBe(true);
    }

    // t=30s: still inside the 60s window. Every attempt rejected.
    vi.advanceTimersByTime(30_000);
    for (let i = 0; i < 9; i += 1) {
      const r = checkRateLimits([ipDim(ip)]);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('unreachable');
      expect(r.dimension).toBe('ip');
    }

    // t=60_001 (just past window): the t=0 timestamps fall out — 10 fresh
    // calls fit again.
    vi.advanceTimersByTime(30_001);
    for (let i = 0; i < IP_LIMIT; i += 1) {
      const r = checkRateLimits([ipDim(ip)]);
      expect(r.ok).toBe(true);
    }
    const eleventh = checkRateLimits([ipDim(ip)]);
    expect(eleventh.ok).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Two dimensions — both pass.
  // -------------------------------------------------------------------------
  it('two dimensions both under limit → ok; both counters incremented', () => {
    const r1 = checkRateLimits([ipDim('1.2.3.0/24'), tokenDim('aaaaaaaa')]);
    expect(r1.ok).toBe(true);
    expect(__counterSize('ip', '1.2.3.0/24')).toBe(1);
    expect(__counterSize('token', 'aaaaaaaa')).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Two dimensions — IP exceeded.
  // -------------------------------------------------------------------------
  it('two dimensions, IP exceeded → reject with dimension=ip; token counter NOT incremented', () => {
    const ip = '10.0.0.0/24';
    const token = 'abcdef01';

    // Fill IP counter to limit using 10 distinct tokens (so per-token never
    // exceeds its own 3/min cap).
    for (let i = 0; i < IP_LIMIT; i += 1) {
      const r = checkRateLimits([
        ipDim(ip),
        tokenDim(`tok-${i.toString(16).padStart(8, '0')}`),
      ]);
      expect(r.ok).toBe(true);
    }

    const tokenSizeBefore = __counterSize('token', token);
    const rejected = checkRateLimits([ipDim(ip), tokenDim(token)]);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error('unreachable');
    expect(rejected.dimension).toBe('ip');

    // Side-effect invariant: the rejected dimension's counter is rebuilt
    // (lazy-prune may run) but no NEW timestamp is appended to ANY counter.
    // The `token` dimension's count stays whatever it was before this call.
    expect(__counterSize('token', token)).toBe(tokenSizeBefore);
  });

  // -------------------------------------------------------------------------
  // Two dimensions — token exceeded.
  // -------------------------------------------------------------------------
  it('two dimensions, token exceeded → reject with dimension=token', () => {
    const token = '11111111';

    // 3 calls from 3 different IPs against the same token — token counter
    // hits its 3/min cap; IP counter for each IP is 1.
    for (let i = 0; i < TOKEN_LIMIT; i += 1) {
      const r = checkRateLimits([
        ipDim(`192.0.2.${i}/24`),
        tokenDim(token),
      ]);
      expect(r.ok).toBe(true);
    }

    // 4th attempt — different IP, same token. Token cap fires before the
    // IP would.
    const rejected = checkRateLimits([
      ipDim('192.0.2.99/24'),
      tokenDim(token),
    ]);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error('unreachable');
    expect(rejected.dimension).toBe('token');
  });

  // -------------------------------------------------------------------------
  // Both dimensions exceeded — first-listed wins.
  // -------------------------------------------------------------------------
  it('both dimensions exceeded → reports the FIRST one in caller-supplied order', () => {
    const ip = '5.5.5.0/24';
    const token = '22222222';

    // Drive IP counter to limit (10 hits, each on a distinct token so the
    // per-token cap never fires for those).
    for (let i = 0; i < IP_LIMIT; i += 1) {
      const r = checkRateLimits([
        ipDim(ip),
        tokenDim(`fill-${i.toString(16).padStart(8, '0')}`),
      ]);
      expect(r.ok).toBe(true);
    }
    // Drive THIS token's counter to limit using 3 different IPs (none of
    // which is the one we'll test with).
    for (let i = 0; i < TOKEN_LIMIT; i += 1) {
      const r = checkRateLimits([
        ipDim(`9.9.9.${i}/24`),
        tokenDim(token),
      ]);
      expect(r.ok).toBe(true);
    }

    // Now both `ip` AND `token` are at their caps. Caller passes [ip, token]
    // → reports `ip` (first exceeded in order).
    const r1 = checkRateLimits([ipDim(ip), tokenDim(token)]);
    expect(r1.ok).toBe(false);
    if (r1.ok) throw new Error('unreachable');
    expect(r1.dimension).toBe('ip');

    // Reverse the order → reports `token` first. Confirms the contract is
    // "first exceeded in the caller-supplied order", not a fixed priority.
    const r2 = checkRateLimits([tokenDim(token), ipDim(ip)]);
    expect(r2.ok).toBe(false);
    if (r2.ok) throw new Error('unreachable');
    expect(r2.dimension).toBe('token');
  });

  // -------------------------------------------------------------------------
  // Memory pruning — 1000 hits stay bounded under 2 * limit.
  // -------------------------------------------------------------------------
  it('memory pruning: 1000 hits on a single key never exceed 2*limit + 1 entries', () => {
    const ip = '7.7.7.0/24';
    const dim = ipDim(ip);

    // Hammer the same key well past the window. Advance the clock by 1ms
    // each call so the pruner has stale entries to drop. Even if every
    // request is rejected, the implementation rebuilds the in-window
    // subset on overflow.
    for (let i = 0; i < 1000; i += 1) {
      checkRateLimits([dim]);
      vi.advanceTimersByTime(1); // 1ms per hit — 1000ms total, well under the 60s window
    }

    const size = __counterSize('ip', ip);
    // The implementation keeps at most `2*limit` entries before pruning;
    // worst case after a write is `2*limit + 1` (we append after the prune).
    expect(size).toBeLessThanOrEqual(2 * IP_LIMIT + 1);
  });

  // -------------------------------------------------------------------------
  // Empty dimension list → ok (defensive — nothing to check).
  // -------------------------------------------------------------------------
  it('empty dimension list → ok (degenerate-input safety)', () => {
    expect(checkRateLimits([]).ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Distinct keys on the same dimension → independent counters.
  // -------------------------------------------------------------------------
  it('distinct keys on same dimension → independent counters', () => {
    // Fill counter A to the cap.
    for (let i = 0; i < IP_LIMIT; i += 1) {
      const r = checkRateLimits([ipDim('A.A.A.0/24')]);
      expect(r.ok).toBe(true);
    }
    // Counter B (different key) should be unaffected.
    const r = checkRateLimits([ipDim('B.B.B.0/24')]);
    expect(r.ok).toBe(true);
  });
});
