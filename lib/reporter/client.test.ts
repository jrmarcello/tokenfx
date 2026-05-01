import { describe, it, expect } from 'vitest';
import { pushBatch, type PushBatchInput } from './client';
import type { SanitizedSessionPayload } from './types';

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

const sampleEnvelope = (): PushBatchInput['signedEnvelope'] => ({
  version: 1,
  key_id: 'key-abc',
  machine_id: '00000000-0000-0000-0000-000000000000',
  signature: 'a'.repeat(64),
  payload: [samplePayload()],
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

    const result = await pushBatch({
      centralUrl: 'https://central.example.com',
      signedEnvelope: sampleEnvelope(),
      fetchFn,
      sleepFn,
    });

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
    // POST + content-type + idempotency-key headers + JSON body
    expect(calls[0]?.init?.method).toBe('POST');
    const headers0 = calls[0]?.init?.headers as Record<string, string>;
    expect(headers0['content-type']).toBe('application/json');
    expect(headers0['idempotency-key']).toBeTruthy();
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

    const result = await pushBatch({
      centralUrl: 'https://central.example.com',
      signedEnvelope: sampleEnvelope(),
      fetchFn,
      sleepFn,
    });

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

    const result = await pushBatch({
      centralUrl: 'https://central.example.com',
      signedEnvelope: sampleEnvelope(),
      fetchFn,
      sleepFn,
    });

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

    const result = await pushBatch({
      centralUrl: 'https://central.example.com',
      signedEnvelope: sampleEnvelope(),
      fetchFn,
      sleepFn,
    });

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

    const result = await pushBatch({
      centralUrl: 'https://central.example.com',
      signedEnvelope: sampleEnvelope(),
      fetchFn,
      sleepFn,
    });

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

    const result = await pushBatch({
      centralUrl: 'https://central.example.com',
      signedEnvelope: sampleEnvelope(),
      fetchFn,
      sleepFn,
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === 'permanent') {
      expect(result.status).toBe(400);
      expect(result.body).toBeNull();
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

    const result = await pushBatch({
      centralUrl: 'https://central.example.com',
      signedEnvelope: sampleEnvelope(),
      fetchFn,
      sleepFn,
    });

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

    const result = await pushBatch({
      centralUrl: 'https://central.example.com',
      signedEnvelope: sampleEnvelope(),
      fetchFn,
      sleepFn,
    });

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

    const result = await pushBatch({
      centralUrl: 'https://central.example.com',
      signedEnvelope: sampleEnvelope(),
      fetchFn,
      sleepFn,
    });

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

    await pushBatch({
      centralUrl: 'https://central.example.com/',
      signedEnvelope: sampleEnvelope(),
      fetchFn,
      sleepFn,
    });

    expect(calls[0]?.url).toBe('https://central.example.com/api/ingest');
  });
});
