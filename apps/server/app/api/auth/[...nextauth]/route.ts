/**
 * NextAuth route handler with CSRF Origin guard + per-request ALS context.
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
 *   2. Same-origin requests pass through to the NextAuth-built handler,
 *      WRAPPED in `runInRequestContext(extractRequestContext(req), ...)` so
 *      deep callbacks (e.g. NextAuth's `signIn` callback) can read the
 *      current request's `ip` + `userAgent` via `getRequestContext()`.
 *
 * The guard is intentionally narrow: it only fires on the signin POST path.
 * Other NextAuth routes (callback, session, signout, csrf-token, ...) carry
 * their own anti-forgery primitives (csrfToken, state param) and don't need
 * an additional Origin check at this layer. The ALS wrap, however, runs on
 * EVERY method/path so any downstream callback (across the whole NextAuth
 * surface) sees a populated context — never an empty fallback purely because
 * the verb wasn't POST.
 *
 * Per REQ-13a, `extractRequestContext` is wrapped in try/catch with a
 * warn-once dedup so the route NEVER returns 500 due to context extraction
 * failure (crafted headers, abusive proxies, etc.).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { handlers } from '@/lib/auth/auth';
import { checkSigninOrigin } from '@/lib/auth/csrf-origin-guard';
import { writeRedemptionLog } from '@/lib/queries/redemption-log';
import { getDb } from '@/lib/db/client';
import { runInRequestContext } from '@/lib/auth/request-context';
import {
  extractRequestContext,
  __resetWarnedForExtractionFailure,
} from './request-context-extract';
import { log as logger } from '@root/logger';

// Re-export so the spec's public surface (`extractRequestContext` exported
// from the route handler module) is preserved, and integration tests that
// can't load NextAuth ESM in vitest can still reach the test-only reset.
export { extractRequestContext, __resetWarnedForExtractionFailure };

const SIGNIN_PATH_PREFIX = '/api/auth/signin';
const SENTINEL_TOKEN_PREFIX = '00000000';

type Handler = (request: NextRequest) => Promise<Response> | Response;

const writeCsrfAuditRow = async (
  request: NextRequest,
  reason: string,
): Promise<void> => {
  // Privacy: we don't know the email at this point (pre-NextAuth), so the
  // hash + domain fields are empty. The signal-bearing columns are
  // `outcome='rejected-csrf'`, `method='sso-auto'`, request_ip, and user_agent.
  try {
    const ctx = extractRequestContext(request);
    await writeRedemptionLog(getDb(), {
      tokenPrefix: SENTINEL_TOKEN_PREFIX,
      machineId: null,
      emailDomain: '',
      emailHash: '',
      requestIp: ctx.ip,
      outcome: 'rejected-csrf',
      method: 'sso-auto',
      ssoProvider: null,
      ssoSubjectHash: null,
      iss: null,
      userAgent: ctx.userAgent === '' ? null : ctx.userAgent,
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
    // Establish the per-request ALS scope BEFORE invoking the downstream
    // handler. The Promise must be awaited inside the scope so any
    // microtasks the handler schedules also observe the context.
    // Defense-in-depth: extractRequestContext has its own try/catch +
    // warn-once, but REQ-13a's "never 500" contract is load-bearing —
    // belt-and-suspenders catch any synchronous throw from the helper
    // (e.g. an unexpected runtime invariant violation) and fall back
    // to empty defaults rather than propagating to Next.js.
    let ctx: { ip: string; userAgent: string };
    try {
      ctx = extractRequestContext(request);
    } catch {
      ctx = { ip: '', userAgent: '' };
    }
    return runInRequestContext(ctx, async () => handler(request));
  };
};

export const GET: Handler = csrfWrap(handlers.GET);
export const POST: Handler = csrfWrap(handlers.POST);
