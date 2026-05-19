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
/**
 * Match the openid-client v6 `OperationProcessingError` codes that
 * correspond to state / nonce / PKCE check failures. Auth.js v5 wraps
 * these inside `CallbackRouteError`, so the predicate below walks the
 * cause chain (including the `.err` field that Auth.js uses to attach
 * the underlying openid-client error).
 *
 * Message shapes observed in TASK-4 diagnostic dumps against openid-client
 * v6 source (`src/lib/oauth/process_response.ts`) and the JWT-nonce
 * validation path:
 *   - `unexpected "state" response parameter value` — state mismatch
 *   - `unexpected "nonce" response parameter value` — nonce mismatch
 *   - `missing "state" response parameter` / `missing "nonce" ...` — missing
 *   - JWT `"nonce"` claim mismatch (validated path variations)
 *   - `state value could not be parsed` — Auth.js v4-style state-parse failure
 *
 * False-positive guard: the regex REQUIRES the parameter name to appear
 * between literal double quotes (`"state"` / `"nonce"` / `"code_verifier"`
 * / `"PKCE"`). Generic `OperationProcessingError` messages like
 * `unexpected response status 500` lack the quoted parameter and do NOT
 * match (verified by negative test cases in replay-detector.test.ts).
 * The `.*` separator between verb and quoted parameter is intentional —
 * it accommodates message variants like `JWT "nonce" claim mismatch`
 * where extra context sits between the verb and the parameter.
 */
const REPLAY_MESSAGE_RE = /(unexpected|missing).*"(state|nonce|code_verifier|PKCE)"|state value could not be parsed|nonce.*mismatch|invalid (state|nonce|PKCE)/i;

const matchesReplay = (err: unknown): boolean => {
  if (err === null || typeof err !== 'object') return false;
  const e = err as { type?: unknown; name?: unknown; message?: unknown };
  // Legacy direct InvalidCheck (Auth.js's own typed error, kept for
  // forward compatibility in case future versions stop wrapping).
  if (e.type === 'InvalidCheck') return true;
  // openid-client v6's OperationProcessingError carries the actual
  // state/nonce/PKCE diagnostics via its `message` field.
  if (e.name === 'OperationProcessingError' && typeof e.message === 'string') {
    return REPLAY_MESSAGE_RE.test(e.message);
  }
  return false;
};

export const isStateReplayAuthError = (err: unknown): boolean => {
  // fix-sso-e2e-remaining-5 TASK-4: Auth.js v5 + openid-client v6 wraps
  // the underlying state/nonce/PKCE failure inside a chain:
  //   CallbackRouteError → { err, expected, parameters, provider } → OperationProcessingError
  // We walk both `.cause` AND `.err` so any of the wrappers surfaces
  // the replay-detection signal. Bounded recursion (depth 8) defends
  // against pathological cycles.
  let cursor: unknown = err;
  let depth = 8;
  while (cursor && typeof cursor === 'object' && depth > 0) {
    if (matchesReplay(cursor)) return true;
    const e = cursor as { cause?: unknown; err?: unknown };
    const next = e.cause ?? e.err;
    if (next === cursor) break;
    cursor = next;
    depth -= 1;
  }
  return false;
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
