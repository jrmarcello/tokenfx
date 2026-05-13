/**
 * Pure helpers + sentinel constants for the SSO replay-audit-row spec.
 *
 * Closes REQ-FU-1 of `.specs/oauth-idp-stub.md` (and the audit-row half
 * of spec-b TC-I-34): when NextAuth rejects an OAuth callback with a
 * reused state cookie, the `logger.error` callback in `auth.ts` calls
 * `writeReplayAuditRow` (see `auth-event-log-writer.ts`) so the
 * `auth_event_log` table records `outcome='rejected-replay'`.
 *
 * TASK-0 (live spike) findings, summarised:
 *   - State-replay throws `InvalidCheck` (Auth.js v5 `@auth/core` —
 *     `src/lib/actions/callback/oauth/checks.ts`). The class has a
 *     static `type = 'InvalidCheck'` field.
 *   - `InvalidCheck` is NOT in Auth.js's `clientErrors` set, so the
 *     redirect URL surfaces `?error=Configuration` (collides with real
 *     config errors — DO NOT detect at the URL layer).
 *   - The `logger.error` callback receives the raw `AuthError`
 *     instance, including the `type` field. This is the precise hook.
 */

/**
 * Sentinel `email_hash` value for replay-audit rows.
 *
 * The column is `NOT NULL` and normally holds a 64-char lowercase-hex
 * peppered SHA-256. The literal `replay:` prefix is non-hex, so this
 * sentinel can NEVER collide with a real email hash — verified by
 * `replay-detector.test.ts`. Consumers that join `auth_event_log` on
 * `email_hash` (e.g. `loadAuditLogPage` via `inArray(...hashesForOrg)`)
 * will never match a sentinel row — by design (REQ-7 of the spec).
 */
export const REPLAY_EMAIL_HASH_SENTINEL = 'replay:state-mismatch' as const;

/**
 * Sentinel `iss` value for replay-audit rows. Same rationale as
 * {@link REPLAY_EMAIL_HASH_SENTINEL}. NEVER derived from the request
 * (the Referer header could leak the consumed `state` token).
 */
export const REPLAY_ISS_SENTINEL = 'replay:unknown-issuer' as const;

/**
 * Strict regex for the NextAuth OAuth callback path:
 *   /api/auth/callback/<provider>
 * Captures the provider id. Lowercase + hyphens only — `[a-z-]+`
 * rejects uppercase, digits, dots, slashes, traversal segments.
 */
const CALLBACK_PATH_RE = /^\/api\/auth\/callback\/([a-z-]+)$/;

/**
 * Type-narrow predicate: was this error thrown by Auth.js as a
 * state/PKCE/nonce check failure?
 *
 * Auth.js's `AuthError` subclasses set a static `type` string; the
 * `InvalidCheck` class uses `type = 'InvalidCheck'` (verified in
 * `@auth/core@0.37.2/src/errors.ts:228`). Matching on `type` (instead
 * of `instanceof InvalidCheck`) avoids importing from `@auth/core`
 * internals — public surface is more stable than the class identity.
 */
export const isStateReplayAuthError = (
  err: unknown,
): err is { type: 'InvalidCheck' } => {
  if (err === null || typeof err !== 'object') return false;
  const type = (err as { type?: unknown }).type;
  return type === 'InvalidCheck';
};

/**
 * Pure helper: extract the provider id from a NextAuth callback path.
 *
 * Used by the replay-audit writer to populate the row's
 * `sso_provider` column. Returns `'unknown'` for any input that does
 * not match the strict callback-path regex.
 */
export const deriveSsoProviderFromCallbackPath = (
  path: string | null | undefined,
): string => {
  if (!path) return 'unknown';
  const m = CALLBACK_PATH_RE.exec(path);
  return m?.[1] ?? 'unknown';
};
