/**
 * POST /api/admin/cleanup — daily cron entry point for ingestion_log IP
 * retention (REQ-27, TASK-16).
 *
 * Authentication: shared secret in the `x-internal-cron-secret` header,
 * compared in constant time against `process.env.INTERNAL_CRON_SECRET`.
 * Missing or empty env var → all requests rejected (fail closed). Designed
 * to be called by an internal cron / scheduler — never exposed to end users.
 *
 * The handler is idempotent: re-running on the same day is a no-op (the
 * underlying query filters out already-nulled rows).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { getDb } from '@/lib/db/client';
import { cleanupOldIps } from '@/lib/queries/cleanup';

const errorBody = (message: string): { error: { message: string } } => ({
  error: { message },
});

const assertCronSecret = (req: NextRequest): boolean => {
  const expected = process.env.INTERNAL_CRON_SECRET;
  if (!expected || expected.length === 0) return false;
  const provided = req.headers.get('x-internal-cron-secret');
  if (!provided) return false;

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  // `timingSafeEqual` requires equal-length buffers — short-circuit on length
  // mismatch (the length itself is non-secret, so this leak is acceptable).
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

export const POST = async (req: NextRequest): Promise<NextResponse> => {
  if (!assertCronSecret(req)) {
    return NextResponse.json(errorBody('unauthorized'), { status: 401 });
  }

  try {
    const db = getDb();
    const result = await cleanupOldIps(db);
    return NextResponse.json({ rowsUpdated: result.rowsUpdated });
  } catch {
    // Never echo DB internals to the caller (security rule).
    return NextResponse.json(errorBody('cleanup failed'), { status: 500 });
  }
};
