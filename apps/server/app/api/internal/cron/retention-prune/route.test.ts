/**
 * Auth tests for POST /api/internal/cron/retention-prune (TC-I-06).
 * Mirrors the cron-auth pattern in aggregate-team-outcomes/route.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from '@/lib/db/client';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

const URL = 'http://localhost/api/internal/cron/retention-prune';

skipDescribe('POST /api/internal/cron/retention-prune — auth (TC-I-06)', () => {
  const ORIG_SECRET = process.env.INTERNAL_CRON_SECRET;
  const ORIG_NODE_ENV = process.env.NODE_ENV;
  const SECRET = 'test-internal-cron-secret-retention-prune';

  beforeAll(() => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'test';
    (process.env as Record<string, string | undefined>).INTERNAL_CRON_SECRET = SECRET;
  });

  afterAll(async () => {
    (process.env as Record<string, string | undefined>).INTERNAL_CRON_SECRET = ORIG_SECRET;
    (process.env as Record<string, string | undefined>).NODE_ENV = ORIG_NODE_ENV;
    await getDb().execute(sql`DELETE FROM cron_runs WHERE job_name = 'retention-prune'`);
    await closeDb();
  });

  it('missing header → 401, no prune', async () => {
    const { POST } = await import('@/app/api/internal/cron/retention-prune/route');
    const res = await POST(new Request(URL, { method: 'POST' }));
    expect(res.status).toBe(401);
  });

  it('wrong secret → 401', async () => {
    const { POST } = await import('@/app/api/internal/cron/retention-prune/route');
    const res = await POST(
      new Request(URL, { method: 'POST', headers: { 'x-internal-cron-secret': 'wrong-secret-pad-pad-pad-pad' } }),
    );
    expect(res.status).toBe(401);
  });

  it('correct secret → 200 with run summary', async () => {
    const { POST } = await import('@/app/api/internal/cron/retention-prune/route');
    const res = await POST(
      new Request(URL, { method: 'POST', headers: { 'x-internal-cron-secret': SECRET } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body).toHaveProperty('rows_written');
  });
});
