/**
 * `GET /manager/teams/[id]/export` — team roster CSV export (REQ-10 / TASK-21).
 *
 * Streams the alphabetical member list of a team as RFC-4180 CSV. The
 * caller's `provisioned_via` filter (`all` | `token` | `sso-auto`) is
 * mirrored from the team-detail page so the exported file matches what
 * the manager sees on screen.
 *
 * Privacy invariant (REQ-10 + REQ-26 spirit): the CSV NEVER carries a
 * plaintext email. Every member row exports `hashEmail(email).slice(0, 8)`
 * as the identifier column — peppered SHA-256, first 8 hex chars. This
 * is the same construction the redemption-log uses (see
 * `lib/auth/email-hash.ts`) so a manager can correlate roster exports
 * with auth-event-log rows without us ever serializing the email itself.
 *
 * Cross-org safety: `getTeamDetail` returns `null` when the team is in a
 * different org than the caller's session. We surface that as a 404
 * (plain text body, no JSON envelope — this is a file-download route)
 * so an attacker cannot probe team-id existence across orgs.
 *
 * Cap + truncation: same 10,000-row contract as TASK-19 (audit-log
 * export). When the team roster would exceed 10,000 rows the response
 * carries `X-TokenFx-Truncated: true` and stops at exactly 10,000 data
 * rows; otherwise the header is `false`. Teams are unlikely to ever
 * hit this cap, but the contract is enforced uniformly.
 *
 * Test seam: production code uses `auth()` + `getTeamDetail()` directly;
 * tests call `exportTeamRosterImpl(...)` with explicit `{ authFn,
 * getTeamDetailFn }` deps. This mirrors the pattern in
 * `app/api/manager/dismiss-anomaly/route.ts` and keeps NextAuth +
 * Drizzle out of vitest's module graph for the unit suite.
 */
import type { NextRequest } from 'next/server';
import type { Session } from 'next-auth';
import { z } from 'zod';
import { toCsvRow } from '@/lib/csv/format';
import { hashEmail } from '@/lib/auth/email-hash';
import {
  getTeamDetail,
  type TeamDetail,
  type TeamMember,
  type TeamMemberProvisionedViaFilter,
} from '@/lib/queries/teams';
import { getDb } from '@/lib/db/client';

/** Row cap mirrored from TASK-19 (audit-log export). */
const ROW_CAP = 10_000;

const CSV_HEADER = 'email_hash_prefix,provisioned_via,created_at,last_login_at';

const PROVISIONED_VIA_SCHEMA = z
  .enum(['all', 'token', 'sso-auto'])
  .catch('all');

export type Db = ReturnType<typeof getDb>;

export type AuthFn = () => Promise<Session | null>;

export type GetTeamDetailFn = (
  db: Db,
  teamId: string,
  orgId: string,
  options?: { provisionedVia?: TeamMemberProvisionedViaFilter },
) => Promise<TeamDetail | null>;

export type ExportTeamRosterDeps = {
  authFn: AuthFn;
  getTeamDetailFn: GetTeamDetailFn;
};

const forbidden = (): Response =>
  new Response('forbidden', {
    status: 403,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });

const notFound = (): Response =>
  new Response('not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });

const coerceProvisionedVia = (
  raw: string | null,
): TeamMemberProvisionedViaFilter => PROVISIONED_VIA_SCHEMA.parse(raw ?? 'all');

const isoDate = (): string => new Date().toISOString().slice(0, 10);

const memberToRow = (m: TeamMember): string => {
  // Peppered SHA-256 prefix — 8 hex chars. Stable per (email, pepper) pair
  // so a manager re-exporting the same roster gets identical identifiers.
  // The pepper lives in env (see `lib/auth/email-hash.ts`); we NEVER pass
  // the plaintext email through `toCsvRow`.
  const prefix = hashEmail(m.email).slice(0, 8);
  return toCsvRow([
    prefix,
    m.provisionedVia,
    m.createdAt,
    m.lastLoginAt, // null → toCsvRow emits empty cell (NOT 'null').
  ]);
};

/**
 * Build the CSV body. Returns `{ body, truncated }` where `truncated` is
 * `true` when the input array exceeded `ROW_CAP`. The body always ends
 * with a trailing CRLF (each row produced by `toCsvRow` is CRLF-terminated).
 */
const buildCsv = (
  members: ReadonlyArray<TeamMember>,
): { body: string; truncated: boolean } => {
  const truncated = members.length > ROW_CAP;
  const sliced = truncated ? members.slice(0, ROW_CAP) : members;

  // Chunked append — single string concat in a loop, JS engines coalesce.
  // For the 10k-row case this is ~600 KiB — well within Response body
  // budgets and avoids the complexity of a streaming ReadableStream for
  // an in-memory roster. The TASK-19 audit-log export needs streaming
  // because it iterates a DB cursor; here `getTeamDetail` already
  // materialized the member list in memory, so an additional stream
  // wrapper would not save any memory.
  let body = `${CSV_HEADER}\r\n`;
  for (const m of sliced) {
    body += memberToRow(m);
  }
  return { body, truncated };
};

/**
 * Pure-ish core. Tests inject `authFn` + `getTeamDetailFn`; production
 * wraps with the real `auth()` + `getTeamDetail()`.
 *
 * `params` is the resolved (non-Promise) shape — production unwraps the
 * Next.js 15 `Promise<{id}>` at the `GET` handler boundary so the impl
 * stays straightforward to call from tests.
 */
export const exportTeamRosterImpl = async (
  request: NextRequest,
  context: { params: { id: string } },
  deps: ExportTeamRosterDeps,
): Promise<Response> => {
  // 1. AuthN/Z: require manager or admin role with a non-null orgId.
  const session = await deps.authFn();
  const role = session?.user?.role;
  const orgId = session?.user?.orgId;
  if (!orgId || (role !== 'manager' && role !== 'admin')) {
    return forbidden();
  }

  // 2. Whitelist-coerce `?provisioned_via` BEFORE handing to the query
  //    layer. The Zod `.catch('all')` swallows invalid values silently —
  //    same default the team-detail page uses (REQ-9).
  const rawFilter = request.nextUrl.searchParams.get('provisioned_via');
  const provisionedVia = coerceProvisionedVia(rawFilter);

  // 3. Query (tenant-scoped). `getTeamDetail` returns null when the team
  //    is in a different org → 404. This is the same surface used by the
  //    page route at `/manager/teams/[id]/page.tsx` (`notFound()`).
  const detail = await deps.getTeamDetailFn(getDb(), context.params.id, orgId, {
    provisionedVia,
  });
  if (!detail) {
    return notFound();
  }

  // 4. Build CSV + truncation header.
  const { body, truncated } = buildCsv(detail.members);

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="team-${context.params.id}-roster-${isoDate()}.csv"`,
      'X-TokenFx-Truncated': truncated ? 'true' : 'false',
    },
  });
};

/**
 * Lazy-loaded `auth()` — keeps NextAuth out of vitest's module graph for
 * the unit-test entry point. Mirrors the pattern in
 * `app/api/manager/dismiss-anomaly/route.ts`.
 */
const lazyDefaultAuth: AuthFn = async () => {
  const mod = await import('@/lib/auth/auth');
  return mod.auth();
};

const lazyDefaultGetTeamDetail: GetTeamDetailFn = async (
  db,
  teamId,
  orgId,
  options,
) => getTeamDetail(db, teamId, orgId, options);

export const GET = async (
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const params = await context.params;
  return exportTeamRosterImpl(
    request,
    { params },
    {
      authFn: lazyDefaultAuth,
      getTeamDetailFn: lazyDefaultGetTeamDetail,
    },
  );
};
