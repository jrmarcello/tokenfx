/**
 * CSRF Origin/Referer validation for /api/auth/signin initiation
 * (T12 M12.1 + spec b §Decisão #19 + review-report-2026-05-14-fixes M4).
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
 *   Origin === baseUrl origin     → ok
 *   Origin = "null"               → null-origin (sandboxed iframe / data: URI)
 *   Origin missing AND Referer    → fall back to Referer's origin check
 *     missing                     → missing-origin
 *   Origin/Referer origin ≠       → cross-origin
 *     baseUrl origin
 *   Origin/Referer unparseable    → cross-origin (safer default)
 *
 * Comparison strategy: both `baseUrl` and the candidate header value are
 * parsed via `new URL(...).origin`, which yields a canonical
 * `<scheme>://<host>[:<non-default-port>]` string. We then compare with
 * strict equality (`===`).
 *
 * Why origin-equality (NOT `startsWith`): a prefix check on
 * `https://app.tokenfx.io` admits `https://app.tokenfx.io.evil.com` —
 * a different origin with the baseUrl as a prefix of its host. WHATWG
 * URL normalization is the only safe way to compare two origins:
 * - Default ports collapse: `new URL('https://x:443').origin === 'https://x'`.
 * - Path/query/fragment stripped: `new URL('https://x/y?z').origin === 'https://x'`.
 * - Case-folded host: `new URL('https://X').origin === 'https://x'`.
 *
 * @param request — NextAuth signin initiation request (anything with `headers.get`).
 * @param baseUrl — configured app base URL (e.g., `https://app.tokenfx.io`).
 *   Must be a parseable absolute URL; its `.origin` is what we compare against.
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

  // Prefer Origin; fall back to Referer (may include path/query — the
  // `.origin` projection strips those).
  const candidate = origin ?? referer ?? '';

  const baseOrigin = new URL(baseUrl).origin;
  let candidateOrigin: string;
  try {
    candidateOrigin = new URL(candidate).origin;
  } catch {
    // Unparseable header value — treat as cross-origin (safer than
    // letting a malformed value bypass the check).
    return { ok: false, reason: 'cross-origin' };
  }

  if (candidateOrigin !== baseOrigin) {
    return { ok: false, reason: 'cross-origin' };
  }

  return { ok: true };
};
