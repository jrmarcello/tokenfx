import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { buildDiscoveryDoc, signIdToken } from './fixtures.js';
import type { JwksKit } from './jwks.js';
import { jwksKit as defaultJwksKit } from './jwks.js';
import {
  defaultScenarioStore,
  ScenarioOverrideSchema,
  type ScenarioStore,
} from './scenario.js';

/**
 * `/authorize` query-param schema. Zod-validated at the boundary per
 * `.claude/rules/security.md` ("Zod at every external input").
 *
 * - `redirect_uri` and `state` are required (existing contract).
 * - `nonce` is optional, ≤ 255 chars. Empty string is normalised to
 *   undefined in a post-parse step (treated as "no nonce captured" —
 *   NOT a validation error, since an empty `?nonce=` from a
 *   misconfigured OAuth caller is a protocol-level no-op, not abuse).
 *
 * Spec: .specs/sso-nonce-replay.md TASK-3 §Decisões #4.
 */
const AuthorizeQuerySchema = z.object({
  response_type: z.string().optional(),
  client_id: z.string().optional(),
  redirect_uri: z.string().min(1, 'redirect_uri is required'),
  state: z.string().min(1, 'state is required'),
  scope: z.string().optional(),
  nonce: z.string().max(255).optional(),
});

export type Deps = Readonly<{
  baseUrl: string;
  jwks: JwksKit;
  scenario: ScenarioStore;
}>;

/**
 * Strict allowlist for `redirect_uri` (review-report-2026-05-14-fixes
 * TASK-H1, REQ-3/REQ-4). The previous `uri.startsWith(...)` check was
 * bypassable by suffix-injection (`http://localhost.evil.com/cb`,
 * `http://127.0.0.1.attacker.com/cb`). The fix:
 *
 * 1. Parse the URI via `new URL(...)` — invalid URIs and non-URLs throw
 *    and are rejected.
 * 2. Two acceptance paths (either one suffices):
 *    - Exact origin equality with the stub's own `baseUrl` (covers
 *      same-origin callbacks; scheme + host + port must all match).
 *    - Loopback HTTP allowlist over an exact hostname set
 *      (`localhost`, `127.0.0.1`, `[::1]`). HTTPS / `javascript:` /
 *      `file:` / `data:` are rejected because they do not match `http:`.
 */
const LOOPBACK_HOSTS = new Set<string>(['localhost', '127.0.0.1', '[::1]']);

const isAllowedRedirectUri = (uri: string, baseUrl: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  // Path 1: exact origin equality with the stub's own baseUrl.
  if (parsed.origin === new URL(baseUrl).origin) return true;
  // Path 2: loopback HTTP allowlist (third-party local-only clients).
  if (parsed.protocol !== 'http:') return false;
  return LOOPBACK_HOSTS.has(parsed.hostname);
};

const badRequest = (message: string) =>
  ({ error: { message } }) as const;

export const createApp = (deps: Deps): Hono => {
  const app = new Hono();

  // --- Discovery -------------------------------------------------------
  app.get('/.well-known/openid-configuration', (c) => {
    return c.json(buildDiscoveryDoc(deps.baseUrl));
  });

  // --- JWKS ------------------------------------------------------------
  app.get('/jwks', (c) => {
    return c.json({ keys: [deps.jwks.publicJwk] });
  });

  // --- Authorize -------------------------------------------------------
  app.get('/authorize', (c) => {
    const parsed = AuthorizeQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const message = issue
        ? `${issue.path.join('.') || '<root>'}: ${issue.message}`
        : 'invalid authorize query';
      return c.json(badRequest(message), 400);
    }
    const { redirect_uri: redirectUri, state, nonce: nonceRaw } = parsed.data;

    if (!isAllowedRedirectUri(redirectUri, deps.baseUrl)) {
      return c.json(
        badRequest('redirect_uri must be localhost / 127.0.0.1 / stub base URL'),
        400,
      );
    }

    // Empty-string nonce normalises to null (no record). Non-empty
    // values are recorded into the pending slot so /token can echo
    // them into the id_token's `nonce` claim — NextAuth requires this
    // for nonce-check validation (sso-nonce-replay REQ-2).
    const pendingNonce = nonceRaw && nonceRaw.length > 0 ? nonceRaw : null;
    deps.scenario.setPendingNonce(pendingNonce);

    const code = randomUUID();
    const url = new URL(redirectUri);
    url.searchParams.set('code', code);
    url.searchParams.set('state', state);
    return c.redirect(url.toString(), 302);
  });

  // --- Token -----------------------------------------------------------
  app.post('/token', async (c) => {
    const contentType = c.req.header('content-type') ?? '';
    if (!contentType.includes('application/x-www-form-urlencoded')) {
      return c.json(
        badRequest('Content-Type must be application/x-www-form-urlencoded'),
        400,
      );
    }

    const body = await c.req.parseBody();

    const grantType = typeof body.grant_type === 'string' ? body.grant_type : '';
    const code = typeof body.code === 'string' ? body.code : '';
    const redirectUri = typeof body.redirect_uri === 'string' ? body.redirect_uri : '';

    if (!grantType) return c.json(badRequest('grant_type is required'), 400);
    if (grantType !== 'authorization_code') {
      return c.json(badRequest('only grant_type=authorization_code is supported'), 400);
    }
    if (!code) return c.json(badRequest('code is required'), 400);
    if (!redirectUri) return c.json(badRequest('redirect_uri is required'), 400);

    // Note: form-body `nonce` is INTENTIONALLY NOT READ. NextAuth's
    // OAuth flow places `nonce` on the `/authorize` query, not the
    // `/token` POST body — the previous form-body echo was dead code
    // under the real flow (sso-nonce-replay TASK-3 dead-code removal).
    // The pending slot captured at `/authorize` time is the sole
    // fallback for the `nonce` claim when scenario.nonce is null.
    const scenario = deps.scenario.get();
    const pendingNonce = deps.scenario.getPendingNonce();
    const signed = await signIdToken({
      jwks: deps.jwks,
      issuer: deps.baseUrl,
      scenario,
      pendingNonce,
    });

    if (!signed.ok) {
      // Stable opaque message — raw jose error stays out of the response body
      // (security rule §Data Protection: sanitize error messages).
      return c.json({ error: { message: 'token signing failed' } }, 500);
    }

    return c.json({
      access_token: randomUUID(),
      token_type: 'Bearer',
      expires_in: 3600,
      id_token: signed.value,
    });
  });

  // Defense-in-depth (security review MEDIUM-1): the stub is loopback-only
  // (bound to 127.0.0.1 in index.ts), but we also gate /admin/* on Origin to
  // close the DNS-rebinding attack vector where a malicious page in the
  // developer's browser could otherwise POST to the stub. Loopback Origins
  // and explicit absence (curl/server-side calls) are allowed.
  const requireLoopbackOrigin = (c: Context) => {
    const origin = c.req.header('origin');
    if (!origin) return null;
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return null;
    return c.json(badRequest('admin endpoints reject cross-origin requests'), 403);
  };

  // --- Admin: set scenario --------------------------------------------
  app.post('/admin/scenario', async (c) => {
    const originErr = requireLoopbackOrigin(c);
    if (originErr) return originErr;

    // Strict content-type — closes the DNS-rebinding `<form>` payload path
    // where a browser sends `text/plain` with a JSON-looking body.
    const contentType = c.req.header('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      return c.json(badRequest('Content-Type must be application/json'), 400);
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(badRequest('body must be valid JSON'), 400);
    }
    const parsed = ScenarioOverrideSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const message = issue
        ? `${issue.path.join('.') || '<root>'}: ${issue.message}`
        : 'invalid scenario override';
      return c.json(badRequest(message), 400);
    }
    deps.scenario.set(parsed.data);
    return c.body(null, 204);
  });

  // --- Admin: reset scenario ------------------------------------------
  app.post('/admin/scenario/reset', (c) => {
    const originErr = requireLoopbackOrigin(c);
    if (originErr) return originErr;
    deps.scenario.reset();
    return c.body(null, 204);
  });

  return app;
};

// Convenience for tests that want a fully-defaulted app
export const createDefaultApp = (baseUrl: string): Hono =>
  createApp({ baseUrl, jwks: defaultJwksKit, scenario: defaultScenarioStore });
