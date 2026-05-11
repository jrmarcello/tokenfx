/**
 * GET /api/health — central-server-onboarding REQ-37.
 *
 * Two operating modes:
 *
 *   Liveness mode (no Authorization header AND no `key_id` query param):
 *     Always 200 `{ok: true, server_time: <ISO8601>}`. Anyone can probe.
 *     Used by `pnpm reporter:setup` pre-flight (REQ-32) to confirm the
 *     central URL is reachable before sending the redeem request.
 *
 *   Credential validation mode (Authorization: Bearer header AND
 *   `?key_id=k_xxx` query param):
 *     Looks up `secret_hash` by `key_id`, runs bcrypt.compare via the
 *     shared 60s plaintext cache. 200 if valid, 401 otherwise. Used by the
 *     reporter to confirm a freshly-redeemed credential before writing
 *     `data/reporter-config.json`.
 *
 * Why `key_id` is mandatory in credential-validation mode:
 *   Without it, the server would have to bcrypt-scan every `user_machines`
 *   row to determine validity — O(n) bcrypt calls, easy DoS amplifier.
 *   With `key_id`, the lookup is O(1). If a request carries an
 *   Authorization header but no `key_id`, we return 400 (not 401) to make
 *   the misuse explicit.
 *
 * Rate limit on credential-validation mode: same 10/min/(ip_truncated_24)
 * as the redeem endpoint. Without it, a stolen Bearer could be probed for
 * liveness here before being used elsewhere. Liveness mode is unrestricted
 * — it carries no secret-validity oracle.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { userMachines } from '@/lib/db/schema';
import {
  parseBearerAuthorization,
  verifyKeySecret,
} from '@/lib/auth/bearer-auth';
import { checkRateLimits, __resetRateLimits } from '@/lib/queries/rate-limit';
import { truncateIpForAudit } from '@/lib/util/ip';

// --- Rate limiter ------------------------------------------------------------
// True sliding-window via the shared `checkRateLimits` helper from
// `lib/queries/rate-limit.ts`. We only limit credential-validation mode
// (single 'ip' dimension at 10/min); liveness mode is unrestricted by
// design. The 'token' dimension is not used here — health endpoint has
// no token analogue to throttle.
const HEALTH_IP_LIMIT = 10;
const HEALTH_IP_WINDOW_MS = 60_000;

const errorBody = (
  message: string,
  code?: string,
): { error: { message: string; code?: string } } =>
  code ? { error: { message, code } } : { error: { message } };

const livenessOk = (): NextResponse =>
  NextResponse.json({ ok: true, server_time: new Date().toISOString() });

export const GET = async (req: NextRequest): Promise<NextResponse> => {
  const url = new URL(req.url);
  const keyId = url.searchParams.get('key_id');
  const authHeader = req.headers.get('authorization');

  // --- Liveness mode --------------------------------------------------------
  // Neither auth header nor key_id → unrestricted health probe.
  if (authHeader === null && keyId === null) {
    return livenessOk();
  }

  // --- Mixed states ---------------------------------------------------------
  // Authorization without key_id is the explicit error case (REQ-37): we want
  // to reject it as 400 to prevent O(n) bcrypt scans. The user agent
  // typed the request wrong, not the credentials.
  if (authHeader !== null && keyId === null) {
    return NextResponse.json(
      errorBody(
        'key_id query param required for credential validation',
        'bad-request',
      ),
      { status: 400 },
    );
  }

  // key_id without Authorization → 401 (the caller asked us to validate a
  // credential they didn't provide). We don't degrade to liveness here
  // because the URL contains a `key_id` — the caller's intent is clearly
  // to verify credentials.
  if (authHeader === null && keyId !== null) {
    return NextResponse.json(errorBody('unauthorized', 'unauthorized'), {
      status: 401,
    });
  }

  // --- Credential validation mode ------------------------------------------
  // Both authHeader and keyId are non-null at this point.
  // Apply rate limit BEFORE any auth work so a flood of bad requests can't
  // make us fan out bcrypt calls.
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip')?.trim() ??
    null;
  const rlKey = (ip ? truncateIpForAudit(ip) : null) ?? 'unknown-ip';
  const rateLimitResult = checkRateLimits([
    {
      name: 'ip',
      key: rlKey,
      limit: HEALTH_IP_LIMIT,
      windowMs: HEALTH_IP_WINDOW_MS,
    },
  ]);
  if (!rateLimitResult.ok) {
    return NextResponse.json(errorBody('rate limit exceeded'), {
      status: 429,
      headers: { 'Retry-After': String(rateLimitResult.retryAfterSec) },
    });
  }

  const bearer = parseBearerAuthorization(authHeader);
  if (!bearer.ok) {
    return NextResponse.json(errorBody('unauthorized', 'unauthorized'), {
      status: 401,
    });
  }

  const db = getDb();
  // We're in credential-validation mode; keyId is non-null thanks to the
  // earlier branches. TypeScript can't carry that narrowing across the
  // intermediate awaits, so we re-check explicitly (a structural narrow,
  // not a type assertion — the `if` is actually unreachable, but it
  // documents the invariant and stays type-safe under future refactors).
  if (keyId === null) {
    return NextResponse.json(errorBody('unauthorized', 'unauthorized'), {
      status: 401,
    });
  }
  const lookupKeyId: string = keyId;
  const [machine] = await db
    .select({
      secretHash: userMachines.secretHash,
      revokedAt: userMachines.revokedAt,
    })
    .from(userMachines)
    .where(eq(userMachines.keyId, lookupKeyId))
    .limit(1);

  if (!machine || machine.revokedAt !== null) {
    return NextResponse.json(errorBody('unauthorized', 'unauthorized'), {
      status: 401,
    });
  }

  const ok = await verifyKeySecret(
    lookupKeyId,
    bearer.value,
    machine.secretHash,
  );
  if (!ok) {
    return NextResponse.json(errorBody('unauthorized', 'unauthorized'), {
      status: 401,
    });
  }

  return NextResponse.json({ ok: true, server_time: new Date().toISOString() });
};

/**
 * Test-only export: clears the rate-limit bucket so successive tests don't
 * trip the limiter on each other. The auth cache is reset via
 * `__resetIngestAuthCache` from `lib/auth/bearer-auth`.
 */
export const __resetHealthRateLimit = (): void => {
  __resetRateLimits();
};
