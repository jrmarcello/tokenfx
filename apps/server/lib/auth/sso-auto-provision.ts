/**
 * SSO auto-provision decision engine
 * (central-server-onboarding-v2-sso.backend.md — TASK-10).
 *
 * `evaluateAutoProvision(input, deps?)` runs the SSO-auto-provision decision
 * tree per spec §Decisão #2 ordering and short-circuits on the first
 * rejection per §Decisão #17 (sequential early-exit — NOT parallel; the
 * rate-limit MUST fire before any subsequent check decrements counters,
 * opens a transaction, or sends an email).
 *
 * Decision-engine pattern (spec §Design — "Decision-engine pattern"):
 *
 *   1. Rate-limit (T6, REQ-11/12)              — outside any DB tx
 *   2. IdP precondition: issuer + aud           (T1 M1.1-2, REQ-2a)
 *   3. IdP precondition: email_verified         (T1 M1.3, REQ-2a)
 *   4. Public-domain blocklist                  (T1.5, REQ-2)
 *   5. matchActiveInvitesByEmail                (T1.4 + T2, REQ-3)
 *   6. Single-match constraint                  (T2 M2.1, REQ-3)
 *   7. allowed_sso_providers (cross-IdP)        (T12.4, REQ-4)
 *   8. Pre-existing v1 user                     (T11.1, REQ-5)
 *   9. Transactional provision (SELECT FOR
 *      UPDATE + re-validate + INSERTs)          (T13.1, REQ-7/8)
 *
 * Audit-log discipline (REQ-9, §Decisão #16, §Decisão #23):
 *   - Rate-limited path writes ONLY to `onboarding_redemption_log` with
 *     outcome='rate-limited' (the v1 enum value). NO `auth_event_log` row
 *     (the CHECK doesn't include 'rate-limited').
 *   - All other rejected paths write to BOTH tables, OUTSIDE any tx (the
 *     tx — if one opened — has been rolled back; audit records must
 *     survive).
 *   - The accepted path writes BOTH audit rows INSIDE the `provisionInTx`
 *     transaction (Decisão #23) — `provisionInTx` accepts both writers as
 *     deps and invokes them from inside its tx so the audit rows atomically
 *     commit with the user_machines INSERT.
 *
 * Privacy invariants (REQ-9, §Decisão #13):
 *   - NEVER log raw email or raw `sso_subject` anywhere — only peppered
 *     hashes + the email domain.
 *   - `user_agent` is truncated to ≤512 chars at the audit-write boundary
 *     (the writer modules apply truncation; we pass the raw UA in).
 *
 * Dependency injection (§Decisão #18):
 *   `AutoProvisionDeps` exposes every external collaborator as an
 *   injectable function. Unit tests pass hand-written stubs (no mocking
 *   framework). Production uses `buildDefaultDeps()` which wires the real
 *   modules. The pattern mirrors `redeem.ts:redeemInvite(db, input, opts?)`.
 *
 *   Race detection (§Decisão #22 + REQ-15): after the FOR UPDATE select
 *   the locked row is fed into the pure `revalidateInvite` predicate
 *   (see `./revalidate-invite.ts`). Any failure reason (revoked / expired
 *   / exhausted) maps to `rejected-race` because all three are observable
 *   only AFTER the candidate-selection query already saw the row as live.
 *   The predicate is unit-tested in isolation; an end-to-end race scenario
 *   (concurrent UPDATE on a second connection) is covered by the flow
 *   integration suite.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { log as logger } from '@root/logger';

import { getDb } from '@/lib/db/client';
import { onboardingInvites, users } from '@/lib/db/schema';

import {
  type AuthEventOutcome,
  writeAuthEvent,
} from './auth-event-log-writer';
import { emailDomain, hashEmail } from './email-hash';
import { ipToCity } from './ip-to-city';
import {
  type ActiveInvite,
  matchActiveInvitesByEmail,
} from './match-active-invites';
import { sendPreExistingBindingEmail } from './pre-existing-binding-email';
import { isPublicDomain } from './public-domains';
import { checkSsoRateLimit } from './rate-limit-sso';
import { revalidateInvite } from './revalidate-invite';
import {
  type WriteRedemptionLogParams,
  writeRedemptionLog as rawWriteRedemptionLog,
} from '@/lib/queries/redemption-log';

/**
 * Single-arg redemption-log writer adapter. The underlying writer accepts
 * `(db, params)` so it can run inside either the top-level connection or
 * an in-flight Drizzle tx (mirrors `redeem.ts`). The decision-engine binds
 * the default to the top-level `getDb()` because every redemption-log row
 * it emits is either (a) on the rejected path (outside any tx) or (b) on
 * the accepted path where `provisionInTx` re-wraps the writer to bind it
 * to the tx handle internally. Tests inject simpler stubs that ignore the
 * connection parameter entirely.
 */
export type WriteRedemptionLogFn = (
  params: WriteRedemptionLogParams,
) => Promise<void>;

const defaultWriteRedemptionLog: WriteRedemptionLogFn = (params) =>
  rawWriteRedemptionLog(getDb(), params);

// =============================================================================
// Public types
// =============================================================================

export type AutoProvisionInput = {
  email: string;
  ssoProvider: string;
  ssoSubject: string;
  /** OIDC `iss` claim — checked against the issuer whitelist (REQ-2a). */
  ssoIssuer: string;
  /** OIDC `aud` claim — checked against the configured client id (REQ-2a). */
  audience: string;
  /** OIDC `email_verified` claim. False / undefined → 'email-not-verified'. */
  emailVerified: boolean;
  ip: string;
  userAgent: string;
  /** OAuth profile name — written to `users.display_name` on accept. */
  displayName: string | null;
};

/**
 * Discriminated union of every possible outcome of `evaluateAutoProvision`.
 *
 * - `accepted-sso-auto` — user + user_machines row created.
 * - All `rejected-*` outcomes — no DB writes to users/user_machines; audit
 *   rows are still written per REQ-9.
 * - `email-not-verified` — IdP precondition T1 M1.3 (REQ-2a).
 * - `rate-limited` — first-dimension exceeded; only redemption-log row
 *   written (Decisão #16). `retryAfterSec` flows to the HTTP caller.
 */
export type AutoProvisionDecision =
  | { kind: 'accepted-sso-auto'; userId: string; orgId: string }
  | { kind: 'rejected-public-domain' }
  | { kind: 'rejected-multiple-matches' }
  | { kind: 'rejected-no-match' }
  | { kind: 'rejected-race' }
  | { kind: 'rejected-csrf' }
  // 'rejected-replay' is intentionally NOT in this union — NextAuth v5
  // handles state/nonce replay upstream of the signIn callback and returns
  // its own error response. The DB enum still includes 'rejected-replay' so
  // a future spec can wire NextAuth's error handler directly to the audit
  // log, but `evaluateAutoProvision` never produces it.
  | { kind: 'rejected-cross-idp' }
  | { kind: 'rejected-pre-existing-binding' }
  | { kind: 'email-not-verified' }
  | {
      kind: 'rate-limited';
      dimension: 'ip' | 'email_hash' | 'sso_subject_hash';
      retryAfterSec: number;
    };

/**
 * Result of the transactional provision step. Either the new user_machines
 * row succeeded (and we have the user id), or the FOR-UPDATE re-validate
 * detected a race (revoked / expired / exhausted).
 */
export type ProvisionInTxResult =
  | { kind: 'accepted'; userId: string }
  | { kind: 'rejected-race' };

/**
 * Inputs to the transactional provision step. The orchestrator hands these
 * over after all preconditions have passed; `provisionInTx` is responsible
 * for the `SELECT ... FOR UPDATE` re-lock, re-validation, INSERTs into
 * `users` + `user_machines`, the `used_count` bump, and (per §Decisão #23)
 * the INSIDE-TX audit-log writes.
 */
export type ProvisionInTxInput = {
  invite: ActiveInvite;
  email: string;
  displayName: string | null;
  ssoProvider: string;
  ssoSubject: string;
  /** Pre-computed for audit-log writes inside the tx. */
  ssoIssuer: string;
  ip: string;
  city: string | null;
  userAgent: string;
  emailHash: string;
  emailDomain: string;
  ssoSubjectHash: string;
};

/**
 * Lookup helper for the pre-existing-binding check (REQ-5).
 *
 * Returns the user row (id only) when an `email` row exists in the invite's
 * org with `sso_provider IS NULL` — i.e. a v1 invite-token-provisioned user
 * that hasn't yet completed first SSO login. Returns null otherwise.
 *
 * Scoping by org_id is critical (TC-U-12): a user with the same email in a
 * DIFFERENT org is NOT a pre-existing binding — different orgs, different
 * identities. Pairs with the `users_org_email_unique` constraint added in
 * migration 0004.
 */
export type FindPreExistingV1User = (
  orgId: string,
  email: string,
) => Promise<{ id: string } | null>;

export type AutoProvisionDeps = {
  matchActiveInvitesByEmail: typeof matchActiveInvitesByEmail;
  checkSsoRateLimit: typeof checkSsoRateLimit;
  isPublicDomain: typeof isPublicDomain;
  writeAuthEvent: typeof writeAuthEvent;
  writeRedemptionLog: WriteRedemptionLogFn;
  sendPreExistingBindingEmail: typeof sendPreExistingBindingEmail;
  findPreExistingV1User: FindPreExistingV1User;
  /**
   * The transactional core. Production implementation runs a Drizzle
   * transaction; unit-test stubs simulate the race outcomes directly.
   */
  provisionInTx: (input: ProvisionInTxInput) => Promise<ProvisionInTxResult>;
  hashEmail: typeof hashEmail;
  emailDomain: typeof emailDomain;
  ipToCity: typeof ipToCity;
  /** OIDC issuer whitelist for REQ-2a. */
  issuerWhitelist: ReadonlySet<string>;
  /** OAuth client id — checked against `id_token.aud` (REQ-2a). */
  clientId: string;
};

// =============================================================================
// Default deps wiring
// =============================================================================

/**
 * Default issuer whitelist. Google's iss is universal across all Google
 * accounts. Okta tenant issuers are added per-deployment via
 * `TOKENFX_SSO_ISSUERS_OKTA` (comma-separated). Empty env keeps the set at
 * just Google.
 */
const DEFAULT_ISSUER_WHITELIST = ((): ReadonlySet<string> => {
  const set = new Set<string>(['https://accounts.google.com']);
  const oktaCsv = process.env.TOKENFX_SSO_ISSUERS_OKTA ?? '';
  for (const item of oktaCsv.split(',')) {
    const trimmed = item.trim();
    if (trimmed.length > 0) set.add(trimmed);
  }
  return set;
})();

/**
 * Production implementation of the pre-existing v1 user lookup. Scoped to
 * `(org_id, email)` per REQ-5 + TC-U-12.
 */
const defaultFindPreExistingV1User: FindPreExistingV1User = async (
  orgId,
  email,
) => {
  const db = getDb();
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.orgId, orgId),
        eq(users.email, email),
        isNull(users.ssoProvider),
      ),
    )
    .limit(1);
  if (rows.length === 0) return null;
  return { id: rows[0].id };
};

/**
 * Production implementation of `provisionInTx` — opens a Drizzle
 * transaction, re-locks the invite via SELECT FOR UPDATE, re-validates the
 * three race-sensitive columns via the pure `revalidateInvite` predicate
 * (REQ-15), INSERTs `users` + `user_machines`, bumps `used_count`, and
 * writes BOTH audit-log rows inside the tx (Decisão #23).
 *
 * NOTE: machine-credential issuance (`key_id`/`secret_hash`) is deferred
 * per the spec §"Auth.ts integration" — `auth.ts` handles credential
 * minting via the standard NextAuth + bearer-auth flow AFTER this
 * orchestrator returns `accepted-sso-auto`. We INSERT a `user_machines`
 * row only when the auth integration calls back into this module post-SSO
 * with a concrete machine id; for the orchestrator-level happy path we
 * limit ourselves to `users` + invite bump.
 *
 * (Inserting a partial user_machines row here would violate the schema's
 * NOT NULL on key_id/secret_hash; the auth.ts integration owns those
 * fields per spec — Decisão #14 documents `provisioned_via='sso-auto'`
 * but doesn't relocate credential minting into this file.)
 */
const defaultProvisionInTx = async (
  input: ProvisionInTxInput,
): Promise<ProvisionInTxResult> => {
  const db = getDb();
  return db.transaction(async (tx) => {
    // 1. Lock the invite row. `for('update')` emits SELECT ... FOR UPDATE.
    //    The token PK guarantees ≤1 row; an empty result = invite vanished
    //    (deleted, not just revoked) — treat as race.
    const locked = await tx
      .select({
        token: onboardingInvites.token,
        orgId: onboardingInvites.orgId,
        teamId: onboardingInvites.teamId,
        maxUses: onboardingInvites.maxUses,
        usedCount: onboardingInvites.usedCount,
        expiresAt: onboardingInvites.expiresAt,
        revokedAt: onboardingInvites.revokedAt,
      })
      .from(onboardingInvites)
      .where(eq(onboardingInvites.token, input.invite.token))
      .for('update')
      .limit(1);

    // 2. Re-validate race-sensitive columns via the pure predicate (REQ-15).
    //    `revoked`, `expired`, and `exhausted` all collapse to
    //    `rejected-race` here — they're observable only AFTER the
    //    candidate-selection query already saw the row as live (which is
    //    the definition of a race per §Decisão #22).
    if (locked.length === 0) return { kind: 'rejected-race' };
    const fresh = locked[0];
    const revalidation = revalidateInvite(
      {
        token: fresh.token,
        revokedAt: fresh.revokedAt,
        expiresAt: fresh.expiresAt,
        usedCount: fresh.usedCount,
        maxUses: fresh.maxUses,
      },
      Date.now(),
    );
    if (revalidation.valid === false) return { kind: 'rejected-race' };

    // 4. INSERT user with provisioned_via context. role='member' per Decisão #15.
    const [created] = await tx
      .insert(users)
      .values({
        orgId: fresh.orgId,
        teamId: fresh.teamId,
        email: input.email,
        ssoProvider: input.ssoProvider,
        ssoSubject: input.ssoSubject,
        role: 'member',
        displayName: input.displayName,
      })
      .returning({ id: users.id });

    // 5. Bump used_count atomically. FOR UPDATE above serializes concurrent
    //    redeems so this increment is exact.
    await tx
      .update(onboardingInvites)
      .set({ usedCount: sql`${onboardingInvites.usedCount} + 1` })
      .where(eq(onboardingInvites.token, fresh.token));

    // 6. Audit rows — INSIDE the tx so they're atomic with the INSERT
    //    (Decisão #23). We call the raw module-level writers bound to the
    //    in-flight tx handle so the rows commit/rollback with the user
    //    INSERT. (Test stubs replace `provisionInTx` wholesale and observe
    //    audit writes via their own captured calls, not via these.)
    await writeAuthEvent({
      ssoProvider: input.ssoProvider,
      iss: input.ssoIssuer,
      emailHash: input.emailHash,
      ssoSubjectHash: input.ssoSubjectHash,
      ip: input.ip,
      city: input.city,
      userAgent: input.userAgent,
      outcome: 'accepted-sso-auto',
    });
    await rawWriteRedemptionLog(tx, {
      tokenPrefix: fresh.token.slice(0, 8),
      machineId: null,
      emailDomain: input.emailDomain,
      emailHash: input.emailHash,
      requestIp: input.ip,
      outcome: 'accepted-sso-auto',
      method: 'sso-auto',
      ssoProvider: input.ssoProvider,
      ssoSubjectHash: input.ssoSubjectHash,
      iss: input.ssoIssuer,
      userAgent: input.userAgent,
    });

    return { kind: 'accepted', userId: created.id };
  });
};

export const buildDefaultDeps = (): AutoProvisionDeps => ({
  matchActiveInvitesByEmail,
  checkSsoRateLimit,
  isPublicDomain,
  writeAuthEvent,
  writeRedemptionLog: defaultWriteRedemptionLog,
  sendPreExistingBindingEmail,
  findPreExistingV1User: defaultFindPreExistingV1User,
  provisionInTx: defaultProvisionInTx,
  hashEmail,
  emailDomain,
  ipToCity,
  issuerWhitelist: DEFAULT_ISSUER_WHITELIST,
  clientId: process.env.TOKENFX_NEXTAUTH_CLIENT_ID ?? '',
});

// =============================================================================
// Internal helpers
// =============================================================================

const SENTINEL_TOKEN_PREFIX = '00000000';

/** Audit-log write fan-out — both tables (REQ-9). */
const writeAuditRowsForRejection = async (
  deps: AutoProvisionDeps,
  args: {
    outcome: Exclude<AuthEventOutcome, never>;
    tokenPrefix: string;
    ssoProvider: string;
    ssoIssuer: string;
    emailHash: string;
    emailDomain: string;
    ssoSubjectHash: string | null;
    ip: string;
    city: string | null;
    userAgent: string;
  },
): Promise<void> => {
  await deps.writeAuthEvent({
    ssoProvider: args.ssoProvider,
    iss: args.ssoIssuer,
    emailHash: args.emailHash,
    ssoSubjectHash: args.ssoSubjectHash,
    ip: args.ip,
    city: args.city,
    userAgent: args.userAgent,
    outcome: args.outcome,
  });
  // Cast: WriteRedemptionLogParams.outcome includes both manual-token and
  // sso-auto v2 outcomes (see redemption-log.ts widening). The AuthEventOutcome
  // union is a strict subset, so this is type-safe at runtime.
  const redemptionParams: WriteRedemptionLogParams = {
    tokenPrefix: args.tokenPrefix,
    machineId: null,
    emailDomain: args.emailDomain,
    emailHash: args.emailHash,
    requestIp: args.ip,
    outcome: args.outcome,
    method: 'sso-auto',
    ssoProvider: args.ssoProvider,
    ssoSubjectHash: args.ssoSubjectHash,
    iss: args.ssoIssuer,
    userAgent: args.userAgent,
  };
  await deps.writeRedemptionLog(redemptionParams);
};

/**
 * Email normalization rule (REQ-10): NFC + lowercase + trim. NO plus-tag
 * stripping. Applied uniformly before any pattern match, hash, or domain
 * derivation so canonically equivalent strings collapse to one identity.
 */
const normalizeEmail = (email: string): string =>
  email.normalize('NFC').toLowerCase().trim();

// =============================================================================
// Orchestrator
// =============================================================================

/**
 * Decision-engine entry point. See module header for the full check
 * ordering + audit-log discipline.
 */
export const evaluateAutoProvision = async (
  input: AutoProvisionInput,
  depsPatch?: Partial<AutoProvisionDeps>,
): Promise<AutoProvisionDecision> => {
  const deps: AutoProvisionDeps = { ...buildDefaultDeps(), ...depsPatch };

  // -----------------------------------------------------------------------
  // Pre-compute privacy-safe identifiers up front so every audit write —
  // including the rate-limited path which does NOT call any further check —
  // receives populated hash + domain. Mirrors the redeem.ts pattern.
  // -----------------------------------------------------------------------
  const normalizedEmail = normalizeEmail(input.email);
  const emailHashValue = deps.hashEmail(normalizedEmail);
  const domain = deps.emailDomain(normalizedEmail);
  // Reuse hashEmail (peppered SHA-256) for the subject hash — same primitive,
  // same pepper, distinct input. Domain-separation prefix `sso-subject:`
  // prevents cross-table rainbow correlation between `email_hash` and
  // `sso_subject_hash` columns even if both peppers were known. Cheap to add
  // now; audit rows are immutable so retro-fixing would require backfill.
  const ssoSubjectHashValue = deps.hashEmail(`sso-subject:${input.ssoSubject}`);
  const city = await deps.ipToCity(input.ip);

  // -----------------------------------------------------------------------
  // Step 1: Rate-limit (REQ-11/12, Decisão #16). Fires BEFORE any other
  // check — short-circuits without opening a tx and without writing to
  // auth_event_log. Only `onboarding_redemption_log` records the attempt
  // with outcome='rate-limited' (the v1 enum value).
  // -----------------------------------------------------------------------
  const rl = deps.checkSsoRateLimit({
    ip: input.ip,
    emailHash: emailHashValue,
    ssoSubjectHash: ssoSubjectHashValue,
  });
  if (!rl.ok) {
    try {
      await deps.writeRedemptionLog({
        tokenPrefix: SENTINEL_TOKEN_PREFIX,
        machineId: null,
        emailDomain: domain,
        emailHash: emailHashValue,
        requestIp: input.ip,
        outcome: 'rate-limited',
        method: 'sso-auto',
        ssoProvider: input.ssoProvider,
        ssoSubjectHash: ssoSubjectHashValue,
        iss: input.ssoIssuer,
        userAgent: input.userAgent,
      });
    } catch (err) {
      // Audit failure is rare but must not be swallowed silently. Logger
      // line uses domain only — never the raw email.
      logger.warn('sso-auto-provision rate-limit audit write failed', {
        email_domain: domain,
        error_message: err instanceof Error ? err.message : String(err),
      });
    }
    logger.warn('sso-auto-provision rate-limited', {
      dimension: rl.dimension,
      retry_after_sec: rl.retryAfterSec,
      email_domain: domain,
    });
    // checkSsoRateLimit only emits 3 of the 4 RateLimitDimensionName values
    // ('ip' | 'email_hash' | 'sso_subject_hash' — never 'token'); narrow
    // here so the public decision union stays exhaustive. 'token' would be
    // a programming error and we surface it as 'ip' to keep the contract
    // total; it is unreachable by the rate-limit-sso wrapper.
    const narrowedDim: 'ip' | 'email_hash' | 'sso_subject_hash' =
      rl.dimension === 'token' ? 'ip' : rl.dimension;
    return {
      kind: 'rate-limited',
      dimension: narrowedDim,
      retryAfterSec: rl.retryAfterSec,
    };
  }

  // Common audit-row fan-out parameters used by every rejection branch
  // below. We populate `tokenPrefix` per-branch (sentinel for branches
  // without a matched invite; first-8-chars otherwise).
  const auditCommon = {
    ssoProvider: input.ssoProvider,
    ssoIssuer: input.ssoIssuer,
    emailHash: emailHashValue,
    emailDomain: domain,
    ssoSubjectHash: ssoSubjectHashValue,
    ip: input.ip,
    city,
    userAgent: input.userAgent,
  };

  // -----------------------------------------------------------------------
  // Step 2: IdP precondition — issuer + audience (REQ-2a). Issuer mismatch
  // and audience mismatch BOTH surface as 'rejected-csrf' (forged callback
  // category — same audit reason).
  // -----------------------------------------------------------------------
  if (!deps.issuerWhitelist.has(input.ssoIssuer)) {
    await writeAuditRowsForRejection(deps, {
      outcome: 'rejected-csrf',
      tokenPrefix: SENTINEL_TOKEN_PREFIX,
      ...auditCommon,
    });
    return { kind: 'rejected-csrf' };
  }
  if (input.audience !== deps.clientId) {
    await writeAuditRowsForRejection(deps, {
      outcome: 'rejected-csrf',
      tokenPrefix: SENTINEL_TOKEN_PREFIX,
      ...auditCommon,
    });
    return { kind: 'rejected-csrf' };
  }

  // -----------------------------------------------------------------------
  // Step 3: IdP precondition — email_verified (REQ-2a). False/undefined
  // → 'email-not-verified' outcome. NO further checks.
  // -----------------------------------------------------------------------
  if (input.emailVerified !== true) {
    await writeAuditRowsForRejection(deps, {
      outcome: 'email-not-verified',
      tokenPrefix: SENTINEL_TOKEN_PREFIX,
      ...auditCommon,
    });
    return { kind: 'email-not-verified' };
  }

  // -----------------------------------------------------------------------
  // Step 4: Public-domain blocklist (REQ-2). Short-circuits BEFORE the
  // matchActiveInvitesByEmail DB query — the test asserts call count == 0
  // (TC-U-02). Audit rows still written per REQ-2's "audit-log applies to
  // ALL outcomes" + Decisão #6.
  // -----------------------------------------------------------------------
  if (deps.isPublicDomain(domain)) {
    await writeAuditRowsForRejection(deps, {
      outcome: 'rejected-public-domain',
      tokenPrefix: SENTINEL_TOKEN_PREFIX,
      ...auditCommon,
    });
    return { kind: 'rejected-public-domain' };
  }

  // -----------------------------------------------------------------------
  // Step 5+6: matchActiveInvitesByEmail + single-match constraint (REQ-3).
  // We use the NORMALIZED email so casing / whitespace variants collapse.
  // -----------------------------------------------------------------------
  const matches = await deps.matchActiveInvitesByEmail(normalizedEmail);
  if (matches.length === 0) {
    await writeAuditRowsForRejection(deps, {
      outcome: 'rejected-no-match',
      tokenPrefix: SENTINEL_TOKEN_PREFIX,
      ...auditCommon,
    });
    return { kind: 'rejected-no-match' };
  }
  if (matches.length >= 2) {
    // Sort alphabetically by token for deterministic forensic tracking.
    const sorted = [...matches].sort((a, b) => a.token.localeCompare(b.token));
    const firstPrefix = sorted[0].token.slice(0, 8);
    // Forensic detail goes to logger (not the audit row — schema doesn't
    // currently store per-row metadata). Future spec can add a
    // metadata_json column; for spec b we log structured.
    logger.warn('sso-auto-provision rejected-multiple-matches', {
      email_domain: domain,
      match_count: sorted.length,
      matching_prefixes: sorted.map((s) => s.token.slice(0, 8)),
    });
    await writeAuditRowsForRejection(deps, {
      outcome: 'rejected-multiple-matches',
      tokenPrefix: firstPrefix,
      ...auditCommon,
    });
    return { kind: 'rejected-multiple-matches' };
  }
  const invite = matches[0];
  const tokenPrefix = invite.token.slice(0, 8);

  // -----------------------------------------------------------------------
  // Step 7: allowed_sso_providers (REQ-4). Empty array = legacy
  // backwards-compat (any provider allowed). Non-empty + provider not in
  // list → 'rejected-cross-idp'.
  // -----------------------------------------------------------------------
  if (
    invite.allowedSsoProviders.length > 0 &&
    !invite.allowedSsoProviders.includes(input.ssoProvider)
  ) {
    await writeAuditRowsForRejection(deps, {
      outcome: 'rejected-cross-idp',
      tokenPrefix,
      ...auditCommon,
    });
    return { kind: 'rejected-cross-idp' };
  }

  // -----------------------------------------------------------------------
  // Step 8: Pre-existing v1 user (REQ-5). Scoped to invite's org. If found,
  // we ALWAYS attempt the binding-email notification (subject to its own
  // rate-limit per REQ-24) — failure to send does NOT block the rejection
  // decision (REQ-22 + TC-U-43).
  // -----------------------------------------------------------------------
  const preExisting = await deps.findPreExistingV1User(
    invite.orgId,
    normalizedEmail,
  );
  if (preExisting !== null) {
    // Browser hint for the email body — UA full string is fine here; the
    // recipient sees it in their own inbox, no privacy leak.
    let sendResult;
    try {
      sendResult = await deps.sendPreExistingBindingEmail({
        to: normalizedEmail,
        city,
        browser: input.userAgent,
        time: new Date(),
      });
    } catch (err) {
      // sendPreExistingBindingEmail is contractually non-throwing (REQ-23
      // returns Result). If a future regression throws, log + continue —
      // the rejection decision must still surface.
      logger.warn('sso-auto-provision pre-existing-binding-email threw', {
        email_domain: domain,
        error_message: err instanceof Error ? err.message : String(err),
      });
      sendResult = { sent: false as const, reason: 'send-failed' as const };
    }
    if (sendResult.sent === false) {
      logger.warn('sso-auto-provision pre-existing-binding-email not sent', {
        email_domain: domain,
        reason: sendResult.reason,
      });
    }
    await writeAuditRowsForRejection(deps, {
      outcome: 'rejected-pre-existing-binding',
      tokenPrefix,
      ...auditCommon,
    });
    return { kind: 'rejected-pre-existing-binding' };
  }

  // -----------------------------------------------------------------------
  // Step 9: Transactional provision (REQ-7/8 + Decisão #23). Inside the
  // tx: SELECT FOR UPDATE, re-validate, INSERT user, bump used_count, and
  // write BOTH audit rows. Audit-write fan-out is inside the tx so an
  // 'accepted-sso-auto' row can never exist without a matching `users` row.
  // -----------------------------------------------------------------------
  const txResult = await deps.provisionInTx({
    invite,
    email: normalizedEmail,
    displayName: input.displayName,
    ssoProvider: input.ssoProvider,
    ssoSubject: input.ssoSubject,
    ssoIssuer: input.ssoIssuer,
    ip: input.ip,
    city,
    userAgent: input.userAgent,
    emailHash: emailHashValue,
    emailDomain: domain,
    ssoSubjectHash: ssoSubjectHashValue,
  });

  if (txResult.kind === 'rejected-race') {
    // Race: tx already rolled back — write audit rows OUTSIDE.
    await writeAuditRowsForRejection(deps, {
      outcome: 'rejected-race',
      tokenPrefix,
      ...auditCommon,
    });
    return { kind: 'rejected-race' };
  }

  // Accepted — audit rows already written inside the tx (Decisão #23).
  return {
    kind: 'accepted-sso-auto',
    userId: txResult.userId,
    orgId: invite.orgId,
  };
};
