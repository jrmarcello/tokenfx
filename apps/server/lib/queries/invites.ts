/**
 * Invite queries — central-server-onboarding REQ-18, REQ-19, REQ-20.
 *
 * Pure DB helpers (no NextAuth, no `cookies()`, no `revalidatePath`) plus a
 * `createInviteCore` driver that owns the in-memory idempotency cache. The
 * Server Action shells in `app/manager/invites/actions.ts` are thin wrappers:
 * they call `auth()` + `cookies()` and delegate the business logic here. This
 * split is what makes the create flow unit-testable — Server Actions can't be
 * invoked outside Next.js, but `createInviteCore(stubDb, stubCache, ...)` can.
 *
 * Functions:
 *
 *   - `createInviteRow(db, params)` — INSERT one row with a freshly-generated
 *     token. Returns `{ token, tokenPrefix, expiresAt }`. The token PRIMARY KEY
 *     enforces uniqueness; on the astronomically improbable collision we retry
 *     once and then surrender (treat as paranoia, fail loudly so the alert
 *     fires rather than silently looping).
 *
 *   - `revokeInviteByPrefix(db, params)` — set `revoked_at = now()` on the row
 *     matching `left(token, 8) = ? AND org_id = ?`. Idempotent (already-revoked
 *     is a 'already-revoked' kind, not an error). Returns one of four kinds:
 *     'revoked' | 'already-revoked' | 'not-found' | 'collision'. The 'collision'
 *     branch defends against the (~10^-9 with 64-bit entropy) case where two
 *     active tokens share an 8-char prefix; the spec says fail loudly rather
 *     than silently revoke "the wrong one".
 *
 *   - `listInvitesForOrg(db, orgId)` — read view for the manager UI. Joins
 *     teams + users to enrich with `teamName` and `createdByEmail`. The full
 *     token is NEVER returned; only the 8-char prefix. `status` is derived
 *     in JS via priority order: revoked > expired > exhausted > active.
 *
 *   - `createInviteCore(deps, params)` — high-level driver: idempotency check,
 *     compute expiresAt, call createInviteRow, write audit log, cache the
 *     result. Returns the full `{ token, tokenPrefix, expiresAt }` plus a
 *     `cached: boolean` flag so the Server Action can set the flash cookie
 *     correctly on both first-call and replayed-call paths.
 *
 * Idempotency cache: a module-level `Map<key, entry>` keyed on
 * `${actorUserId}:${idempotencyKey}` with a 5-minute TTL. SINGLE-INSTANCE
 * ONLY — a multi-replica deployment would not share this Map. Spec Design
 * section flags this as out-of-scope for v1; if the manager dashboard ever
 * goes multi-replica, this gets persisted to a DB table (or Redis). The
 * Map is exported as `__resetIdempotencyCache` for tests to clear between
 * runs without stale state bleeding across `it()` blocks.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { onboardingInvites, teams, users } from '@/lib/db/schema';
import type { getDb } from '@/lib/db/client';
import { generateInviteToken } from '@/lib/auth/tokens';
import {
  writeAuditCreate,
  writeAuditRevoke,
  type WriteAuditCreateParams,
} from './audit-log';

type Db = ReturnType<typeof getDb>;

// ---------------------------------------------------------------------------
// createInviteRow — pure INSERT with token generation + retry-on-collision.
// ---------------------------------------------------------------------------

export type CreateInviteRowParams = {
  orgId: string;
  teamId: string | null;
  emailPattern: string | null;
  maxUses: number;
  expiresAt: Date;
  /** NULLABLE — `ON DELETE SET NULL` preserves the audit row when the actor is deleted. */
  createdBy: string | null;
};

export type CreateInviteRowResult = {
  /** Full 64-hex token. The ONLY place this leaks the row's plaintext. */
  token: string;
  /** First 8 chars — what the audit log + UI see. */
  tokenPrefix: string;
  /** Mirrored back so the caller doesn't have to recompute. */
  expiresAt: Date;
};

const PREFIX_LEN = 8;

const tokenPrefix = (token: string): string => token.slice(0, PREFIX_LEN);

/**
 * INSERT a fresh invite row. Token is generated here (not by the caller) so
 * the random source is owned by this module — easier to audit. On the rare
 * UNIQUE-violation on the token PK, we retry exactly ONCE (the second loss
 * implies a broken RNG — fail loudly so it surfaces).
 */
export const createInviteRow = async (
  db: Db,
  params: CreateInviteRowParams,
): Promise<CreateInviteRowResult> => {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = generateInviteToken();
    try {
      await db.insert(onboardingInvites).values({
        token,
        orgId: params.orgId,
        teamId: params.teamId,
        emailPattern: params.emailPattern,
        maxUses: params.maxUses,
        expiresAt: params.expiresAt,
        createdBy: params.createdBy,
      });
      return { token, tokenPrefix: tokenPrefix(token), expiresAt: params.expiresAt };
    } catch (err) {
      lastErr = err;
      // Postgres unique-violation = SQLSTATE 23505. Retry once with a new
      // token; any other error is non-recoverable (FK violation, conn loss).
      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? (err as { code?: unknown }).code
          : null;
      if (code !== '23505') throw err;
    }
  }
  throw new Error('createInviteRow: token PK collision retried twice — broken RNG?', {
    cause: lastErr,
  });
};

// ---------------------------------------------------------------------------
// revokeInviteByPrefix — idempotent UPDATE on the 8-char prefix index.
// ---------------------------------------------------------------------------

export type RevokeInviteByPrefixParams = {
  /** 8-char prefix as captured from the UI / Server Action. */
  prefix: string;
  /** Tenant scope: only revoke invites in the acting manager's org. */
  orgId: string;
};

export type RevokeInviteResult =
  | { kind: 'revoked'; tokenPrefix: string }
  | { kind: 'already-revoked'; tokenPrefix: string }
  | { kind: 'not-found' }
  | { kind: 'collision'; matchCount: number };

/**
 * Idempotent revoke. The UPDATE WHERE clause includes both `left(token, 8)`
 * (uses the functional index in REQ-1) AND `org_id = ?` (tenant scope). A
 * cross-org request becomes 'not-found' rather than 'unauthorized' — same
 * UX as "doesn't exist" prevents existence-probing across orgs.
 *
 * Two-step (SELECT then UPDATE) instead of a single UPDATE-RETURNING because
 * we need to discriminate four outcomes, not just "rows affected = 0/1".
 * Concurrent revokes on the same active row are still safe: PG row-level
 * locking inside the UPDATE serializes them; whichever loses the race sees
 * `revoked_at IS NOT NULL` on the next read and would map to
 * 'already-revoked'. We don't expose that race subtlety because the
 * idempotency contract is "calling revoke twice in a row is fine".
 */
export const revokeInviteByPrefix = async (
  db: Db,
  params: RevokeInviteByPrefixParams,
): Promise<RevokeInviteResult> => {
  if (params.prefix.length !== PREFIX_LEN) {
    // Defense-in-depth — Server Action's Zod also enforces this. A bare-string
    // caller shouldn't bypass it.
    return { kind: 'not-found' };
  }

  const matches = await db
    .select({
      token: onboardingInvites.token,
      revokedAt: onboardingInvites.revokedAt,
    })
    .from(onboardingInvites)
    .where(
      and(
        sql`left(${onboardingInvites.token}, ${PREFIX_LEN}) = ${params.prefix}`,
        eq(onboardingInvites.orgId, params.orgId),
      ),
    )
    .limit(2);

  if (matches.length === 0) return { kind: 'not-found' };
  if (matches.length > 1) {
    return { kind: 'collision', matchCount: matches.length };
  }

  const row = matches[0];
  if (row.revokedAt !== null) {
    return { kind: 'already-revoked', tokenPrefix: params.prefix };
  }

  await db
    .update(onboardingInvites)
    .set({ revokedAt: new Date() })
    .where(eq(onboardingInvites.token, row.token));

  return { kind: 'revoked', tokenPrefix: params.prefix };
};

// ---------------------------------------------------------------------------
// listInvitesForOrg — read view for the manager UI.
// ---------------------------------------------------------------------------

export type InviteStatus = 'active' | 'revoked' | 'expired' | 'exhausted';

export type InviteListRow = {
  /** First 8 chars only — full token NEVER leaked through this surface. */
  tokenPrefix: string;
  status: InviteStatus;
  maxUses: number;
  usedCount: number;
  emailPattern: string | null;
  /** `null` when invite is org-wide (no team binding) OR team has been deleted. */
  teamName: string | null;
  expiresAt: Date;
  /** `null` when the creator's row is gone (`ON DELETE SET NULL`). */
  createdByEmail: string | null;
  createdAt: Date;
};

/**
 * Status priority — `revoked` always wins (a revoked invite that also expired
 * is shown as revoked). Then expired (clock); then exhausted (max_uses hit);
 * else active.
 */
export const deriveInviteStatus = (input: {
  revokedAt: Date | null;
  expiresAt: Date;
  usedCount: number;
  maxUses: number;
  /** Optional clock seam — defaults to `Date.now()`; tests pass a fixed instant. */
  now?: Date;
}): InviteStatus => {
  if (input.revokedAt !== null) return 'revoked';
  const now = input.now ?? new Date();
  if (input.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (input.usedCount >= input.maxUses) return 'exhausted';
  return 'active';
};

/**
 * List invites for a single org, ordered by `created_at DESC` (newest first).
 * Joins teams + users to enrich with names; both joins are LEFT so a deleted
 * team / actor still surfaces the row (the `created_by` FK is `SET NULL`).
 *
 * **Full token is NEVER selected** — we project `left(token, 8)` directly in
 * SQL so the plaintext never travels through the Drizzle->JS->serializer
 * boundary. TC-I-30 audits this with a regex assertion on the result shape.
 */
export const listInvitesForOrg = async (
  db: Db,
  orgId: string,
  options?: { now?: Date },
): Promise<InviteListRow[]> => {
  const rows = await db
    .select({
      tokenPrefix: sql<string>`left(${onboardingInvites.token}, ${PREFIX_LEN})`,
      maxUses: onboardingInvites.maxUses,
      usedCount: onboardingInvites.usedCount,
      emailPattern: onboardingInvites.emailPattern,
      expiresAt: onboardingInvites.expiresAt,
      revokedAt: onboardingInvites.revokedAt,
      createdAt: onboardingInvites.createdAt,
      teamName: teams.name,
      createdByEmail: users.email,
    })
    .from(onboardingInvites)
    .leftJoin(teams, eq(teams.id, onboardingInvites.teamId))
    .leftJoin(users, eq(users.id, onboardingInvites.createdBy))
    .where(eq(onboardingInvites.orgId, orgId))
    .orderBy(desc(onboardingInvites.createdAt));

  return rows.map((r) => ({
    tokenPrefix: r.tokenPrefix,
    status: deriveInviteStatus({
      revokedAt: r.revokedAt,
      expiresAt: r.expiresAt,
      usedCount: r.usedCount,
      maxUses: r.maxUses,
      now: options?.now,
    }),
    maxUses: r.maxUses,
    usedCount: r.usedCount,
    emailPattern: r.emailPattern,
    teamName: r.teamName,
    expiresAt: r.expiresAt,
    createdByEmail: r.createdByEmail,
    createdAt: r.createdAt,
  }));
};

// ---------------------------------------------------------------------------
// createInviteCore — high-level driver with idempotency cache.
// ---------------------------------------------------------------------------

type IdempotencyEntry = {
  token: string;
  tokenPrefix: string;
  expiresAt: Date;
  cachedAt: number;
};

const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Module-level idempotency cache. SINGLE-INSTANCE ONLY — see Design section
 * of central-server-onboarding.md. A multi-replica deployment would need a
 * persistent store (DB table or Redis); out of scope for v1.
 *
 * Exported via `__resetIdempotencyCache` for tests; production callers must
 * NOT touch it directly.
 */
const idempotencyCache = new Map<string, IdempotencyEntry>();

const idempotencyKey = (actorUserId: string, key: string): string =>
  `${actorUserId}:${key}`;

const getCached = (
  store: Map<string, IdempotencyEntry>,
  actorUserId: string,
  key: string,
  now: number,
): IdempotencyEntry | null => {
  const entry = store.get(idempotencyKey(actorUserId, key));
  if (!entry) return null;
  if (now - entry.cachedAt > IDEMPOTENCY_TTL_MS) {
    store.delete(idempotencyKey(actorUserId, key));
    return null;
  }
  return entry;
};

const setCached = (
  store: Map<string, IdempotencyEntry>,
  actorUserId: string,
  key: string,
  entry: Omit<IdempotencyEntry, 'cachedAt'>,
  now: number,
): void => {
  store.set(idempotencyKey(actorUserId, key), { ...entry, cachedAt: now });
};

/**
 * Test-only seam. Production code never imports this. Calling it between
 * tests guarantees a clean cache so test order doesn't matter.
 */
export const __resetIdempotencyCache = (): void => {
  idempotencyCache.clear();
};

export type CreateInviteCoreParams = {
  /** Acting manager / admin's `users.id` UUID. Used for cache + audit. */
  actorUserId: string;
  /** Acting user's org. The created row binds to this org. */
  orgId: string;
  /** Caller-supplied UUID; same key within TTL → return cached result. */
  idempotencyKey: string;
  /** Validated by Zod at the action shell. */
  teamId: string | null;
  emailPattern: string | null;
  maxUses: number;
  expiresInHours: number;
  /** Test seam — defaults to `new Date()`. */
  now?: Date;
};

export type CreateInviteCoreDeps = {
  db: Db;
  /** Test seam — production passes `idempotencyCache`. */
  cache?: Map<string, IdempotencyEntry>;
  /** Test seam — production calls `writeAuditCreate(db, ...)`. */
  auditCreate?: (db: Db, params: WriteAuditCreateParams) => Promise<void>;
};

export type CreateInviteCoreResult = {
  /** Full 64-hex token — the Server Action puts this in the flash cookie. */
  token: string;
  /** First 8 chars — what the action returns to the form for display. */
  tokenPrefix: string;
  expiresAt: Date;
  /**
   * `true` when the response came from the idempotency cache (no DB write,
   * no audit row). The Server Action still sets the flash cookie in this
   * case so a double-clicked submit displays the same URL twice.
   */
  cached: boolean;
};

/**
 * High-level orchestration:
 *   1. Idempotency hit?  → return cached entry, `cached: true`. No INSERT,
 *      no audit row (the original call already wrote one).
 *   2. Else: compute expiresAt = now + expires_in_hours * 3600s.
 *   3. createInviteRow() → returns full token + prefix.
 *   4. writeAuditCreate(metadata = {max_uses, expires_at, email_pattern, team_id}).
 *   5. Cache the result.
 *   6. Return `{cached: false}`.
 */
export const createInviteCore = async (
  deps: CreateInviteCoreDeps,
  params: CreateInviteCoreParams,
): Promise<CreateInviteCoreResult> => {
  const cache = deps.cache ?? idempotencyCache;
  const now = params.now ?? new Date();
  const nowMs = now.getTime();

  // 1. Cache lookup.
  const hit = getCached(cache, params.actorUserId, params.idempotencyKey, nowMs);
  if (hit) {
    return {
      token: hit.token,
      tokenPrefix: hit.tokenPrefix,
      expiresAt: hit.expiresAt,
      cached: true,
    };
  }

  // 2. Compute expiry.
  const expiresAt = new Date(nowMs + params.expiresInHours * 3600 * 1000);

  // 3. INSERT.
  const row = await createInviteRow(deps.db, {
    orgId: params.orgId,
    teamId: params.teamId,
    emailPattern: params.emailPattern,
    maxUses: params.maxUses,
    expiresAt,
    createdBy: params.actorUserId,
  });

  // 4. Audit. Metadata `expires_at` is ISO8601 for stable JSONB shape.
  const auditFn = deps.auditCreate ?? writeAuditCreate;
  await auditFn(deps.db, {
    orgId: params.orgId,
    actorUserId: params.actorUserId,
    targetTokenPrefix: row.tokenPrefix,
    metadata: {
      max_uses: params.maxUses,
      expires_at: expiresAt.toISOString(),
      email_pattern: params.emailPattern,
      team_id: params.teamId,
    },
  });

  // 5. Cache.
  setCached(
    cache,
    params.actorUserId,
    params.idempotencyKey,
    {
      token: row.token,
      tokenPrefix: row.tokenPrefix,
      expiresAt: row.expiresAt,
    },
    nowMs,
  );

  return {
    token: row.token,
    tokenPrefix: row.tokenPrefix,
    expiresAt: row.expiresAt,
    cached: false,
  };
};

// ---------------------------------------------------------------------------
// revokeInviteCore — high-level driver: revoke + audit.
// ---------------------------------------------------------------------------

export type RevokeInviteCoreParams = {
  actorUserId: string;
  orgId: string;
  prefix: string;
};

export type RevokeInviteCoreDeps = {
  db: Db;
  auditRevoke?: (
    db: Db,
    params: { orgId: string; actorUserId: string | null; targetTokenPrefix: string },
  ) => Promise<void>;
};

export type RevokeInviteCoreResult =
  | { ok: true; kind: 'revoked' | 'already-revoked'; tokenPrefix: string }
  | { ok: false; kind: 'not-found' | 'collision' };

/**
 * Revoke + audit composition. We write an audit row ONLY on the 'revoked'
 * branch — already-revoked replays are no-ops at the DB level (the original
 * revoke already wrote its audit row), so writing a second audit row would
 * inflate the timeline with duplicates. 'not-found' / 'collision' don't
 * touch the DB so they have no audit footprint.
 */
export const revokeInviteCore = async (
  deps: RevokeInviteCoreDeps,
  params: RevokeInviteCoreParams,
): Promise<RevokeInviteCoreResult> => {
  const result = await revokeInviteByPrefix(deps.db, {
    prefix: params.prefix,
    orgId: params.orgId,
  });

  switch (result.kind) {
    case 'not-found':
      return { ok: false, kind: 'not-found' };
    case 'collision':
      return { ok: false, kind: 'collision' };
    case 'already-revoked':
      return { ok: true, kind: 'already-revoked', tokenPrefix: result.tokenPrefix };
    case 'revoked': {
      const auditFn = deps.auditRevoke ?? writeAuditRevoke;
      await auditFn(deps.db, {
        orgId: params.orgId,
        actorUserId: params.actorUserId,
        targetTokenPrefix: result.tokenPrefix,
      });
      return { ok: true, kind: 'revoked', tokenPrefix: result.tokenPrefix };
    }
  }
};
