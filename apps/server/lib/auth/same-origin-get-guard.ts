/**
 * Same-origin guard for sensitive GET routes (e.g. CSV exports).
 *
 * Source: PAUSE 2 of `.specs/central-server-onboarding-v2-sso.manager-ui.md`
 *         (commit 4267229) — security HIGH H1.
 *
 * GET routes that stream org-level PII (audit-log CSV, team-roster CSV) are
 * reachable via cross-site `<a href>` clicks. Browsers do NOT pre-flight GET,
 * so an authenticated manager who clicks an attacker link auto-downloads the
 * file. This module blocks that vector by rejecting non-same-origin GETs.
 *
 * Primary signal: `Sec-Fetch-Site` (Fetch Metadata Spec, https://w3c.github.io/webappsec-fetch-metadata/).
 * Fallback for legacy/non-browser clients: parse `Origin` (preferred) or
 * `Referer` via `new URL().origin` and compare with EXACT equality against
 * `baseUrl`. NOT a `startsWith` prefix match — that is vulnerable to suffix
 * injection (e.g. `https://app.tokenfx.io.evil.com`).
 *
 * Sibling of `csrf-origin-guard.ts` (POST-only). Both live in `lib/auth/`
 * because they share the `HasHeaderGetter` shape and the operational
 * "CSRF defense" context. Edge-runtime safe (no DB / Node-only imports).
 *
 * Decisions NOT made here:
 *   - `Sec-Fetch-Mode` / `Sec-Fetch-Dest` are ignored. `Sec-Fetch-Site` alone
 *     is sufficient for the cross-origin-navigation threat; layering Mode
 *     and Dest creates false-negatives without improving the security model.
 *   - `same-site` is REJECTED (not accepted). The manager dashboard runs on a
 *     single subdomain; same-site requests would imply a sibling subdomain
 *     in the same registrable-domain space — suspicious by default. If the
 *     org adopts multiple subdomains in the future, this decision flips
 *     to accept (1-case-of-switch change) and the spec needs a subdomain
 *     allowlist REQ.
 */

// Re-export the minimal `Request`-shaped contract from the sibling
// `csrf-origin-guard.ts` so callers can `import type { HasHeaderGetter }`
// from either module — single source of truth.
export type { HasHeaderGetter } from './csrf-origin-guard';
import type { HasHeaderGetter } from './csrf-origin-guard';

export type SameOriginGetReason =
  | 'cross-site'
  | 'same-site-rejected'
  | 'cross-origin'
  | 'null-origin'
  | 'missing-origin';

export type CheckSameOriginGetResult =
  | { ok: true }
  | { ok: false; reason: SameOriginGetReason };

/**
 * Parse a header value as a URL and return its `.origin` (scheme://host[:port],
 * default ports stripped, path/query/fragment removed). Returns null on parse
 * failure — the caller treats that as cross-origin (defensive default).
 */
const tryUrlOrigin = (raw: string): string | null => {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
};

/**
 * Decision matrix (locked in spec):
 *
 *   Sec-Fetch-Site = 'same-origin'         → ok
 *   Sec-Fetch-Site = 'none' (typed/bookmark) → ok
 *   Sec-Fetch-Site = 'same-site'           → reject 'same-site-rejected'
 *   Sec-Fetch-Site = 'cross-site'          → reject 'cross-site'
 *   Sec-Fetch-Site = unknown / missing     → fall through to Origin/Referer
 *
 *   Fallback:
 *     Origin = 'null'                      → reject 'null-origin'
 *     Origin = baseUrl (URL.origin eq)     → ok
 *     Origin = different origin            → reject 'cross-origin'
 *     Origin missing AND Referer matches   → ok
 *     Origin missing AND Referer differs   → reject 'cross-origin'
 *     Origin missing AND Referer missing   → reject 'missing-origin'
 *
 * The Sec-Fetch-Site signals are normalized via `toLowerCase()`. Browsers
 * always emit lowercase, but the Fetch Metadata Spec phrasing is case-
 * insensitive — defensive normalization keeps forward-compat.
 *
 * @param request — any object exposing `headers.get(name)`.
 * @param baseUrl — the expected origin (e.g. `https://app.tokenfx.io`).
 *   Must be the result of `new URL(...).origin` (no trailing slash, default
 *   ports normalized away). Callers should pass `new URL(req.url).origin`.
 */
export const checkSameOriginGet = (
  request: HasHeaderGetter,
  baseUrl: string,
): CheckSameOriginGetResult => {
  const fetchSite = request.headers.get('sec-fetch-site')?.toLowerCase() ?? null;

  if (fetchSite === 'same-origin' || fetchSite === 'none') {
    return { ok: true };
  }
  if (fetchSite === 'same-site') {
    return { ok: false, reason: 'same-site-rejected' };
  }
  if (fetchSite === 'cross-site') {
    return { ok: false, reason: 'cross-site' };
  }

  // Fall-through: Sec-Fetch-Site missing OR unknown value (forward-compat
  // for future Fetch Metadata enum additions). Use Origin/Referer fallback.
  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');

  // `Origin: null` (sandboxed iframe, data: / file: URIs) is always
  // cross-origin — reject as the dedicated reason for ops triage.
  if (origin === 'null') {
    return { ok: false, reason: 'null-origin' };
  }

  if (origin !== null) {
    return tryUrlOrigin(origin) === baseUrl
      ? { ok: true }
      : { ok: false, reason: 'cross-origin' };
  }

  if (referer !== null) {
    return tryUrlOrigin(referer) === baseUrl
      ? { ok: true }
      : { ok: false, reason: 'cross-origin' };
  }

  // No Sec-Fetch-Site, no Origin, no Referer — defensive reject. Legitimate
  // browsers always send at least one.
  return { ok: false, reason: 'missing-origin' };
};
