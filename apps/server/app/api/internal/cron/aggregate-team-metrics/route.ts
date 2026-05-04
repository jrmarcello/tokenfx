/**
 * POST /api/internal/cron/aggregate-team-metrics — 15-min cron entry point
 * for the manager-dashboard-v2 spec (REQ-21, TASK-CRON-AGG).
 *
 * Authentication: shared secret in the `x-internal-cron-secret` header,
 * compared in constant time by `assertInternalCronAuth`. Failure returns
 * `{ error: { message, code: 'UNAUTHORIZED' } }` with HTTP 401.
 *
 * Returns a JSON envelope describing the run:
 *   { started_at, finished_at, rows_written, status: 'ok' | 'failed' }
 *
 * Status code:
 *   - 200 when status === 'ok'
 *   - 500 when status === 'failed' so the external scheduler retries
 *     (cron-job.org / GitHub Actions / Vercel Cron all use 5xx as the
 *     retry signal). The `cron_runs` row is already finalized to 'failed'
 *     by `aggregateTeamMetrics`, so retries don't double-write status.
 *
 * The route is the *only* code that catches `CronAuthError` — the lib
 * function never throws (it returns `{ status: 'failed', error }`), so the
 * try/catch here is purely the auth boundary.
 */
import { NextResponse } from 'next/server';
import { assertInternalCronAuth, CronAuthError } from '@/lib/cron/auth';
import { aggregateTeamMetrics } from '@/lib/cron/manager-v2/aggregate-team-metrics';
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
    // Any other error here is genuinely unexpected (the auth helper only
    // throws CronAuthError); rethrow so Next's error boundary surfaces it
    // in dev and it crashes loudly in prod.
    throw e;
  }

  const startedAt = new Date();
  const db = getDb();
  const result = await aggregateTeamMetrics(db);
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
