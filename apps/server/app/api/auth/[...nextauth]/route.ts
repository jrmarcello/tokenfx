/**
 * NextAuth route handler with CSRF Origin guard.
 *
 * central-server-onboarding-v2-sso (TASK-11 + TASK-9 escalation):
 *   The original spec called for middleware-based CSRF Origin enforcement, but
 *   Next.js middleware runs in the Edge runtime and our redemption-log writer
 *   transitively pulls `pg` (Node-only) for the audit row. Wrapping the route
 *   handler is the equivalent guard with full Node runtime access.
 *
 * Flow:
 *   1. For every signin initiation (`POST /api/auth/signin`), check Origin
 *      against the request's own `baseUrl`. Cross-origin / missing-origin
 *      requests → 403 + audit row + return without invoking NextAuth.
 *   2. Same-origin requests pass through to the NextAuth-built handler.
 *
 * The guard is intentionally narrow: it only fires on the signin POST path.
 * Other NextAuth routes (callback, session, signout, csrf-token, ...) carry
 * their own anti-forgery primitives (csrfToken, state param) and don't need
 * an additional Origin check at this layer.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { handlers } from '@/lib/auth/auth';
import { checkSigninOrigin } from '@/lib/auth/csrf-origin-guard';
import { writeRedemptionLog } from '@/lib/queries/redemption-log';
import { getDb } from '@/lib/db/client';
import { log as logger } from '@root/logger';

const SIGNIN_PATH_PREFIX = '/api/auth/signin';
const SENTINEL_TOKEN_PREFIX = '00000000';

type Handler = (request: NextRequest) => Promise<Response> | Response;

const extractRequestIp = (request: NextRequest): string => {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded !== null) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = request.headers.get('x-real-ip');
  if (real !== null) {
    const trimmed = real.trim();
    if (trimmed) return trimmed;
  }
  return '';
};

const writeCsrfAuditRow = async (
  request: NextRequest,
  reason: string,
): Promise<void> => {
  // Privacy: we don't know the email at this point (pre-NextAuth), so the
  // hash + domain fields are empty. The signal-bearing columns are
  // `outcome='rejected-csrf'`, `method='sso-auto'`, request_ip, and user_agent.
  try {
    await writeRedemptionLog(getDb(), {
      tokenPrefix: SENTINEL_TOKEN_PREFIX,
      machineId: null,
      emailDomain: '',
      emailHash: '',
      requestIp: extractRequestIp(request),
      outcome: 'rejected-csrf',
      method: 'sso-auto',
      ssoProvider: null,
      ssoSubjectHash: null,
      iss: null,
      userAgent: request.headers.get('user-agent'),
    });
  } catch (err) {
    logger.warn('csrf-guard audit write failed', {
      reason,
      error_message: err instanceof Error ? err.message : String(err),
    });
  }
};

const csrfWrap = (handler: Handler): Handler => {
  return async (request: NextRequest) => {
    // POST is the signin-initiation verb; GET on `/signin` is the rendered
    // page and carries no state-changing risk. Restrict the guard to POST.
    if (request.method === 'POST') {
      const url = new URL(request.url);
      if (url.pathname.startsWith(SIGNIN_PATH_PREFIX)) {
        const baseUrl = `${url.protocol}//${url.host}`;
        const csrf = checkSigninOrigin(request, baseUrl);
        if (!csrf.ok) {
          await writeCsrfAuditRow(request, csrf.reason);
          return NextResponse.json(
            { error: { message: 'forbidden', code: csrf.reason } },
            { status: 403 },
          );
        }
      }
    }
    return handler(request);
  };
};

export const GET: Handler = csrfWrap(handlers.GET);
export const POST: Handler = csrfWrap(handlers.POST);
