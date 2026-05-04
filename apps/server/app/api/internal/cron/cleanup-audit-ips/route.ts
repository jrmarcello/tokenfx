/**
 * POST /api/internal/cron/cleanup-audit-ips — daily cron entry point for the
 * combined IP retention + notification prune cleanup (TASK-CRON-CLEANUP).
 *
 * Authentication: shared secret in `x-internal-cron-secret`, validated by
 * `assertInternalCronAuth` (constant-time compare). Failure throws
 * `CronAuthError` which the handler catches and turns into a 401.
 *
 * The handler is idempotent — re-running on the same day produces no
 * additional row mutations because both underlying queries filter on the
 * relevant timestamp predicate.
 *
 * Response shape (REQ-23 cron_runs telemetry):
 *   { started_at, finished_at, rows_written, status }
 *
 * `status` is the cron_runs status ('ok' | 'failed'). HTTP status is 200 on
 * 'ok' and 500 on 'failed' so external schedulers can alert on non-2xx.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/lib/db/client';
import { assertInternalCronAuth, CronAuthError } from '@/lib/cron/auth';
import { cleanupAuditIps } from '@/lib/cron/cleanup-audit-ips';

const errorBody = (message: string): { error: { message: string } } => ({
  error: { message },
});

export const POST = async (req: NextRequest): Promise<NextResponse> => {
  try {
    assertInternalCronAuth(req);
  } catch (err) {
    if (err instanceof CronAuthError) {
      return NextResponse.json(errorBody('unauthorized'), { status: 401 });
    }
    // Boot-time guard surfaces here in mis-configured environments.
    return NextResponse.json(errorBody('cron auth error'), { status: 500 });
  }

  const startedAt = new Date().toISOString();
  try {
    const db = getDb();
    const result = await cleanupAuditIps(db);
    const finishedAt = new Date().toISOString();
    const rowsWritten = result.ipsCleared + result.notificationsDeleted;

    const httpStatus = result.status === 'ok' ? 200 : 500;
    return NextResponse.json(
      {
        started_at: startedAt,
        finished_at: finishedAt,
        rows_written: rowsWritten,
        status: result.status,
      },
      { status: httpStatus },
    );
  } catch {
    // `cleanupAuditIps` is designed not to throw — if it does, we still
    // honor the security rule (no DB internals in the response).
    return NextResponse.json(errorBody('cleanup failed'), { status: 500 });
  }
};
