/**
 * `extractRequestContext` — pull `ip` + `userAgent` from a Next.js request
 * for the per-request ALS context propagated by `runInRequestContext`.
 *
 * Lives in its own module (separate from `route.ts`) so integration tests
 * can import it without pulling `@/lib/auth/auth`, which transitively
 * imports `next/server` (no `.js`) and fails Node's strict ESM resolver
 * under vitest. See the top-of-file block in
 * `tests/integration/sso-auto-provision-csrf.test.ts` for the well-
 * documented NextAuth ESM limitation, and `request-context-wiring.test.ts`
 * for how this module is re-composed into a local `csrfWrap` for testing.
 *
 * Contract (central-server-onboarding-v2-sso, REQ-13 / REQ-13a):
 *   - `x-forwarded-for` first hop (trimmed) takes precedence.
 *   - Falls back to `x-real-ip` (trimmed).
 *   - Both unset/empty → `ip: ''` (empty string, NOT undefined).
 *   - `user-agent` header → `userAgent`; unset → `''`.
 *   - The whole extraction is wrapped in try/catch. On any throw (crafted
 *     header, abusive proxy, etc.) the function returns the empty-sentinel
 *     and surfaces a warn line ONCE per process. The route MUST NEVER 500
 *     because context extraction failed (REQ-13a).
 */
import type { NextRequest } from 'next/server';
import { log as logger } from '@tokenfx/shared/logger';
import type { RequestContext } from '@/lib/auth/request-context';
import { getTrustedClientIp } from '@/lib/util/ip-trust';

const EMPTY_CONTEXT: RequestContext = { ip: '', userAgent: '' };

/**
 * Module-level "have we warned for this process?" flag. Single boolean
 * because every extraction failure converges on the same outcome (empty
 * sentinel + warn). Tests reset via `__resetWarnedForExtractionFailure`.
 */
let warnedForExtractionFailure = false;

/** Test-only: reset the warn-once flag between cases. */
export const __resetWarnedForExtractionFailure = (): void => {
  warnedForExtractionFailure = false;
};

const warnOnce = (errorMessage: string): void => {
  if (warnedForExtractionFailure) return;
  warnedForExtractionFailure = true;
  logger.warn('request-context extraction failed; using empty defaults', {
    error_message: errorMessage,
  });
};

const readIp = (request: NextRequest): string => {
  // Delegated to `getTrustedClientIp` (review M1). The prior inline impl
  // trusted `X-Forwarded-For` unconditionally; the central helper gates
  // XFF on `TOKENFX_TRUSTED_PROXY=1` and falls back to `X-Real-IP`.
  // REQ-13/REQ-13a require the empty-string sentinel (NOT null) so the
  // RequestContext stays string-typed end-to-end; we narrow null here.
  const ip = getTrustedClientIp(request);
  if (ip !== null) {
    const trimmed = ip.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return '';
};

export const extractRequestContext = (
  request: NextRequest,
): RequestContext => {
  try {
    const ip = readIp(request);
    const userAgent = request.headers.get('user-agent') ?? '';
    return { ip, userAgent };
  } catch (err) {
    warnOnce(err instanceof Error ? err.message : String(err));
    return EMPTY_CONTEXT;
  }
};
