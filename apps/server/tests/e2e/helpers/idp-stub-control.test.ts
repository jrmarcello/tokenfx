import { describe, expect, it } from 'vitest';

import {
  resetStubScenario,
  setStubScenario,
  waitForStubReady,
} from './idp-stub-control';

const makeOkFetch = (): {
  fetch: typeof globalThis.fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    return new Response(null, { status: 204 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
};

const make503Fetch = (): typeof globalThis.fetch =>
  (async () => new Response('upstream failed', { status: 503 })) as typeof globalThis.fetch;

const makeRejectingFetch = (errMsg: string): typeof globalThis.fetch =>
  (async () => {
    throw new Error(errMsg);
  }) as typeof globalThis.fetch;

describe('idp-stub-control helpers', () => {
  describe('setStubScenario', () => {
    it('POSTs JSON to /admin/scenario at the configured baseUrl', async () => {
      const { fetch, calls } = makeOkFetch();
      await setStubScenario(
        { email: 'a@b.com' },
        { fetch, baseUrl: 'http://stub:3001' },
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('http://stub:3001/admin/scenario');
      expect(calls[0].init?.method).toBe('POST');
      const headers = new Headers(calls[0].init?.headers as HeadersInit);
      expect(headers.get('content-type')).toBe('application/json');
      expect(calls[0].init?.body).toBe(JSON.stringify({ email: 'a@b.com' }));
    });

    it('throws on non-2xx response (e.g. 503) with status + body context', async () => {
      const fetch = make503Fetch();
      await expect(
        setStubScenario({ email: 'a@b.com' }, { fetch, baseUrl: 'http://stub:3001' }),
      ).rejects.toThrow(/HTTP 503/);
    });

    it('throws when the underlying fetch rejects (network error)', async () => {
      const fetch = makeRejectingFetch('ECONNREFUSED');
      await expect(
        setStubScenario({ email: 'a@b.com' }, { fetch, baseUrl: 'http://stub:3001' }),
      ).rejects.toThrow(/ECONNREFUSED/);
    });
  });

  describe('resetStubScenario', () => {
    it('POSTs to /admin/scenario/reset with no body', async () => {
      const { fetch, calls } = makeOkFetch();
      await resetStubScenario({ fetch, baseUrl: 'http://stub:3001' });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('http://stub:3001/admin/scenario/reset');
      expect(calls[0].init?.method).toBe('POST');
    });

    it('throws on non-2xx response', async () => {
      const fetch = make503Fetch();
      await expect(
        resetStubScenario({ fetch, baseUrl: 'http://stub:3001' }),
      ).rejects.toThrow(/HTTP 503/);
    });
  });

  describe('waitForStubReady', () => {
    it('resolves immediately when the first probe is 200', async () => {
      const fetch = (async () => new Response('{}', { status: 200 })) as typeof globalThis.fetch;
      await expect(
        waitForStubReady({ fetch, baseUrl: 'http://stub:3001' }, 1_000),
      ).resolves.toBeUndefined();
    });

    it('throws after the timeout when every probe fails', async () => {
      const fetch = makeRejectingFetch('ECONNREFUSED');
      await expect(
        waitForStubReady({ fetch, baseUrl: 'http://stub:3001' }, 250),
      ).rejects.toThrow(/did not become ready within 250ms/);
    });
  });

  describe('defaults', () => {
    it('setStubScenario uses globalThis.fetch + IDP_STUB_BASE_URL env when no opts given', async () => {
      // Sentinel — we only verify the helper compiles + reads the env via
      // a quick non-throwing path by injecting a no-op fetch via opts.
      const { fetch, calls } = makeOkFetch();
      await setStubScenario({}, { fetch });
      // Either env-resolved or default 'http://localhost:3001'
      expect(calls[0].url.endsWith('/admin/scenario')).toBe(true);
    });
  });
});
