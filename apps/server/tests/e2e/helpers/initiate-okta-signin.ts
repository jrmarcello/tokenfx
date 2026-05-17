/**
 * `initiateOktaSignin` — Auth.js v5-compatible OAuth signin initiator.
 *
 * Auth.js v5 (this codebase: `@auth/core@0.37.2`) intentionally rejects
 * `GET /api/auth/signin/[provider]` with `UnknownAction` —
 * `lib/pages/index.js:signin(providerId, ...)` throws when any providerId
 * is passed:
 *
 *     signin(providerId, error) {
 *         if (providerId) throw new UnknownAction("Unsupported action");
 *         ...
 *     }
 *
 * The supported flow is:
 *   1. GET  /api/auth/csrf           → obtain CSRF token + cookie
 *   2. POST /api/auth/signin/[id]    → 302 to provider's /authorize URL
 *
 * Older Auth.js v4 (and the test patterns we copied from v4 references)
 * supported the GET shortcut; v5 dropped it. The SSO E2E specs
 * (`sso-flow`, `sso-nonce-replay`, `sso-replay-audit-row`) were authored
 * against the v4 assumption and never validated end-to-end in CI — hence
 * the "8 tests broken since at least 4eec79e" finding (roadmap.md).
 *
 * This helper centralises the v5 idiom so the specs don't repeat the
 * CSRF dance inline. Returns the raw POST response (302 + Set-Cookie
 * headers); callers chose whether to follow redirects.
 */
import type { APIRequestContext, APIResponse } from '@playwright/test';

export type InitiateOptions = {
  /** Where to POST. Defaults to `/api/auth/signin/okta`. */
  pathname?: string;
  /** Callback URL to embed in the POST body. Defaults to the dashboard root. */
  callbackUrl?: string;
  /** Auth.js v5 enforces a same-origin Origin header on signin POST. */
  originOverride?: string;
  /** Forward `maxRedirects: 0` (default) to inspect the 302 directly,
   *  or pass a higher number to let Playwright follow the chain. */
  maxRedirects?: number;
};

const FORM_URLENCODED = 'application/x-www-form-urlencoded';

const formEncode = (data: Record<string, string>): string =>
  Object.entries(data)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

/**
 * Drives the Auth.js v5 OAuth signin initiation. Returns the POST response;
 * a successful initiation is a 302 with `Location` pointing at the provider's
 * `/authorize` endpoint (the stub or real Okta).
 */
export const initiateOktaSignin = async (
  request: APIRequestContext,
  baseUrl: string,
  options: InitiateOptions = {},
): Promise<APIResponse> => {
  const pathname = options.pathname ?? '/api/auth/signin/okta';
  const callbackUrl = options.callbackUrl ?? baseUrl;
  const origin = options.originOverride ?? baseUrl;
  const maxRedirects = options.maxRedirects ?? 0;

  // 1. GET CSRF token + cookie. Playwright's request context auto-stores
  // the Set-Cookie response in its cookie jar, so step 2's POST carries
  // it automatically.
  const csrfRes = await request.get(`${baseUrl}/api/auth/csrf`);
  if (!csrfRes.ok()) {
    throw new Error(
      `initiateOktaSignin: GET /api/auth/csrf failed (status=${csrfRes.status()})`,
    );
  }
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };

  // 2. POST the signin initiation. Auth.js v5 requires:
  //    - application/x-www-form-urlencoded body
  //    - csrfToken field (matches cookie via double-submit)
  //    - Origin header matching baseUrl (csrfWrap in route.ts enforces)
  return request.post(`${baseUrl}${pathname}`, {
    headers: {
      'Content-Type': FORM_URLENCODED,
      Origin: origin,
    },
    data: formEncode({ csrfToken, callbackUrl }),
    maxRedirects,
  });
};
