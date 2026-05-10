/**
 * POST /api/internal/cron/aggregate-team-outcomes — daily cron entry
 * point for `manager-dashboard-v3-outcomes` (REQ-11). Mirrors
 * `aggregate-team-metrics/route.ts` exactly — same auth helper, same
 * envelope shape, same retry semantics (5xx on `failed` so external
 * scheduler retries; the `cron_runs` row is already finalized so
 * retries don't double-write status).
 */
import { NextResponse } from 'next/server';

import { assertInternalCronAuth, CronAuthError } from '@/lib/cron/auth';
import { aggregateTeamOutcomes } from '@/lib/cron/manager-v3/aggregate-team-outcomes';
import { getDb } from '@/lib/db/client';

const unauthorized = (): NextResponse =>
  NextResponse.json(
    { error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } },
    { status: 401 },
  );

export const POST = async (req: Request): Promise<NextResponse> => {
  try {
    assertInternalCronAuth(req);
  } catch (e) {
    if (e instanceof CronAuthError) return unauthorized();
    throw e;
  }

  const startedAt = new Date();
  const db = getDb();
  const result = await aggregateTeamOutcomes(db);
  const finishedAt = new Date();

  const body = {
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    rows_written: result.rowsWritten,
    status: result.status,
    ...(result.error ? { error: result.error } : {}),
  };

  return NextResponse.json(body, { status: result.status === 'ok' ? 200 : 500 });
};
