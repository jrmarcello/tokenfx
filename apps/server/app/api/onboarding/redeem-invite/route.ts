/**
 * POST /api/onboarding/redeem-invite — central-server-onboarding REQ-26 +
 * REQ-27 + REQ-28.
 *
 * Public, unauthenticated endpoint. The 64-hex `token` IN the body IS the
 * authentication credential — there is no Bearer header (the reporter does
 * not have credentials yet at this point in the flow). The middleware
 * matcher at `apps/server/middleware.ts` only covers `/manager/*`, so this
 * route is naturally exposed without an auth check.
 *
 * Composition order (matches REQ-27 step 0 → step 7):
 *
 *   1. Truncate IP for rate-limit + log purposes (`/24` IPv4, `/48` IPv6).
 *   2. Light raw-body extraction of the token (regex match — NOT a full
 *      Zod parse) so we can rate-limit on (token, 3/min) without doing the
 *      DoS-amplifying parse work first. If the raw body is missing a
 *      well-formed token field, only the (ip, 10/min) dimension applies.
 *   3. `checkRateLimits([ip, token])` — REQ-27 step 0. On rejection: 429 +
 *      `Retry-After`, NO redemption-log row, structured `logger.warn`.
 *   4. `JSON.parse` + Zod `.strict()` parse — REQ-26 + REQ-27 step 1. On
 *      rejection: 400 + generic body, NO redemption-log row, structured
 *      `logger.warn`. (DoS amplification protection: a flooding attacker
 *      otherwise fills the log table by spraying garbage.)
 *   5. `redeemInvite()` — REQ-27 steps 3..7 + REQ-28. Maps Result:
 *        - {ok:true}                            → 200 + `{key_id, secret, central_url, user_email}`
 *        - {ok:false, error.kind: 'token-*' | 'email-mismatch'} → 401 + uniform body
 *        - {ok:false, error.kind: 'infra'}      → 500 + sanitized body
 *
 * Body-size limit: Next.js App Router defaults to ~1MB JSON body (per
 * `next.config.ts` — no override here). A 10MB body (TC-F-06) is rejected
 * with 413 by the runtime BEFORE this handler executes; if it ever did
 * reach `req.json()` (e.g. a future config change), the JSON parse failure
 * is captured below and surfaces as a 400 — NOT a 500 with a stack.
 *
 * 401 body uniformity (TC-I-49 / TC-I-50): every token-rejection path emits
 * the EXACT same body bytes:
 *   `{ "error": { "message": "invalid or expired invite", "code": "unauthorized" } }`.
 * The internal `error.kind` is recorded in `onboarding_redemption_log` for
 * the audit trail (admin-visible), but never reflected in the HTTP body —
 * an attacker probing for "is this revoked or expired?" sees identical
 * bytes either way. The submitted token is NEVER echoed in any response
 * body (TC-I-50 / TC-F-09 invariant).
 *
 * Test seam: `__resetRedeemRouteState()` clears the in-memory rate limiter
 * so the route's integration tests start from a clean slate. Mirrors the
 * pattern used by `/api/ingest`'s `__resetRateLimiter`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { log as logger } from '@root/logger';
import { getDb } from '@/lib/db/client';
import { redeemInvite, type RedeemError } from '@/lib/queries/redeem';
import { truncateIpForAudit } from '@/lib/util/ip';
import {
  checkRateLimits,
  __resetRateLimits,
} from '@/lib/queries/rate-limit';

// --- Zod body schema (REQ-26) ------------------------------------------------
const REDEEM_BODY_SCHEMA = z
  .object({
    token: z.string().regex(/^[0-9a-f]{64}$/),
    machine_id: z.string().uuid(),
    hostname: z.string().min(1).max(255),
    claimed_email: z.string().email().min(3).max(254),
  })
  .strict();

// --- Generic error bodies ----------------------------------------------------
// Frozen so accidental mutation produces a TS error (defense-in-depth: the
// 401 byte-equality contract — TC-I-49 — relies on this object being
// stringified identically on every code path).
const GENERIC_401_BODY = Object.freeze({
  error: { message: 'invalid or expired invite', code: 'unauthorized' },
} as const);
const GENERIC_400_BODY = Object.freeze({
  error: { message: 'bad request', code: 'bad-request' },
} as const);
const GENERIC_500_BODY = Object.freeze({
  error: { message: 'server error', code: 'infra' },
} as const);

// --- Rate-limit dimensions (REQ-27 step 0) -----------------------------------
// Spec REQ-27: (ip_truncated_24, 10/min) AND (token, 3/min). These are
// hardcoded constants — if either threshold needs tuning, do it in the spec.
const RL_IP_LIMIT = 10;
const RL_TOKEN_LIMIT = 3;
const RL_WINDOW_MS = 60_000;

// --- Token-prefix regex for lightweight extraction ----------------------------
// We don't want to run the full Zod parse before rate-limiting (DoS reasoning
// from REQ-27: a flood of malformed-but-large bodies would amplify into a
// flood of Zod work). A literal-substring regex is dirt cheap and gives us
// the (token, 3/min) dimension on requests that DO carry a recognizable token
// field. Bodies without a recognizable token still get the (ip, 10/min) cap.
//
// The regex is deliberately permissive on whitespace ("token"\s*:\s*"…") so
// a JSON formatter doesn't defeat it. Only matches the exact 64-hex shape
// required by REQ-26's regex; non-hex bodies skip the token dimension.
const RAW_TOKEN_REGEX = /"token"\s*:\s*"([0-9a-f]{64})"/;

const extractRequestIp = (req: NextRequest): string | null => {
  // X-Forwarded-For wins (set by Vercel / Cloudflare / reverse proxies).
  // Take the FIRST entry — that's the original client per RFC 7239 spirit.
  const xff = req.headers.get('x-forwarded-for');
  if (xff !== null) {
    const first = xff.split(',')[0]?.trim();
    if (first && first.length > 0) return first;
  }
  const xri = req.headers.get('x-real-ip')?.trim();
  if (xri && xri.length > 0) return xri;
  return null;
};

const getCentralUrl = (): string => {
  const v = process.env.CENTRAL_URL;
  return v && v.length > 0 ? v : 'http://localhost:3232';
};

/**
 * Map every non-`infra` rejection kind to the SAME 401 body. Production code
 * uses this to keep the byte-equality invariant — there's no caller-visible
 * difference between revoked/expired/exhausted/email-mismatch/token-invalid.
 */
const isUniform401 = (kind: RedeemError['kind']): boolean =>
  kind === 'token-invalid' ||
  kind === 'token-revoked' ||
  kind === 'token-expired' ||
  kind === 'token-exhausted' ||
  kind === 'email-mismatch';

export const POST = async (req: NextRequest): Promise<NextResponse> => {
  // ---------------------------------------------------------------------------
  // Step 0a: extract IP (truncated to /24 or /48 — REQ-27 + REQ-2).
  // ---------------------------------------------------------------------------
  const rawIp = extractRequestIp(req);
  const requestIp = rawIp ? truncateIpForAudit(rawIp) : null;
  // Rate-limit key for the IP dimension. If we couldn't derive a truncated
  // IP from headers, use a constant placeholder so the limiter still applies
  // (otherwise an attacker who can strip XFF would bypass per-IP throttling).
  const ipKey = requestIp ?? 'unknown-ip';

  // ---------------------------------------------------------------------------
  // Step 0b: read raw body ONCE. We need the raw text both for the
  // lightweight token-extract pre-rate-limit AND for the eventual JSON parse
  // (Next's `req.json()` consumes the body — if we called it twice the
  // second call would throw "body already used"). Reading text first keeps
  // both passes cheap.
  //
  // If the read itself fails (rare — disconnected client, malformed
  // chunked encoding), surface 400. No DB write yet; matches the Zod-parse
  // failure path so the audit log's "request-shape rejected" semantics stay
  // consistent.
  // ---------------------------------------------------------------------------
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    logger.warn('redeem.body.read_failed', { ip_24: requestIp });
    return NextResponse.json(GENERIC_400_BODY, { status: 400 });
  }

  // ---------------------------------------------------------------------------
  // Step 0c: lightweight token extract for (token, 3/min) dimension.
  // Best-effort — bodies without a well-formed token still get the IP cap.
  // ---------------------------------------------------------------------------
  const tokenMatch = RAW_TOKEN_REGEX.exec(rawBody);
  const rawToken = tokenMatch !== null ? tokenMatch[1] : null;

  // ---------------------------------------------------------------------------
  // Step 0d: rate limit BEFORE Zod parse / DB work (REQ-27 step 0).
  // No log write on rejection (TC-I-33b — DoS amplification protection).
  // ---------------------------------------------------------------------------
  const dimensions = [
    {
      name: 'ip' as const,
      key: ipKey,
      limit: RL_IP_LIMIT,
      windowMs: RL_WINDOW_MS,
    },
    ...(rawToken !== null
      ? [
          {
            name: 'token' as const,
            key: rawToken,
            limit: RL_TOKEN_LIMIT,
            windowMs: RL_WINDOW_MS,
          },
        ]
      : []),
  ];
  const rl = checkRateLimits(dimensions);
  if (!rl.ok) {
    // Log to structured warn ONLY — never to the redemption log table.
    // Field set: ip_24, dimension, token_prefix (8 chars max — full token
    // is never logged anywhere). REQ-27.
    logger.warn('redeem.rate_limited', {
      ip_24: requestIp,
      dimension: rl.dimension,
      token_prefix: rawToken !== null ? rawToken.slice(0, 8) : null,
    });
    return NextResponse.json(
      { error: { message: 'too many requests', code: 'rate-limited' } },
      {
        status: 429,
        headers: { 'Retry-After': String(rl.retryAfterSec) },
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Step 1: JSON parse + Zod strict (REQ-26 + REQ-27 step 1).
  // ---------------------------------------------------------------------------
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    logger.warn('redeem.body.invalid_json', { ip_24: requestIp });
    return NextResponse.json(GENERIC_400_BODY, { status: 400 });
  }

  const parsed = REDEEM_BODY_SCHEMA.safeParse(parsedJson);
  if (!parsed.success) {
    // Count issues but don't echo them — Zod messages can leak field names
    // an attacker is probing. Generic body keeps the shape uniform across
    // all 400s (TC-I-50 spirit: never echo the submitted token).
    logger.warn('redeem.zod_failed', {
      ip_24: requestIp,
      zod_issue_count: parsed.error.issues.length,
    });
    return NextResponse.json(GENERIC_400_BODY, { status: 400 });
  }

  // ---------------------------------------------------------------------------
  // Step 2..7: invoke the redeem query. REQ-27 steps 3..7 + REQ-28 are
  // implemented inside `redeemInvite`; this layer only translates the
  // typed Result to HTTP.
  // ---------------------------------------------------------------------------
  const db = getDb();
  const result = await redeemInvite(db, {
    token: parsed.data.token,
    machineId: parsed.data.machine_id,
    hostname: parsed.data.hostname,
    claimedEmail: parsed.data.claimed_email,
    requestIp,
  });

  if (!result.ok) {
    if (isUniform401(result.error.kind)) {
      return NextResponse.json(GENERIC_401_BODY, { status: 401 });
    }
    // `infra` rejection — sanitize. Don't echo `error.cause`; it could
    // contain DB internals (REQ security rule: "Sanitize error messages
    // before surfacing them to the UI"). The `kind === 'infra'` narrow
    // gives TS access to the `cause` field that only exists on that branch
    // of the discriminated union.
    if (result.error.kind === 'infra') {
      const cause = result.error.cause;
      logger.error('redeem.infra_error', {
        ip_24: requestIp,
        // Logged server-side for diagnosis; never sent over the wire.
        // Stringify defensively so an Error subclass with circular refs
        // can't crash the logger.
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    return NextResponse.json(GENERIC_500_BODY, { status: 500 });
  }

  // Success — REQ-28 step 7. Plaintext `secret` is the only moment this
  // value exists outside bcrypt; the client is expected to write it
  // immediately to `data/reporter-config.json` (REQ-34 atomic write).
  return NextResponse.json({
    key_id: result.value.keyId,
    secret: result.value.secret,
    central_url: result.value.centralUrl ?? getCentralUrl(),
    user_email: result.value.userEmail,
  });
};

/**
 * Test-only: clear the in-memory rate-limiter state. Mirrors the
 * `__resetRateLimiter` pattern used by `/api/ingest`. Production code
 * never calls this.
 */
export const __resetRedeemRouteState = (): void => {
  __resetRateLimits();
};
