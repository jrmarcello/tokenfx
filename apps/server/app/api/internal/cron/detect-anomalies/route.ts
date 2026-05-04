/**
 * POST /api/internal/cron/detect-anomalies — TASK-CRON-ANOM (REQ-22, REQ-23).
 *
 * External-scheduler entry point for the nightly anomaly cron. Delegates
 * the actual work to `runDetectAnomalies` in `lib/cron/manager-v2/detect-anomalies.ts`
 * and translates the result into the JSON status shape the scheduler reads
 * for success/failure detection:
 *
 *   200 OK  →  { started_at, finished_at, rows_written, status: 'ok' }
 *   500     →  { started_at, finished_at, rows_written, status: 'failed' }
 *
 * Auth: shared secret in `x-internal-cron-secret` (delegated to
 * `assertInternalCronAuth`). A missing or wrong header throws
 * `CronAuthError` which we catch and surface as a clean 401 — never a 500
 * from a lower-layer crash.
 *
 * Sanitised errors only — the response body never echoes DB internals or
 * raw error messages (those are persisted in `cron_runs.error_message`
 * for diagnostics, accessible only to operators with DB access).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { assertInternalCronAuth, CronAuthError } from '@/lib/cron/auth';
import { runDetectAnomalies } from '@/lib/cron/manager-v2/detect-anomalies';

const errorBody = (message: string): { error: { message: string } } => ({
  error: { message },
});

export const POST = async (req: NextRequest): Promise<NextResponse> => {
  // 1. AuthN — throws on any mismatch.
  try {
    assertInternalCronAuth(req);
  } catch (err) {
    if (err instanceof CronAuthError) {
      return NextResponse.json(errorBody('unauthorized'), { status: err.status });
    }
    // Unknown error during auth — refuse to run. 500 keeps it visible in
    // the scheduler's failure metrics so an operator notices.
    return NextResponse.json(errorBody('internal error'), { status: 500 });
  }

  // 2. Run. The lib catches its own analysis errors and returns a status
  // struct — it should NEVER throw under normal conditions. If it does
  // (e.g. DB unreachable from the very first query), we still surface 500.
  try {
    const result = await runDetectAnomalies();
    const status = result.status === 'ok' ? 200 : 500;
    return NextResponse.json(
      {
        started_at: result.startedAt.toISOString(),
        finished_at: result.finishedAt.toISOString(),
        rows_written: result.rowsWritten,
        status: result.status,
      },
      { status },
    );
  } catch {
    return NextResponse.json(errorBody('detect-anomalies failed'), { status: 500 });
  }
};
