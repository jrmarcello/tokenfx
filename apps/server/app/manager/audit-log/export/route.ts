/**
 * GET /manager/audit-log/export — audit-log CSV export (TASK-19, REQ-6).
 *
 * Returns one CSV row per `auth_event_log` event visible to the manager's
 * org, gated through the same `loadAuditLogPage` query (TASK-6) used by the
 * paged view. Hard cap of 10,000 rows; if the underlying total exceeds the
 * cap, the response sets `X-TokenFx-Truncated: true` so the page UX can
 * surface a "narrow filters to see more" hint.
 *
 * **Streaming**: the body is delivered as a `ReadableStream` that pushes the
 * header row first, then each data row from the materialized result array
 * via `for...of`. The current `loadAuditLogPage` (TASK-6) returns a
 * materialized array; the 10k cap keeps memory bounded. A future spec can
 * swap it for a true async-iterable cursor without changing this route's
 * surface area.
 *
 * **Auth**: 401 when no session; 403 for any role other than `manager` or
 * `admin`. Same shape as the sibling `/api/manager/dismiss-anomaly`
 * route — the unauthenticated case is split from the role gate so a
 * member-role user (with a valid session) can be distinguished in logs from
 * an anonymous probe. Both surfaces carry the standard `{ error: ... }`
 * envelope used elsewhere.
 *
 * **Test seam**: `exportAuditLogImpl(req, deps)` accepts injected `authFn`
 * and `loadAuditLogPageFn`. Production wraps with a lazy `auth()` import
 * (keeps NextAuth out of vitest's module graph) and the real query
 * function. Same pattern as `app/api/manager/dismiss-anomaly/route.ts`.
 *
 * **Privacy**: only the first 8 chars of the peppered `email_hash` are
 * surfaced. The plaintext email NEVER leaves the database — the query
 * already projects `emailHashPrefix`, this route just passes it through.
 *
 * **CSV safety**: every cell flows through `toCsvRow` (TASK-2) which
 * applies the OWASP formula-injection guard (`=`, `+`, `-`, `@`, `\t`,
 * `\r` → prefixed with `'`) and quotes cells that contain `,`, `"`, CR,
 * or LF. Line endings are CRLF per RFC-4180.
 */
import type { NextRequest } from 'next/server';
import type { Session } from 'next-auth';
import { z } from 'zod';

import { toCsvRow } from '@/lib/csv/format';
import { getDb } from '@/lib/db/client';
import {
  loadAuditLogPage,
  type AuditLogFilters,
  type AuditLogPage,
} from '@/lib/queries/audit-log';

/** Mirrors the `auth_event_log_outcome_check` CHECK constraint in schema.ts. */
const OUTCOME_VALUES = [
  'accepted-sso-auto',
  'rejected-public-domain',
  'rejected-multiple-matches',
  'rejected-no-match',
  'rejected-race',
  'rejected-csrf',
  'rejected-replay',
  'rejected-cross-idp',
  'rejected-pre-existing-binding',
  'email-not-verified',
] as const;

const MAX_TEXT_LEN = 200;

/** 10k cap per Design §4 — keeps memory bounded with the materialized loader. */
const ROW_CAP = 10_000;

/**
 * Single source of truth for query-string parsing. Mirrors the page-level
 * `searchParamsSchema` in `app/manager/audit-log/page.tsx` so filters
 * applied to the page view carry into the CSV export unchanged.
 * `.catch(undefined)` makes every field bullet-proof against malformed
 * input — invalid values fall back to "filter unset" (safer than 4xx-ing
 * a download).
 */
const searchParamsSchema = z.object({
  outcome: z.enum(OUTCOME_VALUES).optional().catch(undefined),
  iss: z.string().max(MAX_TEXT_LEN).optional().catch(undefined),
  city: z.string().max(MAX_TEXT_LEN).optional().catch(undefined),
  browser: z.string().max(MAX_TEXT_LEN).optional().catch(undefined),
  from: z.string().datetime({ offset: true }).optional().catch(undefined),
  to: z.string().datetime({ offset: true }).optional().catch(undefined),
});

type Db = ReturnType<typeof getDb>;

export type AuthFn = () => Promise<Session | null>;

/**
 * Loader function shape — production injects `loadAuditLogPage` from
 * `@/lib/queries/audit-log`. Exposed so unit tests can stub it without
 * touching Postgres.
 */
export type LoadAuditLogPageFn = (
  db: Db,
  orgId: string,
  filters: AuditLogFilters,
  page: number,
  pageSize?: number,
) => Promise<AuditLogPage>;

export type ExportAuditLogDeps = {
  authFn: AuthFn;
  loadAuditLogPageFn: LoadAuditLogPageFn;
};

const UNAUTHORIZED_BODY = JSON.stringify({
  error: { message: 'unauthorized', code: 'unauthorized' },
});
const FORBIDDEN_BODY = JSON.stringify({
  error: { message: 'forbidden', code: 'forbidden' },
});

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

const CSV_HEADER_ROW = toCsvRow([
  'timestamp',
  'outcome',
  'email_hash_prefix',
  'iss',
  'city',
  'browser',
  'decision_reason',
]);

/**
 * Build the `Content-Disposition` attachment filename. Format:
 *   `audit-log-<orgId>-<YYYY-MM-DD>.csv`
 * `orgId` is a UUID (safe in a filename); the date segment is the day the
 * export was requested (UTC) so re-exports the same day produce identical
 * filenames — handy for de-dup in the user's downloads folder.
 */
const buildFilename = (orgId: string): string => {
  const date = new Date().toISOString().slice(0, 10);
  return `audit-log-${orgId}-${date}.csv`;
};

/**
 * Build the response body as a streamed `ReadableStream<Uint8Array>`. The
 * stream pushes the header row first, then iterates the materialized result
 * rows in `for...of`. With the 10k cap (`ROW_CAP`) memory stays bounded;
 * the streamed body lets the response start flushing to the client before
 * the full CSV has been encoded.
 */
const buildCsvStream = (page: AuditLogPage): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      try {
        controller.enqueue(encoder.encode(CSV_HEADER_ROW));
        for (const row of page.rows) {
          const csv = toCsvRow([
            row.occurredAt,
            row.outcome,
            row.emailHashPrefix,
            row.iss,
            row.city,
            row.browser,
            row.decisionReason,
          ]);
          controller.enqueue(encoder.encode(csv));
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
};

/**
 * Pure-ish core. Tests inject `authFn` + `loadAuditLogPageFn`; production
 * wraps with a lazy `auth()` import + the real loader.
 */
export const exportAuditLogImpl = async (
  req: NextRequest | Request,
  deps: ExportAuditLogDeps,
): Promise<Response> => {
  // 1. AuthN: explicit 401 for no session so audit logs can distinguish
  //    anonymous probes from real-user role denials.
  const session = await deps.authFn();
  if (!session?.user?.orgId || !session.user.role) {
    return new Response(UNAUTHORIZED_BODY, {
      status: 401,
      headers: JSON_HEADERS,
    });
  }
  const { orgId, role } = session.user;
  if (role !== 'manager' && role !== 'admin') {
    return new Response(FORBIDDEN_BODY, {
      status: 403,
      headers: JSON_HEADERS,
    });
  }

  // 2. Zod-parse `searchParams`. `.catch(undefined)` on every field means
  //    malformed values silently degrade to "filter unset" — we never
  //    4xx a download for a bad query string.
  const url = new URL(req.url);
  const parsed = searchParamsSchema.parse({
    outcome: url.searchParams.get('outcome') ?? undefined,
    iss: url.searchParams.get('iss') ?? undefined,
    city: url.searchParams.get('city') ?? undefined,
    browser: url.searchParams.get('browser') ?? undefined,
    from: url.searchParams.get('from') ?? undefined,
    to: url.searchParams.get('to') ?? undefined,
  });

  const filters: AuditLogFilters = {
    outcome: parsed.outcome,
    iss: parsed.iss,
    city: parsed.city,
    browser: parsed.browser,
    from: parsed.from ? new Date(parsed.from) : undefined,
    to: parsed.to ? new Date(parsed.to) : undefined,
  };

  // 3. Load up to `ROW_CAP` rows. The loader returns `totalCount` via the
  //    `COUNT(*) OVER()` window function so we can decide truncation
  //    without a second round-trip.
  const db = getDb();
  const page = await deps.loadAuditLogPageFn(db, orgId, filters, 0, ROW_CAP);

  // 4. Shape headers. `X-TokenFx-Truncated: true` ONLY when totalCount
  //    exceeds the cap. The page-equal case (totalCount === ROW_CAP) is
  //    NOT truncated — the user got every row.
  const headers: Record<string, string> = {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${buildFilename(orgId)}"`,
  };
  if (page.totalCount > ROW_CAP) {
    headers['x-tokenfx-truncated'] = 'true';
  }

  return new Response(buildCsvStream(page), { status: 200, headers });
};

/**
 * Lazy-loaded `auth()` — keeps NextAuth out of vitest's module graph for
 * unit tests that import `exportAuditLogImpl` directly. Mirrors the
 * pattern in `app/api/manager/dismiss-anomaly/route.ts`.
 */
const lazyDefaultAuth: AuthFn = async () => {
  const mod = await import('@/lib/auth/auth');
  return mod.auth();
};

export const GET = (req: NextRequest): Promise<Response> =>
  exportAuditLogImpl(req, {
    authFn: lazyDefaultAuth,
    loadAuditLogPageFn: loadAuditLogPage,
  });
