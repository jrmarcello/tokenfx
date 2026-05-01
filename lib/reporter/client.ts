import { createHash } from 'node:crypto';
import { canonicalJSON } from './canonical-json';
import type { IngestEnvelope } from './types';

/**
 * Push client for the reporter — POSTs an ingest envelope to the central
 * server's `/api/ingest` route. Implements the retry policy from REQ-8:
 *
 *   - HTTP 5xx or network error → retry with exponential backoff
 *     [1s, 2s, 4s, 8s, 16s, 32s] (max 6 retries → 7 total attempts).
 *   - HTTP 4xx (except 429) → no retry (contract bug, not transient).
 *   - HTTP 429 → honor `Retry-After` header (seconds) capped at 60s; if absent,
 *     fall back to the next backoff slot.
 *
 * Auth: `Authorization: Bearer <secret>` (central-server-onboarding REQ-7).
 * The plaintext secret is read from `data/reporter-config.json`. The server
 * looks up `user_machines.secret_hash` (bcrypt) by `key_id` and verifies via
 * `bcrypt.compare`. TLS provides payload integrity in transit; HMAC was
 * removed in the same refactor.
 */

export type IngestSuccessBody = {
  accepted: number;
  skipped: number;
  rejected: number;
  errors: ReadonlyArray<{ session_id: string; reason: string }>;
};

export type { IngestEnvelope } from './types';

export type PushBatchInput = {
  centralUrl: string;
  envelope: IngestEnvelope;
  /** Bearer secret from `data/reporter-config.json` (`secret` field). */
  secret: string;
  /** Injection seam for tests. Defaults to global `fetch`. */
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Injection seam for tests. Defaults to `setTimeout`-backed sleep. */
  sleepFn?: (ms: number) => Promise<void>;
};

export type PushBatchResult =
  | { ok: true; status: number; body: IngestSuccessBody }
  | {
      ok: false;
      kind: 'transient';
      lastStatus: number | null;
      attempts: number;
      lastError: string;
    }
  | { ok: false; kind: 'permanent'; status: number; body: unknown };

const BACKOFF_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 32000] as const;
const MAX_RETRY_AFTER_MS = 60_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Compute the wait time for a 429 response.
 *
 * If `Retry-After` is present and parses as a positive integer (seconds), use
 * that capped at `MAX_RETRY_AFTER_MS`. Otherwise fall back to the next backoff
 * slot.
 */
const retryAfterDelayMs = (
  header: string | null,
  attemptIndex: number,
): number => {
  if (header !== null) {
    const seconds = Number.parseInt(header, 10);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
    }
  }
  // Fallback: next backoff slot, clamped to last.
  const idx = Math.min(attemptIndex, BACKOFF_DELAYS_MS.length - 1);
  return BACKOFF_DELAYS_MS[idx] ?? 32_000;
};

/**
 * Derive the `Idempotency-Key` from the payload array directly. The reporter
 * previously used a slice of the HMAC signature; after the Bearer refactor
 * the signature is gone, so we recompute the same uniqueness guarantee from
 * `sha256(canonicalJSON(payload))`. Canonical JSON makes equivalent payloads
 * (different key order, different whitespace) produce the same key, so a
 * server-side retry of the same logical batch hits the same idempotency-key.
 */
const deriveIdempotencyKey = (
  payload: IngestEnvelope['payload'],
): string =>
  createHash('sha256').update(canonicalJSON(payload)).digest('hex').slice(0, 32);

export const pushBatch = async (
  input: PushBatchInput,
): Promise<PushBatchResult> => {
  const fetchFn = input.fetchFn ?? fetch;
  const sleep = input.sleepFn ?? defaultSleep;
  const url = `${input.centralUrl.replace(/\/$/, '')}/api/ingest`;
  const body = JSON.stringify(input.envelope);
  const idempotencyKey = deriveIdempotencyKey(input.envelope.payload);

  let attempt = 0;
  let lastError = '';
  let lastStatus: number | null = null;

  // Total attempts = initial + len(BACKOFF_DELAYS_MS) retries = 7.
  while (attempt <= BACKOFF_DELAYS_MS.length) {
    let res: Response | null = null;
    try {
      res = await fetchFn(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${input.secret}`,
          'idempotency-key': idempotencyKey,
        },
        body,
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      lastStatus = null;
      if (attempt >= BACKOFF_DELAYS_MS.length) break;
      await sleep(BACKOFF_DELAYS_MS[attempt] ?? 32_000);
      attempt++;
      continue;
    }

    lastStatus = res.status;

    if (res.ok) {
      const parsed = (await res.json().catch(() => null)) as
        | IngestSuccessBody
        | null;
      // Server contract is documented in REQ-14; a 2xx without the expected
      // body shape is a contract bug — surface it as a permanent failure so
      // the caller doesn't silently retry forever.
      if (parsed === null) {
        return {
          ok: false,
          kind: 'permanent',
          status: res.status,
          body: null,
        };
      }
      return { ok: true, status: res.status, body: parsed };
    }

    // 4xx (except 429) → permanent, no retry.
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      const errBody = await res.json().catch(() => null);
      return {
        ok: false,
        kind: 'permanent',
        status: res.status,
        body: errBody,
      };
    }

    // 429 → honor Retry-After (seconds), capped at 60s.
    if (res.status === 429) {
      const waitMs = retryAfterDelayMs(
        res.headers.get('retry-after'),
        attempt,
      );
      lastError = `429 (retry-after ${res.headers.get('retry-after') ?? 'absent'})`;
      if (attempt >= BACKOFF_DELAYS_MS.length) break;
      await sleep(waitMs);
      attempt++;
      continue;
    }

    // 5xx → backoff retry.
    lastError = `${res.status} ${res.statusText}`;
    if (attempt >= BACKOFF_DELAYS_MS.length) break;
    await sleep(BACKOFF_DELAYS_MS[attempt] ?? 32_000);
    attempt++;
  }

  return {
    ok: false,
    kind: 'transient',
    lastStatus,
    attempts: attempt + 1,
    lastError,
  };
};
