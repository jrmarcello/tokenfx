/**
 * auth-required: env-flag gate + localhost-host helper + demo session
 * for the initial-release localhost-only open-access mode.
 *
 * See `.specs/auth-optional-mode-and-sso-bugfixes.md` for the full design
 * + threat model. Summary:
 *
 *   - `isAuthRequired(env)` returns false ONLY when env.AUTH_REQUIRED is
 *     the literal string 'false'. Anything else (unset, '', '0', 'False',
 *     'false ', undefined) keeps auth on. Fail-safe by design.
 *
 *   - When localhost mode is on, the middleware also enforces a per-
 *     request `Host` header check via `isLocalhostHost(...)` — only
 *     requests addressed to localhost/127.0.0.1/[::1] are served. Real
 *     enforcement of the "localhost-only" promise.
 *
 *   - `buildLocalDevSession()` is the synthetic session injected by the
 *     `auth()` shim in `auth.ts` when localhost mode is on. All code that
 *     reads `auth.user.{role,orgId}` sees admin + `LOCAL_ORG_ID`. The
 *     `org_id` filter at the query layer stays active — only the
 *     JWT-sourced identity is replaced.
 *
 * Edge-runtime safe: no DB, no Node-only modules.
 */

/**
 * Fixed UUID for the auto-seeded `local-org` row.
 * Migration `0006_local_org_seed.sql` inserts a row with this id. The
 * value is referenced by `buildLocalDevSession()` so every query scoped
 * on `auth.user.orgId` in localhost mode resolves to this org.
 *
 * Stable across environments; safe to commit. NOT a secret.
 */
export const LOCAL_ORG_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Fixed UUID for the auto-seeded synthetic local user.
 * Migration `0008_local_user_seed.sql` inserts a `users` row with this id,
 * `org_id = LOCAL_ORG_ID`, and `role = 'admin'`. `buildLocalDevSession()`
 * uses it as `user.id` so that every query binding `session.user.id`
 * against a `uuid` column (e.g. `/manager`, `/me/visibility`,
 * `/manager/health`) resolves to a real, valid UUID instead of a bare
 * non-UUID string — which Postgres rejects with
 * `invalid input syntax for type uuid`, producing HTTP 500. The seeded row
 * also makes FK-dependent writes (manager alert acks, drilldown audit)
 * succeed for the local admin.
 *
 * Sequential to `LOCAL_ORG_ID` (`...0001`). Stable across environments;
 * safe to commit. NOT a secret.
 */
export const LOCAL_USER_ID = '00000000-0000-0000-0000-000000000002';

/**
 * Returns true when SSO middleware should enforce auth, false when
 * localhost-only open-access mode is active.
 *
 * Polarity is intentionally narrow: only the literal string 'false'
 * disables auth. Any other value — including 'False', '0', '', or
 * 'false ' (trailing whitespace) — keeps auth on. The implication: a
 * misconfigured `.env` cannot accidentally disable auth via typo. The
 * user has to explicitly set the value to the exact string `false`.
 */
/**
 * Subset of `process.env` that `isAuthRequired` inspects. Kept as a
 * record so `process.env` (which has its own augmented `ProcessEnv`
 * interface with required fields) AND hand-built test fixtures both
 * satisfy it.
 */
export type AuthRequiredEnv = Record<string, string | undefined>;

export const isAuthRequired = (env: AuthRequiredEnv): boolean =>
  env.AUTH_REQUIRED !== 'false';

const LOCALHOST_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
]);

/**
 * Accepts an HTTP `Host` header value (`<host>` or `<host>:<port>`) and
 * returns true iff the host portion is in the localhost allow-list.
 *
 * Strict allow-list (not prefix/suffix matching) to defeat
 * `localhost.evil.com`, `127.0.0.1.attacker.example`, etc.
 *
 * Fail-closed on null/missing header: returns false.
 *
 * Only the raw `Host` header is meaningful to this guard.
 * `X-Forwarded-Host` is NOT honored — callers MUST pass the raw value.
 */
export const isLocalhostHost = (hostHeader: string | null): boolean => {
  if (!hostHeader) return false;
  // Strip `:port` suffix (port is irrelevant to host identity).
  // Note: IPv6 hosts use `[::1]:port` form; the `:port` regex still
  // matches the trailing port without touching the bracketed body.
  const host = hostHeader.replace(/:\d+$/, '');
  return LOCALHOST_HOSTS.has(host);
};

/**
 * The synthetic session injected by `auth()` when localhost mode is on.
 *
 * Shape matches NextAuth's `Session` type (with `expires` ISO string)
 * so existing consumers of `auth()` work unchanged.
 *
 * Returns `{role: 'admin'}` so every dashboard route renders for the
 * single local user. `orgId` points at `LOCAL_ORG_ID` so query-layer
 * org scoping continues to function (queries that filter by
 * `auth.user.orgId` will see only rows for the seeded local org).
 */
export const buildLocalDevSession = () => ({
  user: {
    id: LOCAL_USER_ID,
    email: 'dev@localhost',
    role: 'admin' as const,
    orgId: LOCAL_ORG_ID,
  },
  expires: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
});
