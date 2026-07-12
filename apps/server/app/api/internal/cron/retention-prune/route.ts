/**
 * POST /api/internal/cron/retention-prune — daily cron entry point for the
 * 24-month time-series retention prune (data-retention-policy, REQ-1).
 *
 * Auth: shared secret in `x-internal-cron-secret` (constant-time compare via
 * `assertInternalCronAuth`). Idempotent — re-running the same day deletes 0
 * additional rows.
 *
 * Response (REQ-23 cron_runs telemetry shape):
 *   { started_at, finished_at, rows_written, status }
 * HTTP 200 on 'ok', 500 on 'failed'.
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { assertInternalCronAuth, CronAuthError } from '@/lib/cron/auth';
import { resolveRetentionMonths, runRetentionPrune } from '@/lib/cron/retention-prune';

const errorBody = (message: string): { error: { message: string } } => ({
  error: { message },
});

export const POST = async (req: Request): Promise<NextResponse> => {
  try {
    assertInternalCronAuth(req);
  } catch (err) {
    if (err instanceof CronAuthError) {
      return NextResponse.json(errorBody('unauthorized'), { status: 401 });
    }
    return NextResponse.json(errorBody('cron auth error'), { status: 500 });
  }

  const startedAt = new Date().toISOString();
  try {
    const db = getDb();
    const months = resolveRetentionMonths(process.env);
    const result = await runRetentionPrune(db, { months });
    const finishedAt = new Date().toISOString();

    return NextResponse.json(
      {
        started_at: startedAt,
        finished_at: finishedAt,
        rows_written: result.rowsWritten,
        status: result.status,
      },
      { status: result.status === 'ok' ? 200 : 500 },
    );
  } catch {
    // `runRetentionPrune` is designed not to throw — if it does, honor the
    // security rule (no DB internals in the response).
    return NextResponse.json(errorBody('prune failed'), { status: 500 });
  }
};
