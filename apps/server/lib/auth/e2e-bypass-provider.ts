/**
 * TASK-1 spike findings — `.specs/fix-e2e-auth-bypass.md`
 *
 * (a) Browser reproduction of `ERR_TOO_MANY_REDIRECTS`: DEFERRED — Docker
 * daemon not running locally at spike time, so the Postgres testcontainer
 * + dev-server combo required by `pnpm test:e2e` couldn't be brought up.
 * The redirect loop is well-documented in `.specs/manager-dashboard-v2.md`
 * + `.specs/manager-dashboard-v3-outcomes.md` (Fase 4 + 5 known issue).
 * The chosen design eliminates BOTH suspected causes simultaneously:
 *
 *   - JWE format drift in NextAuth v5 beta.25 (hand-crafted `encode()`
 *     produces a token the server-side decoder may reject silently).
 *   - `jwt()` callback in `auth.ts:166-191` clearing claims when the
 *     minted email doesn't match a DB row (anti-forge hardening).
 *
 * Going through the canonical Credentials pipeline:
 *   (1) the cookie is encoded by NextAuth itself → format always correct;
 *   (2) `authorize()` returns a user shape that NextAuth's signIn → jwt
 *       → session callbacks accept by definition, and the seeded DB user
 *       hydrates claims naturally.
 *
 * So bug reproduction is informational, not gating. TC-I-04 (real HTTP
 * round-trip against testcontainer Postgres + dev server) is the binding
 * test — if it passes, the redirect loop is fixed by construction.
 *
 * (b) NextAuth v5 beta.25 form contract for `/api/auth/callback/credentials`,
 *     verified via Context7 (`/nextauthjs/next-auth`):
 *
 *   - Body: `application/x-www-form-urlencoded`
 *   - Required fields: `csrfToken`, `callbackUrl`, plus the credentials
 *     fields declared in `Credentials({ credentials: { email: {...} } })`
 *   - CSRF is MANDATORY (`validateCSRF` runs unconditionally in
 *     `packages/core/src/lib/index.ts` for the `callback` action when
 *     provider type is `credentials`).
 *   - Double-submit: the `authjs.csrf-token` cookie set by GET
 *     `/api/auth/csrf` MUST accompany the POST. Playwright's
 *     `context.request` carries cookies across the chain automatically.
 *   - JSON response: send `Accept: application/json` so NextAuth returns
 *     a JSON body with `url` (callback target) instead of issuing an
 *     HTTP 302. The session cookie `authjs.session-token` lands via
 *     `Set-Cookie` in the response headers either way.
 *
 * (c) Implementation note (from RED phase): NextAuth's exported
 *     `Credentials()` is a type-config helper, not a runtime wrapper —
 *     it stuffs the user's config (including `authorize`) into
 *     `provider.options` and the NextAuth init pipeline merges that
 *     into the live provider. Calling `provider.authorize` directly in a
 *     test hits the default `() => null` stub, NOT our function. So we
 *     export `createAuthorize(loadUser)` standalone for unit tests and
 *     wrap it inside `buildE2eBypassProvider` for production wiring.
 */
import Credentials from 'next-auth/providers/credentials';
import { z } from 'zod';
import {
  loadUserByEmail as defaultLoadUserByEmail,
  type LoadedUser,
} from './load-user';

export type LoadUserFn = (email: string) => Promise<LoadedUser | null>;

export type AuthorizedUser = {
  id: string;
  email: string;
  role: LoadedUser['role'];
  orgId: string;
};

const emailSchema = z.string().email().min(1).max(254);

const HOST_RE = /^localhost(:\d{1,5})?$/;

export const isLocalhostHost = (host: string | null | undefined): boolean => {
  if (typeof host !== 'string' || host.length === 0) return false;
  return HOST_RE.test(host);
};

// Allow-list approach (per security review H1): only `test` and `development`
// permit the bypass. Anything else — including `production`, `prod`, unset, or
// an empty string — counts as production-like and rejects the flag.
const isDevOrTest = (env: NodeJS.ProcessEnv): boolean =>
  env.NODE_ENV === 'test' || env.NODE_ENV === 'development';

const isAuthorizeOn = (env: NodeJS.ProcessEnv): boolean =>
  env.E2E_AUTH_BYPASS === '1' && isDevOrTest(env);

/**
 * Module-scope boot guard, factored out so `auth.ts` can invoke it (where
 * the canonical fail-fast lives, mirroring the `AUTH_SECRET` pattern at
 * `auth.ts:18-26`) AND the unit test can exercise the throw path without
 * importing the full NextAuth/Drizzle module graph.
 *
 * Polarity: refuses to boot whenever `E2E_AUTH_BYPASS='1'` is paired with
 * anything other than `NODE_ENV=test` or `NODE_ENV=development`. Drift
 * cases like `NODE_ENV=prod`, `production-staging`, unset, or `""` all
 * trigger the throw (security review H1).
 */
export const assertNotProductionWithBypass = (
  env: NodeJS.ProcessEnv = process.env,
): void => {
  if (env.E2E_AUTH_BYPASS === '1' && !isDevOrTest(env)) {
    throw new Error(
      'E2E_AUTH_BYPASS must be unset outside development/test. Refusing to boot.',
    );
  }
};

/**
 * Standalone authorize implementation — extracted from the Credentials()
 * config so unit tests can call it directly. See spike finding (c) above
 * for why the indirection is necessary.
 */
export const createAuthorize =
  (loadUser: LoadUserFn) =>
  async (
    credentials: Partial<Record<string, unknown>>,
    request: Request,
  ): Promise<AuthorizedUser | null> => {
    const host = request?.headers?.get('host') ?? null;
    if (!isLocalhostHost(host)) return null;

    const rawEmail =
      typeof credentials?.email === 'string' ? credentials.email : '';
    const parsed = emailSchema.safeParse(rawEmail);
    if (!parsed.success) return null;

    let user;
    try {
      user = await loadUser(parsed.data);
    } catch (e) {
      // Wrap the DB error so callers (NextAuth's signIn handler) get a
      // stable error type with the raw cause attached. Avoids leaking raw
      // driver messages through the credentials callback response.
      throw new Error('e2e-bypass authorize: loadUser failed', { cause: e });
    }
    if (!user) return null;

    return {
      id: user.userId,
      email: parsed.data,
      role: user.role,
      orgId: user.orgId,
    };
  };

export const buildE2eBypassProvider = (
  env: NodeJS.ProcessEnv = process.env,
  loadUser: LoadUserFn = defaultLoadUserByEmail,
) => {
  if (!isAuthorizeOn(env)) return null;
  return Credentials({
    id: 'credentials',
    name: 'e2e-bypass',
    credentials: { email: { label: 'Email', type: 'text' } },
    authorize: createAuthorize(loadUser),
  });
};
