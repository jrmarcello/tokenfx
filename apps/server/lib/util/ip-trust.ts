/**
 * `getTrustedClientIp` — central, security-aware reader for the inbound
 * client IP on a Next.js request.
 *
 * Background: prior to this module each route read `x-forwarded-for` directly
 * and used the first hop verbatim for rate-limiting and audit-log writes.
 * That is unsafe in deploys that don't sit behind a reverse proxy controlled
 * by the operator — any client can set XFF themselves, bypassing the IP
 * rate-limit and poisoning the audit trail with attacker-chosen values
 * (see review report 2026-05-14, finding M1).
 *
 * Trust model
 * -----------
 * - `TOKENFX_TRUSTED_PROXY=1` is a *declaration by the operator* that an
 *   upstream reverse proxy (Nginx, Cloudflare, Vercel, …) overwrites
 *   `X-Forwarded-For` and `X-Real-IP` on every request. When that contract
 *   holds, the first XFF hop is the genuine client.
 * - When the flag is **unset** (the default), we ignore BOTH
 *   `X-Forwarded-For` AND `X-Real-IP` — both headers are client-injectable
 *   end-to-end if no proxy strips them. The helper returns `null` so callers
 *   collapse to the `unknown-ip` rate-limit bucket. (Prior versions trusted
 *   `X-Real-IP` in this path; the post-review hardening drops that too —
 *   any header trust requires explicit operator opt-in via the env flag.)
 * - With the flag **set** but no real proxy in front, the first hop *is*
 *   client-controlled. That's a misconfiguration the operator owns — the
 *   helper's contract is explicit: trust-flag-on means trust XFF as-is.
 *
 * Returns `null` when no usable address can be derived. Callers compose
 * this with `truncateIpForAudit` (in the same directory) to land a /24 or
 * /48 CIDR in the audit log; `null` becomes `unknown-ip` for rate-limit
 * keying upstream.
 */
import { log } from '@root/logger';

export const getTrustedClientIp = (
  req: { headers: { get(name: string): string | null } },
  env: NodeJS.ProcessEnv = process.env,
): string | null => {
  const trusted = env.TOKENFX_TRUSTED_PROXY === '1';
  if (trusted) {
    const xff = req.headers.get('x-forwarded-for');
    if (xff && xff.length > 0) {
      // `split(',')` always yields ≥ 1 element, so `[0]` is safe.
      const first = xff.split(',')[0].trim();
      if (first.length > 0) return first;
      log.warn('getTrustedClientIp: XFF present but first hop empty');
      return null;
    }
    log.warn(
      'getTrustedClientIp: TOKENFX_TRUSTED_PROXY set but XFF header absent',
    );
    return req.headers.get('x-real-ip');
  }
  // Untrusted-proxy mode: every IP header is client-spoofable. Refuse to
  // pick one; let the caller collapse to `unknown-ip` for rate-limit keying.
  return null;
};
