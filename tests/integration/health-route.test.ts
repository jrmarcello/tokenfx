import { describe, it, expect } from 'vitest';
import {
  GET,
  POST,
  PUT,
  PATCH,
  DELETE,
} from '@/app/api/health/route';

describe('GET /api/health', () => {
  it('TC-I-01: returns 200 { ok: true } with JSON content-type', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it('TC-I-04: does not touch the database', async () => {
    // Point the DB env at a bogus path before calling GET. The handler
    // must not attempt to open a database — if it did, it would throw
    // when trying to create the directory / open the file.
    const prev = process.env.DASHBOARD_DB_PATH;
    process.env.DASHBOARD_DB_PATH = '/dev/null/definitely-not-writable';
    try {
      const res = await GET();
      expect(res.status).toBe(200);
    } finally {
      if (prev === undefined) delete process.env.DASHBOARD_DB_PATH;
      else process.env.DASHBOARD_DB_PATH = prev;
    }
  });
});

describe('non-GET methods on /api/health', () => {
  it.each([
    ['POST', POST],
    ['PUT', PUT],
    ['PATCH', PATCH],
    ['DELETE', DELETE],
  ])('TC-I-02/03: %s returns 405 with Allow: GET header', async (_, handler) => {
    const res = await handler();
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });
});
