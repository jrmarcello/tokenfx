/**
 * Pure helpers extracted from `auth.ts` so unit tests can exercise them
 * without dragging NextAuth (and its transitive `next/server` import
 * graph) into the Vitest module graph.
 *
 * Spec: `.specs/review-report-2026-05-14-fixes.md` TASK-AUTH-HARDENING.
 *
 *   - `extractIssuer` — H3 (REQ-7 cap @ 512 chars, REQ-8 happy + edges).
 *   - `extractEmailVerified` — sibling helper kept here for symmetry;
 *     behavior unchanged from the in-file version.
 *   - `createInvalidCheckHandler` — factory for the NextAuth
 *     `logger.error` hook (C-1 / REQ-10). Lets `auth.ts` inject the
 *     real `writeReplayAuditRow`/`ipToCity`/`getRequestContext` deps and
 *     tests pass hand-written stubs.
 *   - `signInDefaultVerdict` — pure mirror of the `signIn` callback's
 *     `switch (decision.kind)` exhaustiveness guard (C-3 / REQ-12). The
 *     `const _exhaustive: never = decision` line is the single source
 *     of truth for tsc enforcement; production code in `auth.ts`
 *     repeats the same default-arm wording but for runtime side effects
 *     (logger.warn) we cannot exercise purely from a test.
 *
 * NO `next-auth` import here. NO Postgres / Drizzle import either.
 * Everything is pure-function-of-input + injected dependencies.
 */
import type {
  WriteReplayAuditRowInput,
  WriteReplayAuditRowOpts,
} from './auth-event-log-writer';
import type { SignInDecision } from './load-user';
import { isStateReplayAuthError } from './replay-detector';
import { log as logger } from '@tokenfx/shared/logger';

/**
 * REQ-7 (H3): cap on the `iss` claim length before it flows into
 * `auth_event_log.iss`. A megabyte-long issuer from a malicious /
 * misconfigured provider would otherwise be persisted verbatim. The
 * cap is generous (realistic OIDC issuer URLs are <100 chars per
 * RFC 8414 implementations) and bounds the audit row size.
 */
export const ISS_MAX_LEN = 512;

/**
 * SECURITY note: this helper extracts the `iss` claim from a JWT WITHOUT
 * verifying the token signature. That is intentional — NextAuth v5
 * signature-verifies the `id_token` upstream of the signIn callback (against
 * the provider's JWKS) before this code path runs. If a future regression in
 * NextAuth or a custom provider misconfiguration bypasses upstream
 * verification, an attacker could forge any `iss`. Defense-in-depth: the
 * orchestrator's whitelist check (`evaluateAutoProvision` step 2) rejects
 * unknown issuers, but it trusts the claim as authentic — so the security
 * boundary is "NextAuth verified the token". Treat this helper purely as a
 * claim-extraction utility, never as an authentication primitive.
 *
 * Extract the OIDC `iss` claim from a NextAuth Account.
 *
 * NextAuth v5's `Account` shape varies per provider. For OAuth/OIDC providers,
 * the issuer can land in two places:
 *   1. `account.id_token` — a JWT whose middle segment is base64-url-encoded
 *      JSON. We decode and read `iss` from the claims.
 *   2. `account.iss` — NextAuth sometimes surfaces it directly (provider-
 *      dependent).
 *
 * Returns empty string when neither is present. The downstream decision
 * engine treats empty/unknown issuers as 'rejected-csrf' via the whitelist
 * check.
 *
 * REQ-7 (H3): the returned string is capped at {@link ISS_MAX_LEN}
 * characters in BOTH code paths (direct and JWT-decoded). Edge cases
 * (`iss` missing / array / non-string / malformed JWT) return `''` —
 * the whitelist check downstream rejects empty issuers.
 */
export const extractIssuer = (account: Record<string, unknown> | null): string => {
  if (!account) return '';
  const direct = account.iss;
  if (typeof direct === 'string' && direct.length > 0) {
    return direct.slice(0, ISS_MAX_LEN);
  }
  const idToken = account.id_token;
  if (typeof idToken !== 'string') return '';
  // Defense-in-depth (post-self-review): cap id_token size BEFORE the
  // base64 decode + JSON.parse on the request hot path. NextAuth verifies
  // the signature upstream so this only kicks in if a regression or custom
  // provider hands us an oversized token. 16 KiB comfortably accommodates
  // real-world OIDC id_tokens (Okta ≤ 8 KB, Google ≤ 4 KB) while bounding
  // the worst-case CPU/memory cost of the decode + parse.
  if (idToken.length > 16 * 1024) return '';
  const segments = idToken.split('.');
  if (segments.length < 2) return '';
  // Same bound applied to the payload segment specifically — defends against
  // a single-segment JWT with the payload bytes overgrown.
  if (segments[1].length > 16 * 1024) return '';
  try {
    // Base64url → JSON. Node's Buffer handles the url-safe alphabet via
    // `from(..., 'base64url')`.
    const payloadJson = Buffer.from(segments[1], 'base64url').toString('utf-8');
    const payload = JSON.parse(payloadJson) as { iss?: unknown };
    if (typeof payload.iss === 'string') return payload.iss.slice(0, ISS_MAX_LEN);
  } catch {
    // Malformed id_token: treat as missing — caller's whitelist check will
    // reject. Operators may want a forensic signal if this fires in bulk
    // (e.g. misconfigured IdP rolling out); log structural info only —
    // NEVER the raw token bytes (privacy + .claude/rules/security.md).
    logger.warn('extractIssuer: malformed id_token payload (skipped)');
  }
  return '';
};

/**
 * SECURITY note (mirrors `extractIssuer` above): this helper extracts
 * the `aud` claim from a JWT WITHOUT verifying the token signature.
 * Intentional — NextAuth v5 signature-verifies the `id_token` upstream
 * of `signIn` (against the provider's JWKS) before this code path runs.
 * If a future regression bypasses upstream verification, an attacker
 * could forge any `aud`. Defense-in-depth: the orchestrator's
 * `audience !== clientId` check (`sso-auto-provision.ts:589-596`) only
 * GRANTS access on exact match — a forged audience can only cause
 * `rejected-csrf` (a DENY), never an unauthorized accept. Treat this
 * helper purely as a claim-extraction utility, never as an
 * authentication primitive.
 *
 * Extract the OIDC `aud` claim from a NextAuth Account.
 *
 * Mirrors `extractIssuer` — NextAuth v5's `Account` type does NOT expose
 * `audience` as a top-level field for OIDC providers (verified against
 * `@auth/core@0.37.2`). The audience lives inside the id_token claims.
 *
 * Returns the FIRST element when `aud` is an array (a valid OIDC shape
 * per RFC 7519 §4.1.3). Returns empty string when neither path resolves.
 * The downstream decision engine treats empty audience as `rejected-csrf`
 * via the `audience !== clientId` check.
 *
 * Spec: `.specs/fix-sso-e2e-remaining-5.md` TASK-3. Before this helper
 * existed, the in-`auth.ts` extraction probed `account.audience` directly
 * — always undefined → `''` → every Okta callback rejected as `rejected-csrf`.
 */
export const extractAudience = (account: Record<string, unknown> | null): string => {
  if (!account) return '';
  // Direct probe — for providers that DO surface aud directly (rare but
  // contractually permitted). Truncated like iss for symmetry / DoS bound.
  const direct = account.aud;
  if (typeof direct === 'string' && direct.length > 0) {
    return direct.slice(0, ISS_MAX_LEN);
  }
  const idToken = account.id_token;
  if (typeof idToken !== 'string') return '';
  if (idToken.length > 16 * 1024) return '';
  const segments = idToken.split('.');
  if (segments.length < 2) return '';
  if (segments[1].length > 16 * 1024) return '';
  try {
    const payloadJson = Buffer.from(segments[1], 'base64url').toString('utf-8');
    const payload = JSON.parse(payloadJson) as { aud?: unknown };
    const claim = payload.aud;
    if (typeof claim === 'string') return claim.slice(0, ISS_MAX_LEN);
    // RFC 7519 §4.1.3: aud MAY be an array. Pick the first string element.
    if (Array.isArray(claim)) {
      for (const v of claim) {
        if (typeof v === 'string' && v.length > 0) return v.slice(0, ISS_MAX_LEN);
      }
    }
  } catch {
    logger.warn('extractAudience: malformed id_token payload (skipped)');
  }
  return '';
};

/**
 * Extract `email_verified` from a NextAuth Account/User pair.
 *
 * Mirrors `extractIssuer` — checks `account.id_token` claims first, falls
 * back to a top-level `email_verified` on either object. Default is `false`
 * (security default — unverified email never auto-provisions per REQ-2a).
 */
export const extractEmailVerified = (
  account: Record<string, unknown> | null,
  user: Record<string, unknown> | null,
): boolean => {
  if (account) {
    const direct = account.email_verified;
    if (typeof direct === 'boolean') return direct;
    const idToken = account.id_token;
    if (typeof idToken === 'string') {
      const segments = idToken.split('.');
      if (segments.length >= 2) {
        try {
          const payloadJson = Buffer.from(segments[1], 'base64url').toString(
            'utf-8',
          );
          const payload = JSON.parse(payloadJson) as {
            email_verified?: unknown;
          };
          if (typeof payload.email_verified === 'boolean') {
            return payload.email_verified;
          }
        } catch {
          // ignore malformed token; fall through to default
        }
      }
    }
  }
  if (user) {
    const fromUser = user.email_verified;
    if (typeof fromUser === 'boolean') return fromUser;
  }
  return false;
};

/**
 * Dependencies of the InvalidCheck handler. Production wires the real
 * `writeReplayAuditRow` / `ipToCity` / `getRequestContext`; tests inject
 * hand-written stubs to assert call shape without touching Postgres /
 * GeoIP.
 */
export type InvalidCheckHandlerDeps = Readonly<{
  writer: (
    input: WriteReplayAuditRowInput,
    opts?: WriteReplayAuditRowOpts,
  ) => Promise<void>;
  ipToCity: (ip: string) => Promise<string | null>;
  getRequestContext: () => { ip: string; userAgent: string };
}>;

/**
 * Factory for the NextAuth `logger.error` hook used by the replay-audit
 * spec (REQ-FU-1 of oauth-idp-stub + spec-b TC-I-34).
 *
 * Auth.js v5 throws `InvalidCheck` when the OAuth state/PKCE/nonce
 * cookie cannot be matched. `isStateReplayAuthError` narrows on the
 * static `type = 'InvalidCheck'` field — that is the precise signal.
 * All other AuthError shapes return early without touching the writer.
 *
 * Failure safety: any error from the writer / GeoIP call is logged at
 * warn level and swallowed — never re-thrown. Throwing here would
 * replace Auth.js's redirect-to-error-page with a 500, hiding the
 * original cause from the user.
 */
export const createInvalidCheckHandler = (
  deps: InvalidCheckHandlerDeps,
) => async (error: unknown): Promise<void> => {
  if (!isStateReplayAuthError(error)) return;
  try {
    const ctx = deps.getRequestContext();
    const ip = ctx.ip || null;
    const userAgent = ctx.userAgent || null;
    const city = ip ? await deps.ipToCity(ip) : null;
    await deps.writer({
      ssoProvider: 'unknown',
      ip,
      city,
      userAgent,
    });
  } catch (err) {
    logger.warn('auth: writeReplayAuditRow failed', {
      error_message: err instanceof Error ? err.message : String(err),
    });
  }
};

/**
 * Pure mirror of the `signIn` callback's `switch (decision.kind)`
 * exhaustiveness guard (C-3 / REQ-12).
 *
 * The production switch in `auth.ts` has side effects (DB writes,
 * `logger.warn` calls) that cannot be exercised purely. This helper
 * captures only the exhaustiveness contract:
 *
 *   - All 5 current variants map to a stable boolean verdict
 *     (`allow|fill-sso|bootstrap` → true; `reject-mismatch|
 *     ambiguous-multi-org` → false).
 *   - Any future variant will break tsc here via `const _exhaustive:
 *     never = decision`, mirroring the production guard.
 *   - At runtime, the default arm returns `false` (silent reject)
 *     rather than throwing — same rationale as in `auth.ts`.
 *
 * Tests cast an `{ kind: 'unknown-future-variant' }` shape to
 * `SignInDecision` to verify the default-arm runtime contract.
 */
export const signInDefaultVerdict = (decision: SignInDecision): boolean => {
  switch (decision.kind) {
    case 'allow':
      return true;
    case 'fill-sso':
      return true;
    case 'reject-mismatch':
      return false;
    case 'ambiguous-multi-org':
      return false;
    case 'bootstrap':
      return true;
    default: {
      const _exhaustive: never = decision;
      void _exhaustive;
      return false;
    }
  }
};
