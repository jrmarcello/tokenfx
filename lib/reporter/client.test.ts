import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { pushBatch, type IngestEnvelope, type PushBatchInput } from './client';
import { canonicalJSON } from '@tokenfx/shared/reporter/canonical-json';
import type { SanitizedSessionPayload } from '@tokenfx/shared/reporter/types';

// ---------- helpers (hand-written stubs, no mocking framework) ----------

type FetchResponseInit = {
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: unknown;
  bodyIsInvalidJson?: boolean;
};

const makeResponse = (init: FetchResponseInit): Response => {
  const headers = new Headers(init.headers ?? {});
  if (init.bodyIsInvalidJson) {
    return new Response('not-json', {
      status: init.status,
      statusText: init.statusText,
      headers,
    });
  }
  const bodyStr = init.body === undefined ? '{}' : JSON.stringify(init.body);
  return new Response(bodyStr, {
    status: init.status,
    statusText: init.statusText,
    headers,
  });
};

type FetchCall = { url: string; init: RequestInit | undefined };

const makeFetchStub = (
  responses: ReadonlyArray<FetchResponseInit | Error>,
): {
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>;
  calls: FetchCall[];
} => {
  const calls: FetchCall[] = [];
  let i = 0;
  const fetchFn = async (
    url: string,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({ url, init });
    const next = responses[i++];
    if (next === undefined) {
      throw new Error(`fetch stub: no response queued for call #${i}`);
    }
    if (next instanceof Error) {
      throw next;
    }
    return makeResponse(next);
  };
  return { fetchFn, calls };
};

const makeSleepStub = (): {
  sleepFn: (ms: number) => Promise<void>;
  delays: number[];
} => {
  const delays: number[] = [];
  const sleepFn = async (ms: number): Promise<void> => {
    delays.push(ms);
  };
  return { sleepFn, delays };
};

const samplePayload = (): SanitizedSessionPayload => ({
  session_id: 'sess-123',
  started_at: 1_700_000_000,
  ended_at: 1_700_000_500,
  project_slug: 'slug:0123456789abcdef',
  git_branch: 'main',
  cc_version: '0.3.0',
  total_input_tokens: 10,
  total_output_tokens: 20,
  total_cache_read_tokens: 5,
  total_cache_creation_tokens: 2,
  total_cost_usd: 0.01,
  total_cost_usd_otel: null,
  turn_count: 3,
  tool_call_count: 4,
  model_breakdown: [],
  tool_counts: {},
  avg_rating: null,
  cache_hit_ratio: null,
  output_input_ratio: null,
  subagent_usage_ratio: null,
});

const sampleEnvelope = (): IngestEnvelope => ({
  version: 1,
  key_id: 'key-abc',
  machine_id: '00000000-0000-0000-0000-000000000000',
  payload: [samplePayload()],
});

const SAMPLE_SECRET = 'sample-secret-32bytes-hex-or-whatever';

const callInputs = (
  overrides: Partial<PushBatchInput> = {},
): PushBatchInput => ({
  centralUrl: 'https://central.example.com',
  envelope: sampleEnvelope(),
  secret: SAMPLE_SECRET,
  ...overrides,
});

// ---------- tests ----------

describe('pushBatch — TC-I-03 — REQ-8 — retries 5xx then succeeds', () => {
  it('retries after 500 with 1s backoff and succeeds on second attempt', async () => {
    const successBody = {
      accepted: 1,
      skipped: 0,
      rejected: 0,
      errors: [],
    };
    const { fetchFn, calls } = makeFetchStub([
      { status: 500, statusText: 'Server Error', body: { error: 'oops' } },
      { status: 200, body: successBody },
    ]);
    const { sleepFn, delays } = makeSleepStub();

    const result = await pushBatch(callInputs({ fetchFn, sleepFn }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe(200);
      expect(result.body).toEqual(successBody);
    }
    expect(calls).toHaveLength(2);
    // backoff between attempt 1 (failed 500) and attempt 2: 1000ms
    expect(delays).toEqual([1000]);
    // URL is centralUrl + /api/ingest, no double-slash
    expect(calls[0]?.url).toBe('https://central.example.com/api/ingest');
    // POST + content-type + Bearer + idempotency-key headers + JSON body
    expect(calls[0]?.init?.method).toBe('POST');
    const headers0 = calls[0]?.init?.headers as Record<string, string>;
    expect(headers0['content-type']).toBe('application/json');
    expect(headers0['authorization']).toBe(`Bearer ${SAMPLE_SECRET}`);
    expect(headers0['idempotency-key']).toBeTruthy();
    // Wire envelope no longer contains a signature.
    const sentBody = JSON.parse(calls[0]?.init?.body as string) as Record<string, unknown>;
    expect(sentBody.signature).toBeUndefined();
  });

  it('retries on network error then succeeds', async () => {
    const successBody = {
      accepted: 1,
      skipped: 0,
      rejected: 0,
      errors: [],
    };
    const { fetchFn, calls } = makeFetchStub([
      new Error('ECONNRESET'),
      { status: 200, body: successBody },
    ]);
    const { sleepFn, delays } = makeSleepStub();

    const result = await pushBatch(callInputs({ fetchFn, sleepFn }));

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(delays).toEqual([1000]);
  });

  it('exhausts 6 attempts on persistent 5xx and returns transient', async () => {
    const responses: FetchResponseInit[] = Array.from({ length: 7 }, () => ({
      status: 503,
      statusText: 'Service Unavailable',
    }));
    const { fetchFn, calls } = makeFetchStub(responses);
    const { sleepFn, delays } = makeSleepStub();

    const result = await pushBatch(callInputs({ fetchFn, sleepFn }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('transient');
      if (result.kind === 'transient') {
        expect(result.attempts).toBe(7);
        expect(result.lastStatus).toBe(503);
      }
    }
    // 7 fetch calls (initial + 6 retries)
    expect(calls).toHaveLength(7);
    // backoff sequence per spec: [1000, 2000, 4000, 8000, 16000, 32000]
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000]);
  });
});

describe('pushBatch — TC-I-04 — REQ-8 — 4xx no retry', () => {
  it('does NOT retry on 400 and returns permanent', async () => {
    const errBody = { error: { message: 'bad request' } };
    const { fetchFn, calls } = makeFetchStub([
      { status: 400, statusText: 'Bad Request', body: errBody },
    ]);
    const { sleepFn, delays } = makeSleepStub();

    const result = await pushBatch(callInputs({ fetchFn, sleepFn }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('permanent');
      if (result.kind === 'permanent') {
        expect(result.status).toBe(400);
        expect(result.body).toEqual(errBody);
      }
    }
    expect(calls).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it('does NOT retry on 401 and returns permanent', async () => {
    const { fetchFn, calls } = makeFetchStub([
      { status: 401, statusText: 'Unauthorized', body: { error: 'sig' } },
    ]);
    const { sleepFn, delays } = makeSleepStub();

    const result = await pushBatch(callInputs({ fetchFn, sleepFn }));

    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === 'permanent') {
      expect(result.status).toBe(401);
    }
    expect(calls).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it('handles permanent 4xx with non-JSON body (body=null)', async () => {
    const { fetchFn } = makeFetchStub([
      { status: 400, bodyIsInvalidJson: true },
    ]);
    const { sleepFn } = makeSleepStub();

    const result = await pushBatch(callInputs({ fetchFn, sleepFn }));

    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === 'permanent') {
      expect(result.status).toBe(400);
      expect(result.body).toBeNull();
    }
  });
});

describe('pushBatch — unsupported_version kind — REQ-5/REQ-6', () => {
  it('maps a structured unsupported_version 400 to its own kind with the range (TC-U-03)', async () => {
    const errBody = {
      error: {
        message: 'unsupported wire protocol version',
        code: 'unsupported_version',
        supported_min: 1,
        supported_max: 1,
        received: 2,
      },
    };
    const { fetchFn, calls } = makeFetchStub([
      { status: 400, statusText: 'Bad Request', body: errBody },
    ]);
    const { sleepFn, delays } = makeSleepStub();

    const result = await pushBatch(callInputs({ fetchFn, sleepFn }));

    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === 'unsupported_version') {
      expect(result.status).toBe(400);
      expect(result.supportedMin).toBe(1);
      expect(result.supportedMax).toBe(1);
      expect(result.received).toBe(2);
    } else {
      throw new Error(`expected unsupported_version, got ${JSON.stringify(result)}`);
    }
    expect(calls).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it('keeps a generic 400 (no code) as permanent (TC-U-04)', async () => {
    const errBody = { error: { message: 'envelope validation failed' } };
    const { fetchFn } = makeFetchStub([
      { status: 400, statusText: 'Bad Request', body: errBody },
    ]);
    const { sleepFn } = makeSleepStub();

    const result = await pushBatch(callInputs({ fetchFn, sleepFn }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('permanent');
  });

  it('keeps a 401 with an unrelated code as permanent (TC-U-05)', async () => {
    const { fetchFn } = makeFetchStub([
      { status: 401, statusText: 'Unauthorized', body: { error: { code: 'unauthorized' } } },
    ]);
    const { sleepFn } = makeSleepStub();

    const result = await pushBatch(callInputs({ fetchFn, sleepFn }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('permanent');
  });

  it('coerces omitted range fields to null, never undefined (TC-U-06)', async () => {
    const errBody = {
      error: { message: 'unsupported', code: 'unsupported_version', received: 3 },
    };
    const { fetchFn } = makeFetchStub([
      { status: 400, statusText: 'Bad Request', body: errBody },
    ]);
    const { sleepFn } = makeSleepStub();

    const result = await pushBatch(callInputs({ fetchFn, sleepFn }));

    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === 'unsupported_version') {
      expect(result.supportedMin).toBeNull();
      expect(result.supportedMax).toBeNull();
      expect(result.received).toBe(3);
    } else {
      throw new Error(`expected unsupported_version, got ${JSON.stringify(result)}`);
    }
  });
});

describe('pushBatch — TC-I-05 — REQ-8 — 429 honors Retry-After', () => {
  it('429 with Retry-After: 5 → waits 5s, retries, succeeds', async () => {
    const successBody = {
      accepted: 1,
      skipped: 0,
      rejected: 0,
      errors: [],
    };
    const { fetchFn, calls } = makeFetchStub([
      {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'retry-after': '5' },
        body: { error: 'rate limit' },
      },
      { status: 200, body: successBody },
    ]);
    const { sleepFn, delays } = makeSleepStub();

    const result = await pushBatch(callInputs({ fetchFn, sleepFn }));

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    // 5 seconds == 5000ms
    expect(delays).toEqual([5000]);
  });

  it('429 with Retry-After larger than 60 → caps at 60s', async () => {
    const { fetchFn, calls } = makeFetchStub([
      {
        status: 429,
        headers: { 'retry-after': '300' },
      },
      { status: 200, body: { accepted: 0, skipped: 1, rejected: 0, errors: [] } },
    ]);
    const { sleepFn, delays } = makeSleepStub();

    const result = await pushBatch(callInputs({ fetchFn, sleepFn }));

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    // capped at 60_000 ms
    expect(delays).toEqual([60_000]);
  });

  it('429 with no Retry-After → falls back to backoff schedule', async () => {
    const { fetchFn, calls } = makeFetchStub([
      { status: 429 },
      { status: 200, body: { accepted: 0, skipped: 0, rejected: 0, errors: [] } },
    ]);
    const { sleepFn, delays } = makeSleepStub();

    const result = await pushBatch(callInputs({ fetchFn, sleepFn }));

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    // first attempt index → backoff[0] = 1000ms
    expect(delays).toEqual([1000]);
  });
});

describe('pushBatch — URL handling', () => {
  it('strips trailing slash on centralUrl', async () => {
    const { fetchFn, calls } = makeFetchStub([
      { status: 200, body: { accepted: 0, skipped: 0, rejected: 0, errors: [] } },
    ]);
    const { sleepFn } = makeSleepStub();

    await pushBatch(
      callInputs({
        centralUrl: 'https://central.example.com/',
        fetchFn,
        sleepFn,
      }),
    );

    expect(calls[0]?.url).toBe('https://central.example.com/api/ingest');
  });
});

describe('pushBatch — Idempotency-Key derivation (REQ-7)', () => {
  it('derives Idempotency-Key from sha256(canonicalJSON(payload)) (first 32 hex chars)', async () => {
    const { fetchFn, calls } = makeFetchStub([
      { status: 200, body: { accepted: 1, skipped: 0, rejected: 0, errors: [] } },
    ]);
    const { sleepFn } = makeSleepStub();

    const env = sampleEnvelope();
    await pushBatch(callInputs({ envelope: env, fetchFn, sleepFn }));

    const expected = createHash('sha256')
      .update(canonicalJSON(env.payload))
      .digest('hex')
      .slice(0, 32);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe(expected);
    expect(headers['idempotency-key']).toMatch(/^[0-9a-f]{32}$/);
  });

  it('produces the same Idempotency-Key for logically equal payloads with different key order', async () => {
    const { fetchFn: fn1, calls: calls1 } = makeFetchStub([
      { status: 200, body: { accepted: 0, skipped: 0, rejected: 0, errors: [] } },
    ]);
    const { fetchFn: fn2, calls: calls2 } = makeFetchStub([
      { status: 200, body: { accepted: 0, skipped: 0, rejected: 0, errors: [] } },
    ]);
    const { sleepFn } = makeSleepStub();

    // Same logical payload, different key insertion order — canonicalJSON
    // sorts keys lexicographically so the idempotency-key must match.
    const p1 = samplePayload();
    const p2: SanitizedSessionPayload = {
      tool_counts: p1.tool_counts,
      session_id: p1.session_id,
      started_at: p1.started_at,
      ended_at: p1.ended_at,
      project_slug: p1.project_slug,
      git_branch: p1.git_branch,
      cc_version: p1.cc_version,
      total_input_tokens: p1.total_input_tokens,
      total_output_tokens: p1.total_output_tokens,
      total_cache_read_tokens: p1.total_cache_read_tokens,
      total_cache_creation_tokens: p1.total_cache_creation_tokens,
      total_cost_usd: p1.total_cost_usd,
      total_cost_usd_otel: p1.total_cost_usd_otel,
      turn_count: p1.turn_count,
      tool_call_count: p1.tool_call_count,
      model_breakdown: p1.model_breakdown,
      avg_rating: p1.avg_rating,
      cache_hit_ratio: p1.cache_hit_ratio,
      output_input_ratio: p1.output_input_ratio,
      subagent_usage_ratio: p1.subagent_usage_ratio,
    };

    await pushBatch(
      callInputs({
        envelope: { ...sampleEnvelope(), payload: [p1] },
        fetchFn: fn1,
        sleepFn,
      }),
    );
    await pushBatch(
      callInputs({
        envelope: { ...sampleEnvelope(), payload: [p2] },
        fetchFn: fn2,
        sleepFn,
      }),
    );

    const h1 = calls1[0]?.init?.headers as Record<string, string>;
    const h2 = calls2[0]?.init?.headers as Record<string, string>;
    expect(h1['idempotency-key']).toBe(h2['idempotency-key']);
  });
});
