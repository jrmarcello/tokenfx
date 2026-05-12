/**
 * `redeemInvite()` — central-server-onboarding REQ-27 + REQ-28.
 *
 * Scope of THIS file:
 *   - **Token-rejection branches (REQ-27 steps 3–7, TASK-6b):** look up invite
 *     `FOR UPDATE`, then short-circuit on the five rejection conditions
 *     (`token-invalid`, `token-revoked`, `token-expired`, `token-exhausted`,
 *     `email-mismatch`). For every rejection a redemption-log row is written
 *     OUTSIDE the transaction (see "Log isolation" below) and a typed
 *     `Result.error.kind` is returned. The route layer (TASK-8) maps every
 *     non-`accepted` outcome to the same generic 401 body so attackers can't
 *     distinguish *which* check failed.
 *   - **Happy-path transaction (REQ-28, TASK-6a):** lookup invite (FOR
 *     UPDATE) → upsert user → mint key_id + secret → INSERT user_machines →
 *     bump invite.used_count → log redemption (`outcome='accepted'`).
 *
 * Out-of-scope (deferred):
 *   - Rate limiting (REQ-27 step 0) and Zod parse (REQ-27 step 1) — both
 *     guard the route handler ABOVE this function. Neither writes to
 *     `onboarding_redemption_log` (DoS-amplification protection — REQ-27).
 *     TASK-6c / TASK-8 wire those in.
 *   - The bcrypt-throw rollback test (TC-I-65) — TASK-6c.
 *
 * Atomicity (REQ-29): the happy-path mutations all happen inside a single
 * Drizzle transaction. Postgres default isolation is READ COMMITTED, which
 * the spec calls out explicitly — `SELECT ... FOR UPDATE` on the invite row
 * serializes concurrent redeems so the `used_count` increment is exact.
 *
 * Log isolation (REQ-2 + REQ-27): rejection-branch log writes happen on the
 * top-level connection (NOT inside the in-flight transaction). Two reasons:
 *
 *   1. **Durability under rollback** — if the rejection path were inside the
 *      transaction and we threw to abort, the log INSERT would be rolled
 *      back together with the (empty) transaction. We need the audit trail
 *      preserved EVEN when nothing else was written.
 *   2. **Symmetry with the route layer** — TASK-8's eventual rate-limit and
 *      Zod-failure paths also write to the log via the top-level `db`
 *      handle (those branches never enter a transaction at all). Keeping
 *      every rejection log at the same isolation level avoids surprise
 *      ordering bugs when sibling rejection branches grow.
 *
 * The happy-path log row IS still written inside the transaction so that
 * `accepted` rows are atomic with the user_machines INSERT — there must
 * never be an `accepted` log without a corresponding key, or vice versa.
 *
 * Email handling rules (REQ-28 step 1, TC-I-56):
 *   - Match `claimed_email` against `users.email` case-insensitively. The
 *     pre-existing schema stores `email` UNIQUE; we normalize to lowercase
 *     before lookup AND before INSERT so the canonical-form invariant is
 *     preserved.
 *   - Existing user with `team_id IS NULL` + invite has `team_id` →
 *     UPDATE the user's `team_id` (fill in missing assignment).
 *   - Existing user with non-NULL `team_id` → preserve. An invite cannot
 *     silently move a person between teams.
 *
 * Privacy invariant (TC-I-57, TC-I-50): the redemption log NEVER receives
 * the raw email — neither on `accepted` nor on rejection. We pass
 * `emailDomain(claimed_email)` and `hashEmail(claimed_email)` to
 * `writeRedemptionLog`. Computing both up front (before any branching)
 * means even the `token-invalid` path emits a populated `email_domain` +
 * `email_hash`, which is what TC-I-50 asserts and what TC-I-58 relies on
 * for hash reproducibility.
 *
 * Test seam (`opts.hashFn`): the bcrypt hash function is injectable so
 * TASK-6c's TC-I-65 can pass a stub that throws — verifies the transaction
 * rolls back cleanly without partial writes. Default is `bcrypt.hash`.
 */
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import { and, eq, sql } from 'drizzle-orm';
import {
  onboardingInvites,
  userMachines,
  users,
} from '@/lib/db/schema';
import type { getDb } from '@/lib/db/client';
import { BCRYPT_COST } from '@/lib/auth/bearer-auth';
import { generateKeyId } from '@/lib/auth/tokens';
import { hashEmail, emailDomain } from '@/lib/auth/email-hash';
import { matchEmailPattern } from '@/lib/auth/match-email-pattern';
import { writeRedemptionLog, type OnboardingOutcome } from './redemption-log';

type Db = ReturnType<typeof getDb>;
type DrizzleTx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Hash function signature — exported so TASK-6c's TC-I-65 stub can match
 * it without importing bcrypt's types.
 */
export type BcryptHashFn = (plain: string, rounds: number) => Promise<string>;

export type RedeemSuccess = {
  keyId: string;
  /** Plaintext secret — the ONLY moment this value exists outside bcrypt. */
  secret: string;
  /** Canonical lowercase email (matches what's in the users table). */
  userEmail: string;
  centralUrl: string;
};

/**
 * Rejection kinds surfaced to the caller. The route layer (TASK-8) collapses
 * every `token-*` / `email-mismatch` value into one identical 401 body — the
 * `kind` here is for server-internal observability (metrics, structured
 * logs) and the audit trail in `onboarding_redemption_log`.
 */
export type RedeemErrorKind =
  | 'token-invalid'
  | 'token-revoked'
  | 'token-expired'
  | 'token-exhausted'
  | 'email-mismatch'
  | 'infra';

export type RedeemError =
  | { kind: 'token-invalid' | 'token-revoked' | 'token-expired' | 'token-exhausted' | 'email-mismatch' }
  | { kind: 'infra'; cause: unknown };

export type RedeemResult =
  | { ok: true; value: RedeemSuccess }
  | { ok: false; error: RedeemError };

export type RedeemInput = {
  /** 64-char hex token. Validation upstream of this function (route-level Zod). */
  token: string;
  machineId: string;
  hostname: string;
  /** Email AS SUBMITTED — we lowercase it internally for matching/storage. */
  claimedEmail: string;
  /** Truncated to /24 (IPv4) or /48 (IPv6) by the caller. May be null. */
  requestIp: string | null;
};

export type RedeemOpts = {
  /** Test seam — defaults to `bcrypt.hash`. */
  hashFn?: BcryptHashFn;
};

const KEY_ID_RETRY_LIMIT = 3;

/**
 * Resolve the central URL surfaced back to the reporter setup CLI.
 * Single source of truth: `process.env.CENTRAL_URL`. Default mirrors the
 * dev port from `apps/server/package.json` so a barebones dev setup works.
 */
const getCentralUrl = (): string => {
  const v = process.env.CENTRAL_URL;
  return v && v.length > 0 ? v : 'http://localhost:3232';
};

const TOKEN_PREFIX_LEN = 8;

type InviteRow = {
  token: string;
  orgId: string;
  teamId: string | null;
  emailPattern: string | null;
  maxUses: number;
  usedCount: number;
  expiresAt: Date;
  revokedAt: Date | null;
};

type InviteRowSql = {
  token: string;
  org_id: string;
  team_id: string | null;
  email_pattern: string | null;
  max_uses: number | string;
  used_count: number | string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
};

const normalizeInviteRow = (r: InviteRowSql): InviteRow => ({
  token: r.token,
  orgId: r.org_id,
  teamId: r.team_id,
  emailPattern: r.email_pattern,
  maxUses: typeof r.max_uses === 'number' ? r.max_uses : Number(r.max_uses),
  usedCount: typeof r.used_count === 'number' ? r.used_count : Number(r.used_count),
  expiresAt: r.expires_at instanceof Date ? r.expires_at : new Date(r.expires_at),
  revokedAt:
    r.revoked_at == null
      ? null
      : r.revoked_at instanceof Date
        ? r.revoked_at
        : new Date(r.revoked_at),
});

/**
 * Locate the invite by token with `FOR UPDATE` so concurrent redeems
 * serialize on this row. Returns the row or null when the token does not
 * exist (→ `token-invalid` rejection path).
 *
 * Drizzle's query builder doesn't expose row-level locking on `select(...)`
 * directly, so we drop to a parameterized raw query. The token is bound
 * (not interpolated) — SQL injection is impossible.
 */
const lookupInviteForUpdate = async (
  tx: DrizzleTx,
  token: string,
): Promise<InviteRow | null> => {
  const result = await tx.execute<InviteRowSql>(sql`
    SELECT token, org_id, team_id, email_pattern, max_uses, used_count,
           expires_at, revoked_at
    FROM ${onboardingInvites}
    WHERE token = ${token}
    FOR UPDATE
  `);
  const rows = Array.isArray(result)
    ? (result as unknown as InviteRowSql[])
    : ((result as unknown as { rows: InviteRowSql[] }).rows ?? []);
  if (rows.length === 0) return null;
  return normalizeInviteRow(rows[0]);
};

/**
 * Determine which (if any) rejection branch applies to a given invite row,
 * given the current time and the claimed email. Pure function — easy to
 * unit-test if a future task wants to add boundary coverage.
 *
 * Order MUST match REQ-27 steps 4–7 so the redemption_log records the
 * "highest-priority" rejection (revoked beats expired beats exhausted beats
 * email-mismatch). A revoked-AND-expired token logs `token-revoked`; an
 * attacker probing for "is this token revoked or expired?" sees an
 * identical 401 body either way.
 */
type RejectionKind = Exclude<RedeemErrorKind, 'infra'>;

const classifyInvite = (
  invite: InviteRow,
  claimedEmail: string,
  now: Date,
): RejectionKind | null => {
  if (invite.revokedAt !== null) return 'token-revoked';
  if (now.getTime() > invite.expiresAt.getTime()) return 'token-expired';
  if (invite.usedCount >= invite.maxUses) return 'token-exhausted';
  if (!matchEmailPattern(invite.emailPattern, claimedEmail)) return 'email-mismatch';
  return null;
};

/**
 * Upsert the user keyed on lowercase email **scoped to the invite's org**.
 *
 * Cross-org isolation (REQ-16, central-server-onboarding-v2-sso): the WHERE
 * clause matches on `(email, org_id)` so a user with the same email in a
 * DIFFERENT org is never returned. This pairs with the
 * `unique('users_org_email_unique').on(t.orgId, t.email)` constraint added
 * in migration 0004 — without the org filter, the global-email lookup would
 * silently attach the new `user_machines` row to the wrong tenant.
 *
 * - Found (same org) + `team_id IS NULL` + invite has `team_id` → UPDATE team_id.
 * - Found (same org) + non-NULL `team_id` → preserve.
 * - Not found in invite's org → INSERT with sso_provider/subject NULL, role='member'.
 *
 * Returns the user's row id and canonical email.
 */
const upsertUserForInvite = async (
  tx: DrizzleTx,
  args: {
    canonicalEmail: string;
    inviteOrgId: string;
    inviteTeamId: string | null;
  },
): Promise<{ userId: string; userEmail: string }> => {
  const existing = await tx
    .select({
      id: users.id,
      email: users.email,
      teamId: users.teamId,
    })
    .from(users)
    .where(and(eq(users.email, args.canonicalEmail), eq(users.orgId, args.inviteOrgId)))
    .limit(1);

  if (existing.length > 0) {
    const u = existing[0];
    // Fill in missing team assignment if the invite specifies one.
    if (u.teamId === null && args.inviteTeamId !== null) {
      await tx
        .update(users)
        .set({ teamId: args.inviteTeamId })
        .where(eq(users.id, u.id));
    }
    return { userId: u.id, userEmail: u.email };
  }

  const [created] = await tx
    .insert(users)
    .values({
      orgId: args.inviteOrgId,
      teamId: args.inviteTeamId,
      email: args.canonicalEmail,
      ssoProvider: null,
      ssoSubject: null,
      role: 'member',
    })
    .returning({ id: users.id, email: users.email });
  return { userId: created.id, userEmail: created.email };
};

/**
 * Create a `user_machines` row, retrying on `key_id` UNIQUE collisions
 * (theoretical — 8-byte randomness gives ~10^-9 collision over a fleet
 * but the spec asks for the retry).
 */
const insertUserMachineWithRetry = async (
  tx: DrizzleTx,
  args: {
    userId: string;
    machineId: string;
    secretHash: string;
  },
): Promise<{ keyId: string }> => {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < KEY_ID_RETRY_LIMIT; attempt += 1) {
    const keyId = generateKeyId();
    try {
      await tx.insert(userMachines).values({
        userId: args.userId,
        machineId: args.machineId,
        keyId,
        secretHash: args.secretHash,
      });
      return { keyId };
    } catch (err) {
      // Re-raise non-uniqueness errors immediately. Postgres uses SQLSTATE
      // 23505 for unique_violation. node-postgres surfaces this on
      // `err.code`.
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String((err as { code: unknown }).code)
          : '';
      if (code !== '23505') throw err;
      lastErr = err;
    }
  }
  throw new Error('key_id collision exhausted retries', { cause: lastErr });
};

/**
 * Internal sentinel used to break out of the happy-path transaction with a
 * typed rejection reason. Throwing inside `db.transaction` triggers
 * ROLLBACK, which is exactly what we want when a check inside the tx
 * (currently only the `lookupInviteForUpdate` returning null) needs to
 * abort. No partial user_machines row leaks out.
 *
 * Rejection branches that fire AFTER the lookup (revoked/expired/exhausted/
 * email-mismatch) don't actually need this sentinel — they're caught
 * before any write happens — but we still throw it for symmetry, and the
 * outer try/catch translates it to the matching log+result.
 */
class RedeemPreconditionError extends Error {
  readonly kind: RejectionKind;
  constructor(kind: RejectionKind) {
    super(`redeem precondition failed: ${kind}`);
    this.kind = kind;
  }
}

/**
 * Map a `RedeemErrorKind` to the matching `OnboardingOutcome` enum value.
 * The two type-spaces overlap completely, but TS doesn't infer that across
 * the literal-union widening, so the explicit map keeps the boundary clean.
 */
const outcomeForRejection = (kind: RejectionKind): OnboardingOutcome => kind;

/**
 * Redeem a (presumed-valid) invite and provision a new `user_machines`
 * row + plaintext-secret/key-id pair. See module header for scope notes.
 */
export const redeemInvite = async (
  db: Db,
  input: RedeemInput,
  opts?: RedeemOpts,
): Promise<RedeemResult> => {
  const hashFn: BcryptHashFn = opts?.hashFn ?? bcrypt.hash;
  // Canonical email used for both lookup and the redemption-log hash. NFC
  // normalization happens inside `hashEmail`; for users.email storage we
  // use lowercase only (the schema's UNIQUE constraint operates on the
  // text value as-stored, not on a normalized form).
  const canonicalEmail = input.claimedEmail.toLowerCase();
  const tokenPrefix = input.token.slice(0, TOKEN_PREFIX_LEN);
  // Privacy invariant — these are computed up front so EVERY rejection
  // branch (including `token-invalid`, where we never see a real invite
  // row) emits a populated `email_domain` + `email_hash`. TC-I-50 asserts
  // this, TC-I-58 asserts hash reproducibility across two calls.
  const domain = emailDomain(input.claimedEmail);
  const ehash = hashEmail(input.claimedEmail);

  let txResult: { keyId: string; secret: string; userEmail: string } | null = null;
  let rejection: RejectionKind | null = null;
  let infraCause: unknown = null;

  try {
    txResult = await db.transaction(async (tx) => {
      const invite = await lookupInviteForUpdate(tx, input.token);
      if (!invite) {
        // No row, no lock acquired. Throw the sentinel so the transaction
        // commits empty (Postgres treats this as a no-op tx) and the outer
        // catch branches to the rejection-log writer.
        throw new RedeemPreconditionError('token-invalid');
      }

      const rejectKind = classifyInvite(invite, input.claimedEmail, new Date());
      if (rejectKind !== null) {
        // Same shape — exit the transaction without any UPDATE/INSERT.
        throw new RedeemPreconditionError(rejectKind);
      }

      const { userId, userEmail } = await upsertUserForInvite(tx, {
        canonicalEmail,
        inviteOrgId: invite.orgId,
        inviteTeamId: invite.teamId,
      });

      // Mint plaintext secret. 32 bytes → 64 hex chars (~256 bits entropy).
      const secret = randomBytes(32).toString('hex');
      const secretHash = await hashFn(secret, BCRYPT_COST);

      const { keyId } = await insertUserMachineWithRetry(tx, {
        userId,
        machineId: input.machineId,
        secretHash,
      });

      // Bump used_count atomically — the FOR UPDATE on the invite row
      // serializes concurrent redeems (REQ-29).
      await tx
        .update(onboardingInvites)
        .set({ usedCount: invite.usedCount + 1 })
        .where(eq(onboardingInvites.token, invite.token));

      // Audit log — `accepted`. Privacy: domain + peppered hash, never
      // the raw email. This write is INSIDE the tx so an `accepted` row
      // can never exist without its corresponding user_machines row.
      await writeRedemptionLog(tx, {
        tokenPrefix,
        machineId: input.machineId,
        emailDomain: domain,
        emailHash: ehash,
        requestIp: input.requestIp,
        outcome: 'accepted',
      });

      return { keyId, secret, userEmail };
    });
  } catch (err) {
    if (err instanceof RedeemPreconditionError) {
      rejection = err.kind;
    } else {
      infraCause = err;
    }
  }

  if (rejection !== null) {
    // Rejection-branch log write — happens on the TOP-LEVEL `db` connection,
    // outside the (already-aborted) transaction. See module header
    // "Log isolation". `machine_id` is NULL because no user_machines row
    // was inserted; `email_domain`/`email_hash` are populated regardless of
    // which step failed (TC-I-50 privacy invariant).
    try {
      await writeRedemptionLog(db, {
        tokenPrefix,
        machineId: null,
        emailDomain: domain,
        emailHash: ehash,
        requestIp: input.requestIp,
        outcome: outcomeForRejection(rejection),
      });
    } catch (logErr) {
      // The log write itself failed (DB down, etc). Surface as `infra` so
      // the caller doesn't return a misleading 401 — the request couldn't
      // be audited and we'd rather be honest about that than silently drop
      // the audit trail. This is intentionally rare.
      return { ok: false, error: { kind: 'infra', cause: logErr } };
    }
    return { ok: false, error: { kind: rejection } };
  }

  if (infraCause !== null) {
    return { ok: false, error: { kind: 'infra', cause: infraCause } };
  }

  // `txResult` is non-null here: the transaction either threw (handled
  // above) or returned a value. The explicit narrow keeps strict-null
  // happy without a non-null assertion.
  if (txResult === null) {
    return { ok: false, error: { kind: 'infra', cause: new Error('redeem transaction returned no value') } };
  }

  return {
    ok: true,
    value: {
      keyId: txResult.keyId,
      secret: txResult.secret,
      userEmail: txResult.userEmail,
      centralUrl: getCentralUrl(),
    },
  };
};
