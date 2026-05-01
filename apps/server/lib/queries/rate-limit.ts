/**
 * In-memory sliding-window rate limiter for the onboarding redeem endpoint
 * (central-server-onboarding REQ-27 step 0, TASK-6c).
 *
 * Purpose:
 *   - Step 0 in the redeem-endpoint validation order. Sits ABOVE the DB
 *     layer so that rate-limited requests never touch
 *     `onboarding_redemption_log` (REQ-27 DoS-amplification protection — a
 *     flooding attacker would otherwise fill the log table).
 *   - Two dimensions per spec:
 *       1. `(ip_truncated_24, 10/min)` — defends IP-enumeration attacks.
 *       2. `(token, 3/min)`            — defends per-token bruteforce.
 *
 * Design notes:
 *   - In-memory `Map<string, number[]>` per dimension. No Redis dependency
 *     because (a) the central server is single-process today and (b) the
 *     dashboards are localhost; honest scaling work moves this to a shared
 *     store and that's a bigger spec.
 *   - The "first exceeded" rule (REQ-27 step 0) is satisfied by checking
 *     dimensions in caller-supplied order. The route handler will pass
 *     `[ip, token]` — that ordering is encoded by the caller, not here.
 *   - Atomicity within a process: `checkRateLimits` is synchronous and runs
 *     to completion before any other request can advance (Node's
 *     single-threaded event loop). No locking needed.
 *   - Memory bound: when a counter for a key has more than `2 * limit`
 *     entries we prune to the in-window subset on the next pass. Worst case
 *     is `2 * limit` timestamps per active key — at `limit=10` and 1000
 *     active IPs that's 20k numbers (~160KB), well below any process budget.
 *
 * Test seam: `__resetRateLimits()` clears every counter so unit tests start
 * from a clean slate. Mirrors `__resetIngestAuthCache` from
 * `lib/auth/bearer-auth.ts`.
 */

/**
 * Result of a `checkRateLimits` call.
 *
 * `dimension` reports WHICH side hit the cap (so the route handler can emit
 * a structured `logger.warn` per REQ-27 step 0). `retryAfterSec` is the
 * number of seconds the client should wait before the offending dimension's
 * window has room — derived from the OLDEST in-window timestamp on the
 * exceeded dimension, rounded up.
 */
export type RateLimitResult =
  | { ok: true }
  | { ok: false; retryAfterSec: number; dimension: 'ip' | 'token' };

/**
 * Caller-supplied dimension descriptor. The `name` field is part of the
 * public contract because the result reports it back; `key` is the value
 * we count under (the truncated IP, the token, etc.); `limit` is the
 * maximum number of requests within `windowMs`.
 */
export type RateLimitDimensionInput = {
  name: 'ip' | 'token';
  key: string;
  limit: number;
  windowMs: number;
};

/**
 * Per-dimension storage — one Map keyed by `name`. Each name's Map keys are
 * the tracked values (e.g. truncated IPs); values are arrays of epoch-ms
 * timestamps of past requests. Older-than-window timestamps are pruned
 * lazily on each access.
 */
type CounterMap = Map<string, number[]>;
const counters: Map<'ip' | 'token', CounterMap> = new Map([
  ['ip', new Map()],
  ['token', new Map()],
]);

const getCounterMap = (name: 'ip' | 'token'): CounterMap => {
  // Both 'ip' and 'token' are pre-seeded above; the assertion is structural,
  // not value-dependent. We narrow with a concrete fallback to keep TS strict
  // happy without `!` non-null assertions.
  const existing = counters.get(name);
  if (existing) return existing;
  const fresh: CounterMap = new Map();
  counters.set(name, fresh);
  return fresh;
};

/**
 * Pruning threshold: when a key's timestamp array exceeds `2 * limit` entries
 * we reduce it to the in-window subset. Picked at 2x rather than 1x so the
 * common path (under-limit) doesn't pay a Theta(n) prune on every request —
 * we only pay it after the window has had time to fill twice over.
 */
const PRUNE_FACTOR = 2;

/**
 * Filter `timestamps` to those still inside the window `[now - windowMs, now]`.
 * Returns a new array; never mutates the input. Sorted-by-time invariant is
 * preserved because we always append in time order.
 */
const inWindow = (
  timestamps: ReadonlyArray<number>,
  now: number,
  windowMs: number,
): number[] => {
  const cutoff = now - windowMs;
  const out: number[] = [];
  for (const t of timestamps) {
    if (t > cutoff) out.push(t);
  }
  return out;
};

/**
 * Compute `Retry-After` seconds: how long until the OLDEST in-window
 * timestamp falls outside the window. If the array is empty (shouldn't
 * happen at the call site — we only ask after counting >= limit) we return
 * `1` so the client always has a positive wait.
 */
const retryAfterSec = (
  oldestInWindow: number,
  now: number,
  windowMs: number,
): number => {
  const elapsed = now - oldestInWindow;
  const remainingMs = Math.max(0, windowMs - elapsed);
  // Always round UP — a fractional second means "the slot won't free until
  // after the next whole second tick". Minimum of 1 so clients never get
  // told to retry "in 0 seconds" (which would invite an immediate retry
  // storm).
  return Math.max(1, Math.ceil(remainingMs / 1000));
};

/**
 * Atomic check-and-record across the supplied dimensions.
 *
 * Semantics (REQ-27 step 0):
 *   - For each dimension in order, count the in-window entries for `key`.
 *   - If ANY dimension's count is `>= limit`, return `{ok:false, ...}` for
 *     the FIRST exceeded dimension. NO timestamp is recorded on ANY
 *     dimension — the request is rejected, no side effects.
 *   - If all dimensions pass, append `now` to each dimension's counter and
 *     return `{ok:true}`.
 *
 * Pure-ish: reads `Date.now()` (the only impurity). Tests that need
 * deterministic clocks use `vi.useFakeTimers()` per the project's
 * "no mocking framework" rule (vitest's built-in fake timer is allowed
 * because it's part of vitest, not a separate mocking lib).
 */
export const checkRateLimits = (
  dimensions: ReadonlyArray<RateLimitDimensionInput>,
): RateLimitResult => {
  const now = Date.now();

  // First pass: detect any exceeded dimension. We compute the in-window
  // subset and write it back to the Map even on the rejection path — this
  // keeps memory bounded even when an attacker is hammering a key past the
  // limit (otherwise the counter would grow unbounded since we never
  // rewrite it).
  for (const d of dimensions) {
    const map = getCounterMap(d.name);
    const existing = map.get(d.key) ?? [];

    // Lazy prune: only rebuild the array when it has clearly grown past the
    // window's worth. Otherwise the in-window-count is computed without
    // mutating storage (the over-the-window tail is harmless until it gets
    // big).
    let timestamps = existing;
    if (existing.length > PRUNE_FACTOR * d.limit) {
      timestamps = inWindow(existing, now, d.windowMs);
      map.set(d.key, timestamps);
    }

    const windowed = timestamps === existing
      ? inWindow(existing, now, d.windowMs)
      : timestamps;

    if (windowed.length >= d.limit) {
      // Exceeded — the OLDEST in-window timestamp determines when a slot
      // frees. `windowed[0]` is the oldest because we append in time order.
      const oldest = windowed[0];
      // Persist the pruned subset so the counter doesn't grow unbounded
      // during the rejection path.
      map.set(d.key, windowed);
      return {
        ok: false,
        retryAfterSec: retryAfterSec(oldest, now, d.windowMs),
        dimension: d.name,
      };
    }
  }

  // All dimensions passed. Record the request timestamp on each dimension's
  // counter. We re-fetch the counter map (the prune pass above may have
  // replaced the array) so the append lands in the canonical storage.
  for (const d of dimensions) {
    const map = getCounterMap(d.name);
    const existing = map.get(d.key) ?? [];
    // Re-prune once more on the write path so the stored array stays
    // bounded after the append. The check pass already short-circuited; this
    // pass guarantees the post-write invariant `len <= 2*limit + 1`.
    const windowed =
      existing.length > PRUNE_FACTOR * d.limit
        ? inWindow(existing, now, d.windowMs)
        : existing;
    windowed.push(now);
    map.set(d.key, windowed);
  }

  return { ok: true };
};

/**
 * Test seam: clear every dimension's counter map. Production code never
 * calls this. Mirrors `__resetIngestAuthCache` from `lib/auth/bearer-auth.ts`.
 */
export const __resetRateLimits = (): void => {
  for (const map of counters.values()) {
    map.clear();
  }
};

/**
 * Test seam: snapshot the in-memory size of a key's counter array. Lets the
 * memory-pruning test assert the upper bound without exposing the raw Map.
 */
export const __counterSize = (
  name: 'ip' | 'token',
  key: string,
): number => {
  const map = counters.get(name);
  if (!map) return 0;
  return map.get(key)?.length ?? 0;
};
