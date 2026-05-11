/**
 * `signInAs` — canonical E2E auth helper for `apps/server` Playwright specs.
 *
 * Replaces the 7 hand-crafted `signInAs(context, user)` copies that minted a
 * NextAuth JWE cookie via `encode({ secret, salt })` and reliably triggered
 * `ERR_TOO_MANY_REDIRECTS` in the v3 outcomes + v2 effectiveness suites.
 * See `.specs/fix-e2e-auth-bypass.md` for the full design.
 *
 * The helper drives the canonical NextAuth Credentials flow against the
 * test-only `e2e-bypass` provider registered by `lib/auth/e2e-bypass-provider.ts`
 * when `E2E_AUTH_BYPASS=1` is set in the dev server's env:
 *
 *   1. GET  /api/auth/csrf       → captures the `authjs.csrf-token` cookie
 *                                   + the csrfToken JSON field.
 *   2. POST /api/auth/callback/credentials
 *      with `application/x-www-form-urlencoded` body, the csrf cookie
 *      attached, `Accept: application/json` so NextAuth returns JSON instead
 *      of a 302, and `redirect=false` so it skips the final navigation step.
 *   3. Parses `Set-Cookie: authjs.session-token=...` from the POST response
 *      and injects it into the Playwright `BrowserContext` via `addCookies`.
 *
 * The helper is localhost-only (REQ-7). Tests inject a `fetch` stub to drive
 * the failure-mode TCs (TC-U-25..28) without standing up a real dev server.
 */

/**
 * Minimal contract the helper needs from a Playwright `BrowserContext`. Kept
 * as a structural interface so unit tests can pass a hand-rolled `{ addCookies }`
 * stub without importing `@playwright/test`.
 */
export type CookieDescriptor = {
  readonly name: string;
  readonly value: string;
  readonly url: string;
  readonly httpOnly?: boolean;
  readonly sameSite?: 'Lax' | 'Strict' | 'None';
};

export type AddCookiesFn = (cookies: ReadonlyArray<CookieDescriptor>) => Promise<void>;

export type ContextLike = {
  readonly addCookies: AddCookiesFn;
};

export type SignInAsOptions = {
  readonly email: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
};

const DEFAULT_BASE_URL = 'http://localhost:3232';
const SESSION_COOKIE = 'authjs.session-token';
const CSRF_COOKIE = 'authjs.csrf-token';

const isLocalhostBaseUrl = (baseUrl: string): boolean =>
  baseUrl.startsWith('http://localhost:') || baseUrl === 'http://localhost';

/**
 * Type-narrow `Headers.getSetCookie()` (available on Node 20+ `Headers` via
 * undici). Falls back to parsing `headers.get('set-cookie')` if the runtime
 * lacks `getSetCookie` (older Node / non-undici fetch stubs in tests).
 */
const readSetCookies = (headers: Headers): string[] => {
  const maybeGetter = (headers as unknown as {
    getSetCookie?: () => string[];
  }).getSetCookie;
  if (typeof maybeGetter === 'function') return maybeGetter.call(headers);
  const single = headers.get('set-cookie');
  return single ? [single] : [];
};

const extractCookie = (headers: Headers, name: string): string | null => {
  for (const entry of readSetCookies(headers)) {
    const eq = entry.indexOf('=');
    if (eq === -1) continue;
    const cookieName = entry.slice(0, eq).trim();
    if (cookieName !== name) continue;
    const rest = entry.slice(eq + 1);
    const semi = rest.indexOf(';');
    return (semi === -1 ? rest : rest.slice(0, semi)).trim();
  }
  return null;
};

export const signInAs = async (
  context: ContextLike,
  opts: SignInAsOptions,
): Promise<void> => {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  if (!isLocalhostBaseUrl(baseUrl)) {
    throw new Error(
      `signInAs is localhost-only. baseUrl=${baseUrl} — refusing to mint a non-Secure session cookie for a remote host.`,
    );
  }
  const doFetch = opts.fetch ?? globalThis.fetch;

  let csrfResp: Response;
  try {
    csrfResp = await doFetch(`${baseUrl}/api/auth/csrf`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  } catch (e) {
    throw new Error(
      `signInAs failed: network error: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (csrfResp.status !== 200) {
    throw new Error(
      `signInAs failed: csrf endpoint returned status ${csrfResp.status}`,
    );
  }
  const csrfBody = (await csrfResp.json()) as { csrfToken?: unknown };
  if (typeof csrfBody.csrfToken !== 'string' || csrfBody.csrfToken.length === 0) {
    throw new Error(
      `signInAs failed: csrf body missing csrfToken`,
    );
  }
  const csrfToken = csrfBody.csrfToken;

  // Carry the csrf cookie set by GET /csrf forward to the POST. NextAuth uses
  // double-submit cookie validation: the csrfToken in the body must match the
  // cookie value (after the salt-derived prefix is stripped on the server).
  const csrfCookieValue = extractCookie(csrfResp.headers, CSRF_COOKIE);
  const cookieHeader =
    csrfCookieValue !== null ? `${CSRF_COOKIE}=${csrfCookieValue}` : '';

  const body = new URLSearchParams({
    email: opts.email,
    csrfToken,
    callbackUrl: baseUrl,
    redirect: 'false',
  });

  let credResp: Response;
  try {
    credResp = await doFetch(`${baseUrl}/api/auth/callback/credentials`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      body: body.toString(),
      // NextAuth v5 responds with 302 + Set-Cookie on success. If we let
      // fetch follow the redirect, the Set-Cookie header is consumed by
      // the redirect chain and the final response has no session cookie
      // for us to inject. `redirect: 'manual'` keeps the 302 visible so
      // `extractCookie(credResp.headers, SESSION_COOKIE)` can grab it.
      redirect: 'manual',
    });
  } catch (e) {
    throw new Error(
      `signInAs failed: network error: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const sessionCookieValue = extractCookie(credResp.headers, SESSION_COOKIE);
  if (sessionCookieValue === null) {
    // Surface status + redirect target so failures self-explain (e.g.
    // `error=Configuration` points at a missing env/provider; 500 points
    // at a server crash; 302 with no Set-Cookie points at authorize()
    // returning null inside NextAuth).
    throw new Error(
      `signInAs failed: credentials callback returned no session cookie (status=${credResp.status} location=${credResp.headers.get('location') ?? 'null'})`,
    );
  }

  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: sessionCookieValue,
      url: baseUrl,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
};
