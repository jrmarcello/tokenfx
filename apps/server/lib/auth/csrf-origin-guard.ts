/**
 * CSRF Origin/Referer validation for /api/auth/signin initiation
 * (T12 M12.1 + spec b §Decisão #19).
 *
 * NextAuth v5 does NOT expose a pre-handler hook for the signIn flow, so
 * this guard runs in `apps/server/middleware.ts` BEFORE the route
 * handler. Cross-origin SSO initiation → 403 + audit row.
 *
 * Pure helper: takes a `Request` shape (or `NextRequest`), returns
 * decision. No I/O. Caller handles HTTP response + audit-log write.
 *
 * Edge-runtime safe: pulls no DB / Node-only modules.
 */

export type CheckSigninOriginResult =
  | { ok: true }
  | { ok: false; reason: 'cross-origin' | 'missing-origin' | 'null-origin' };

/**
 * Minimal `Request`-shaped contract we depend on. NextRequest, the global
 * `Request`, and hand-written test stubs all satisfy this.
 */
export type HasHeaderGetter = {
  headers: { get(name: string): string | null };
};

/**
 * Validate that an `/api/auth/signin` initiation request was made from the
 * same origin as the configured `baseUrl`. Returns a tagged result so the
 * caller can map `reason` → audit-log `outcome` without re-parsing strings.
 *
 * Decision matrix:
 *
 *   Origin = baseUrl prefix       → ok
 *   Origin = "null"               → null-origin (sandboxed iframe / data: URI)
 *   Origin missing AND Referer    → fall back to Referer's prefix check
 *     missing                     → missing-origin
 *   Origin/Referer ≠ baseUrl      → cross-origin
 *
 * Why prefix-match (not exact equality): callers may pass `Origin` headers
 * with no trailing path (browser standard) but some user-agents append one;
 * `startsWith(baseUrl)` accepts both. `baseUrl` itself should NEVER contain
 * a trailing path — pass `request.nextUrl.origin` or the configured app URL.
 *
 * @param request — NextAuth signin initiation request (anything with `headers.get`).
 * @param baseUrl — configured app base URL (e.g., `https://app.tokenfx.io`).
 *   Must match `Origin` for same-origin classification.
 */
export const checkSigninOrigin = (
  request: HasHeaderGetter,
  baseUrl: string,
): CheckSigninOriginResult => {
  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');

  // `Origin: null` (sandboxed iframe, data: / file: URIs, some redirect
  // chains) is a cross-origin signal. Reject for safety — it's never a
  // legitimate same-origin SSO initiation.
  if (origin === 'null') {
    return { ok: false, reason: 'null-origin' };
  }

  // If both are absent, refuse — modern browsers ALWAYS send Origin on a
  // cross-origin POST, and reasonable same-origin clients send at least
  // one of the two. Absence is suspicious; safe default = reject.
  if (origin === null && referer === null) {
    return { ok: false, reason: 'missing-origin' };
  }

  // Prefer Origin; fall back to Referer (which may include a path — that's
  // fine, the prefix check still works because baseUrl has no trailing
  // path, so any value starting with baseUrl is same-origin).
  const candidate = origin ?? referer ?? '';
  if (!candidate.startsWith(baseUrl)) {
    return { ok: false, reason: 'cross-origin' };
  }

  return { ok: true };
};
