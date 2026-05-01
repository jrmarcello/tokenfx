/**
 * Daily cleanup of `ingestion_log.request_ip` values older than 30 days
 * (REQ-27). The truncated /24 IPv4 (or /48 IPv6) is retained for short-term
 * forensics and then nulled to honor the privacy ceiling.
 *
 * Invoked by `POST /api/admin/cleanup` on a daily cron schedule. Idempotent:
 * re-running the same day skips already-nulled rows because the predicate
 * filters on `request_ip IS NOT NULL`.
 */
import { and, lt, isNotNull } from 'drizzle-orm';
import { ingestionLog } from '@/lib/db/schema';
import type { getDb } from '@/lib/db/client';

type Db = ReturnType<typeof getDb>;

export type CleanupResult = {
  rowsUpdated: number;
};

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Set `request_ip = NULL` on `ingestion_log` rows whose `received_at` is
 * older than 30 days. Returns the number of rows that were updated.
 *
 * The query is parameterized (Drizzle's `lt` and `isNotNull` helpers bind
 * values, never interpolate) — no SQL injection surface.
 */
export const cleanupOldIps = async (db: Db): Promise<CleanupResult> => {
  const cutoff = new Date(Date.now() - RETENTION_MS);
  const result = await db
    .update(ingestionLog)
    .set({ requestIp: null })
    .where(
      and(lt(ingestionLog.receivedAt, cutoff), isNotNull(ingestionLog.requestIp)),
    )
    .returning({ id: ingestionLog.id });

  // `returning` gives us an exact count of rows updated regardless of the
  // underlying driver's `rowCount` reporting (more reliable than introspecting
  // `db.execute` result shapes across Drizzle versions).
  return { rowsUpdated: result.length };
};
