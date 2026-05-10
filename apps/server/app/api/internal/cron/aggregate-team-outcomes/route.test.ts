/**
 * Auth tests for `POST /api/internal/cron/aggregate-team-outcomes`
 * (manager-dashboard-v3-outcomes spec REQ-11). Mirrors Fase 4
 * `aggregate-team-metrics/route.test.ts:TC-I-49/50/51`.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { sql } from 'drizzle-orm';

import { closeDb, getDb } from '@/lib/db/client';

const SKIP = process.env.SKIP_PG_TESTS === '1';
const skipDescribe = SKIP ? describe.skip : describe;

const wipeCronRuns = async (): Promise<void> => {
  const db = getDb();
  await db.execute(
    sql`DELETE FROM cron_runs WHERE job_name = 'aggregate-team-outcomes'`,
  );
};

skipDescribe('POST /api/internal/cron/aggregate-team-outcomes — auth', () => {
  const ORIG_SECRET = process.env.INTERNAL_CRON_SECRET;
  const ORIG_NODE_ENV = process.env.NODE_ENV;
  const SECRET = 'test-internal-cron-secret-aggregate-outcomes';

  beforeAll(() => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'test';
    (process.env as Record<string, string | undefined>).INTERNAL_CRON_SECRET = SECRET;
  });

  afterAll(async () => {
    (process.env as Record<string, string | undefined>).INTERNAL_CRON_SECRET = ORIG_SECRET;
    (process.env as Record<string, string | undefined>).NODE_ENV = ORIG_NODE_ENV;
    await wipeCronRuns();
    await closeDb();
  });

  beforeEach(async () => {
    if (SKIP) return;
    await wipeCronRuns();
  });

  it('correct secret → 200 with run summary JSON', async () => {
    const { POST } = await import(
      '@/app/api/internal/cron/aggregate-team-outcomes/route'
    );
    const req = new Request(
      'http://localhost/api/internal/cron/aggregate-team-outcomes',
      {
        method: 'POST',
        headers: { 'x-internal-cron-secret': SECRET },
      },
    );
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body).toHaveProperty('started_at');
    expect(body).toHaveProperty('finished_at');
    expect(body).toHaveProperty('rows_written');
  });

  it('wrong secret → 401', async () => {
    const { POST } = await import(
      '@/app/api/internal/cron/aggregate-team-outcomes/route'
    );
    const req = new Request(
      'http://localhost/api/internal/cron/aggregate-team-outcomes',
      {
        method: 'POST',
        headers: { 'x-internal-cron-secret': 'wrong-secret-same-len-pad-pad' },
      },
    );
    const res = await POST(req);
    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      error: { message: string; code?: string };
    };
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('missing header → 401', async () => {
    const { POST } = await import(
      '@/app/api/internal/cron/aggregate-team-outcomes/route'
    );
    const req = new Request(
      'http://localhost/api/internal/cron/aggregate-team-outcomes',
      {
        method: 'POST',
      },
    );
    const res = await POST(req);
    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      error: { message: string; code?: string };
    };
    expect(body.error.code).toBe('UNAUTHORIZED');
  });
});
