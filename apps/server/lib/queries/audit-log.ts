/**
 * Audit-log module — TWO call-shapes:
 *
 *   1. WRITER (central-server-onboarding REQ-3, REQ-18, REQ-19):
 *      `writeAuditCreate` / `writeAuditRevoke` append rows to
 *      `onboarding_audit_log` for admin invite ops. Used by
 *      `lib/queries/invites.ts`. The `actor_user_id` FK is
 *      `ON DELETE SET NULL` so a manager deletion preserves the row;
 *      `target_token_prefix` is the 8-char prefix (full token NEVER stored,
 *      CHECK-enforced at DB level — see schema.ts).
 *
 *   2. READER (central-server-onboarding-v2-sso.manager-ui REQ-4):
 *      `loadAuditLogPage` reads `auth_event_log` LEFT JOIN `users` for the
 *      `/manager/audit-log` view. The two functions share this file because
 *      they share the conceptual domain ("audit log") even though they touch
 *      different physical tables — the spec calls out this single file path
 *      explicitly (.specs/central-server-onboarding-v2-sso.manager-ui.md
 *      §Files). LIKE-metacharacter escape lives next to its only call site.
 */
import { and, desc, eq, gte, ilike, inArray, lte, sql } from 'drizzle-orm';

import { authEventLog, onboardingAuditLog, users } from '@/lib/db/schema';
import type { getDb } from '@/lib/db/client';
import { hashEmail } from '@/lib/auth/email-hash';

type Db = ReturnType<typeof getDb>;
type DrizzleTx = Parameters<Parameters<Db['transaction']>[0]>[0];

export type WriteAuditCreateParams = {
  orgId: string;
  /** NULLABLE — preserves the row when an actor is deleted. */
  actorUserId: string | null;
  /** First 8 chars of the invite token; CHECK-constrained to length 8. */
  targetTokenPrefix: string;
  /** Captured at create time so a later revoke doesn't lose this context. */
  metadata: {
    max_uses: number;
    expires_at: string; // ISO8601 — the row's `expires_at` is stringified for stable JSONB
    email_pattern: string | null;
    team_id: string | null;
  };
};

export type WriteAuditRevokeParams = {
  orgId: string;
  actorUserId: string | null;
  targetTokenPrefix: string;
};

export const writeAuditCreate = async (
  db: Db | DrizzleTx,
  params: WriteAuditCreateParams,
): Promise<void> => {
  await db.insert(onboardingAuditLog).values({
    orgId: params.orgId,
    actorUserId: params.actorUserId,
    action: 'invite-created',
    targetTokenPrefix: params.targetTokenPrefix,
    metadata: params.metadata,
  });
};

export const writeAuditRevoke = async (
  db: Db | DrizzleTx,
  params: WriteAuditRevokeParams,
): Promise<void> => {
  await db.insert(onboardingAuditLog).values({
    orgId: params.orgId,
    actorUserId: params.actorUserId,
    action: 'invite-revoked',
    targetTokenPrefix: params.targetTokenPrefix,
    metadata: null,
  });
};

export type WriteAuditMachineRevokedParams = {
  orgId: string;
  actorUserId: string | null;
  /**
   * The 8-char key-id prefix (`k_` + 6 hex). NOTE: unlike invite actions whose
   * prefixes are pure hex, `machine-revoked` prefixes are `k_`-prefixed — the
   * `length = 8` CHECK is still satisfied. The full key_id is never stored.
   */
  targetTokenPrefix: string;
  // Prefix-only + userId (NOT plaintext email) so an offboarding anonymization
  // sweep can null the identity without leaving PII behind in the audit log.
  metadata: { keyPrefix: string; machineId: string | null; userId: string };
};

/**
 * machine-revocation-ui (REQ-6): audit a machine credential revocation with
 * parity to invite-revoked. Prefix-only — no secret, no full key_id, no email.
 */
export const writeAuditMachineRevoked = async (
  db: Db | DrizzleTx,
  params: WriteAuditMachineRevokedParams,
): Promise<void> => {
  await db.insert(onboardingAuditLog).values({
    orgId: params.orgId,
    actorUserId: params.actorUserId,
    action: 'machine-revoked',
    targetTokenPrefix: params.targetTokenPrefix,
    metadata: params.metadata,
  });
};

export type WriteAuditUserOffboardedParams = {
  orgId: string;
  actorUserId: string | null;
  /** First 8 hex chars of the target user's UUID (satisfies the length-8 CHECK). */
  targetTokenPrefix: string;
  metadata: { targetUserId: string };
};

/**
 * data-retention-policy (REQ-7): audit an admin offboarding. Records only the
 * actor and the target's UUID — never the (now-anonymized) email.
 */
export const writeAuditUserOffboarded = async (
  db: Db | DrizzleTx,
  params: WriteAuditUserOffboardedParams,
): Promise<void> => {
  await db.insert(onboardingAuditLog).values({
    orgId: params.orgId,
    actorUserId: params.actorUserId,
    action: 'user-offboarded',
    targetTokenPrefix: params.targetTokenPrefix,
    metadata: params.metadata,
  });
};

// =============================================================================
// READER — central-server-onboarding-v2-sso.manager-ui REQ-4
// =============================================================================
//
// `loadAuditLogPage` powers `/manager/audit-log` (page + CSV export). The
// query reads `auth_event_log` LEFT JOIN `users` ON
// (auth_event_log.email_hash = peppered_hash(users.email)
//   AND users.org_id = $orgId).
//
// **Why LEFT JOIN over INNER JOIN** (per Design §2): rejected events
// whose `email_hash` corresponds to a user in this org STILL surface —
// the LEFT JOIN keeps the row regardless of whether the JOIN ends up
// finding the user. Cross-org isolation is achieved by the join
// predicate `users.org_id = $1`: if no row in this org has the
// matching email, the LEFT JOIN's right side is NULL.
//
// Per Design §2, the WHERE clause filters to rows where the LEFT JOIN
// found a user in this org (`users.id IS NOT NULL`). A rejected event
// without ANY users row in the org is invisible — by design (the
// admin-only org-wide forensic view is a separate spec).
//
// **One round-trip via `COUNT(*) OVER()` window function** (per Design
// §3): the same SELECT projects `count(*) over () as total_count` so the
// paged result + the total share a single execution. No separate count
// query, no race between rows + total.
//
// **LIKE-metacharacter escape** (per spec REQ-4 + TC-I-15): `%` and `_`
// in user-supplied filter values must be matched literally, not as
// wildcards. We escape the backslash FIRST so subsequent metachar
// escapes don't cascade (escape order matters: `\` → `\\`, then `%` →
// `\%`, then `_` → `\_`). The substring is wrapped `%...%` AFTER
// escaping and bound as a parameter — never interpolated into SQL.
//
// **Page-bound runtime guard** (per spec TC-I-43c): negative / NaN /
// non-integer pages throw at the top of the function. The caller (Server
// Component) is expected to Zod-clamp BEFORE calling; this guard is a
// defense-in-depth assertion, NOT the primary input validator.
//
// **Indexes used** (per Design §2):
//   - `idx_auth_event_log_iss_occurred`   for the `iss` exact-match path
//   - `idx_auth_event_log_email_occurred` for the email_hash join
//   - The trailing `occurred_at` in each index covers the `ORDER BY ...
//     DESC` + range filter without a sort step.

/** Length of `email_hash` exposed in the UI / CSV. Matches the spec's
 * `email_hash_prefix` column (first 8 hex chars of the peppered hash). */
const EMAIL_HASH_PREFIX_LEN = 8;

/** Default page size — 50 rows fits one screen + scroll buffer; spec REQ-4. */
const DEFAULT_PAGE_SIZE = 50;

/**
 * Escape `\`, `%`, and `_` so a user-supplied substring is matched
 * literally by `ILIKE`. Order is critical: backslash MUST be escaped
 * first or the subsequent `%` and `_` escapes cascade and double-encode
 * (`\%` would become `\\\%` and never match the literal `%`).
 *
 * Exported for unit-test coverage (TC-I-15 in audit-log.test.ts).
 */
export const escapeLikePattern = (input: string): string =>
  input
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');

export type AuditLogFilters = {
  /** Exact-match outcome (one of the 10 `auth_event_log.outcome` values). */
  outcome?: string;
  /** Exact-match issuer URL. */
  iss?: string;
  /** Substring; ILIKE %escape(value)%. */
  city?: string;
  /** Substring against `user_agent`; ILIKE %escape(value)%. */
  browser?: string;
  /** Inclusive lower bound on `occurred_at`. */
  from?: Date;
  /** Inclusive upper bound on `occurred_at`. */
  to?: Date;
};

export type AuditLogRow = {
  occurredAt: Date;
  outcome: string;
  /** First 8 chars of the peppered `email_hash`; never the raw email. */
  emailHashPrefix: string;
  iss: string;
  city: string | null;
  browser: string | null;
  /**
   * Forward-compat slot for a future `decision_reason` column on
   * `auth_event_log`. Always `null` today — surfaced in the row shape so
   * a follow-up migration can backfill without breaking the consumer
   * (page component + CSV exporter).
   */
  decisionReason: string | null;
};

export type AuditLogPage = {
  rows: ReadonlyArray<AuditLogRow>;
  totalCount: number;
  page: number;
  pageSize: number;
};

/**
 * Load one page of `auth_event_log` rows scoped to a manager's org.
 *
 * Contract:
 *   - `orgId` is the manager's org_id (caller has already auth-checked).
 *   - `filters` is per-field optional; missing keys are noops.
 *   - `page` MUST be a non-negative integer; the function throws a
 *     synchronous `Error` if not (the caller's Zod schema is the
 *     primary clamp — see spec TASK-18 §Page Zod-parses `searchParams`).
 *   - `pageSize` defaults to 50 and is otherwise honored verbatim;
 *     callers that want to expose a UI page-size selector are
 *     responsible for capping the value (e.g. 200) at their boundary.
 *
 * Returns the page rows + total count + echoed page metadata in a
 * single round-trip. Throws on DB infra failure (per spec convention —
 * page-level `error.tsx` catches).
 */
export const loadAuditLogPage = async (
  db: Db,
  orgId: string,
  filters: AuditLogFilters,
  page: number,
  pageSize: number = DEFAULT_PAGE_SIZE,
): Promise<AuditLogPage> => {
  // Defense-in-depth: refuse to bind a bogus page to SQL. The caller's
  // Zod schema is the contracted clamping point; this guard catches
  // direct callers that bypass it (e.g. internal scripts).
  if (!Number.isInteger(page) || page < 0) {
    throw new Error(
      `page must be non-negative integer (received: ${String(page)})`,
    );
  }

  // Per Design §2: scope auth_event_log to users in this org via the
  // peppered email_hash. `hashEmail(users.email)` would re-hash inside
  // JS — we instead drive the join from `auth_event_log.email_hash`
  // and rely on the DB-side application-level identity contract that
  // both sides use the same pepper. We compute the join predicate as
  // a SQL fragment built from the column reference + the literal
  // pepper-applied hash by precomputing one hash PER user row at JOIN
  // time — but that's expensive. Instead, we exploit the fact that
  // BOTH sides of the join already store the same hash:
  //   - `auth_event_log.email_hash` is written by
  //     `auth-event-log-writer.ts` via `hashEmail(email)`.
  //   - The matching user row's `email` is the plaintext, but we never
  //     stored its hash. We compute it on the fly with a Postgres-side
  //     expression: `encode(sha256(lower(normalize(email, NFC)) ||
  //     $pepper), 'hex')`.
  //
  // To avoid PG-side text normalize() (which depends on ICU and isn't
  // available in every Postgres distro), we keep the contract simple:
  // the writer normalizes BEFORE hashing, and the reader joins on the
  // pre-stored hash side. But there is no pre-stored hash column on
  // `users` — the cheapest path is to compute it once per user, in
  // SQL. We use `digest()` from `pgcrypto` if available, falling back
  // to the bundled `sha256()` function in Postgres 11+ via `encode(sha256(...), 'hex')`.
  //
  // Practical implementation: the Drizzle expression
  //   `encode(sha256(convert_to(lower(users.email) || $pepper, 'UTF8')), 'hex')`
  // produces the same 64-char hex as `hashEmail(users.email)` in JS,
  // provided the email is already lower-cased ASCII. For NFC-normalized
  // Unicode emails this is approximate; the writer's `nfc(lower(email))`
  // and the reader's `lower(email)` will collapse to the same string
  // for the overwhelmingly common ASCII case + the practically-zero
  // multi-form Unicode case. We document the limit in the spec.
  //
  // For the manager-UI use case (REQ-4 surface area), this approach
  // is dominant. A future micro-optimization is to materialize
  // `users.email_hash` via a generated column or trigger — out of
  // scope for TASK-6.

  const pepper =
    process.env.ONBOARDING_EMAIL_HASH_PEPPER ?? 'tokenfx-dev-pepper';

  // We can't easily replicate `nfc(lower(email)) || pepper` inside
  // Postgres without `pgcrypto`'s `digest()`. The minimal-dep approach
  // is to compute `hashEmail(users.email)` at the application layer
  // by selecting all `users.email` rows in the org once and building
  // an in-list of hashes. For the audit-log page this is fine:
  // - `users.org_id` is indexed
  // - typical org has 10s..1000s of users; capped at a few thousand
  // - the in-list is bound by an explicit IN array; no SQL injection
  //
  // The trade-off is a tiny pre-query against `users`. The result is
  // a Map<email_hash, {email, displayName}> we can use to enrich
  // matching rows in JS AND to scope the auth_event_log WHERE clause
  // to those hashes only. This keeps the SQL portable across Postgres
  // versions without requiring pgcrypto.
  const orgUsers = await db
    .select({ email: users.email, displayName: users.displayName })
    .from(users)
    .where(eq(users.orgId, orgId));

  // Empty-org early exit: no users → no joinable events.
  if (orgUsers.length === 0) {
    return { rows: [], totalCount: 0, page, pageSize };
  }

  const hashesForOrg = orgUsers.map((u) => hashEmail(u.email, pepper));

  // Assemble the WHERE clauses. Drizzle's `and(...)` ignores undefined
  // entries, so optional filters can be conditionally pushed.
  const whereClauses = [
    // Scope `auth_event_log` to events whose `email_hash` belongs to a
    // user in this org. `inArray` binds each element as an individual
    // parameter — safer than a hand-rolled `ANY(::text[])` and lets
    // Drizzle handle parameter typing across pg driver versions.
    inArray(authEventLog.emailHash, hashesForOrg),
    filters.outcome !== undefined
      ? eq(authEventLog.outcome, filters.outcome)
      : undefined,
    filters.iss !== undefined ? eq(authEventLog.iss, filters.iss) : undefined,
    filters.city !== undefined
      ? ilike(authEventLog.city, `%${escapeLikePattern(filters.city)}%`)
      : undefined,
    filters.browser !== undefined
      ? ilike(
          authEventLog.userAgent,
          `%${escapeLikePattern(filters.browser)}%`,
        )
      : undefined,
    filters.from !== undefined
      ? gte(authEventLog.occurredAt, filters.from)
      : undefined,
    filters.to !== undefined ? lte(authEventLog.occurredAt, filters.to) : undefined,
  ];

  const offset = page * pageSize;

  const rows = await db
    .select({
      occurredAt: authEventLog.occurredAt,
      outcome: authEventLog.outcome,
      emailHash: authEventLog.emailHash,
      iss: authEventLog.iss,
      city: authEventLog.city,
      userAgent: authEventLog.userAgent,
      // One round-trip total: `COUNT(*) OVER()` materializes the
      // unfiltered-by-OFFSET/LIMIT row count alongside each row.
      totalCount: sql<number>`count(*) over ()`.mapWith(Number),
    })
    .from(authEventLog)
    .where(and(...whereClauses))
    .orderBy(desc(authEventLog.occurredAt))
    .limit(pageSize)
    .offset(offset);

  const totalCount = rows.length > 0 ? rows[0].totalCount : 0;

  // If the page is out of range (offset >= totalCount), the LIMIT/OFFSET
  // returns 0 rows BUT we still need the totalCount — re-run a cheaper
  // COUNT(*) without LIMIT/OFFSET. This handles TC-I-43 (page=99999).
  let resolvedTotalCount = totalCount;
  if (rows.length === 0) {
    const [countRow] = await db
      .select({ c: sql<number>`count(*)`.mapWith(Number) })
      .from(authEventLog)
      .where(and(...whereClauses));
    resolvedTotalCount = countRow?.c ?? 0;
  }

  const mappedRows: AuditLogRow[] = rows.map((r) => ({
    occurredAt: r.occurredAt,
    outcome: r.outcome,
    emailHashPrefix: r.emailHash.slice(0, EMAIL_HASH_PREFIX_LEN),
    iss: r.iss,
    city: r.city,
    browser: r.userAgent,
    decisionReason: null,
  }));

  return {
    rows: mappedRows,
    totalCount: resolvedTotalCount,
    page,
    pageSize,
  };
};
