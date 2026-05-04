/**
 * POST /api/manager/dismiss-anomaly — manager-dashboard-v2 REQ-22 (dismiss).
 *
 * Writes / refreshes a row in `manager_dismissed_anomalies` so the manager's
 * UI can suppress a (target_user_id, kind) anomaly card for 7 days. Auth-gated:
 * only `manager` and `admin` roles in the same org as the target user are
 * allowed to dismiss; everything else is a 403.
 *
 * Idempotent on `(org_id, manager_user_id, target_user_id, kind)` — re-submits
 * UPDATE the existing row, extending `dismissed_until` to a fresh now+7d. Row
 * count never grows past 1 for the same tuple (TC-I-76).
 *
 * Cross-org guard (TC-I-78): `target_user_id` is looked up in `users` and its
 * `org_id` MUST equal the manager's session `orgId`. A mismatch (or unknown
 * user) is a 403 — same status as the role gate so an attacker probing for
 * "is this user in another org?" cannot distinguish between "wrong org" and
 * "not enough role" via the response.
 *
 * Test seam: production code uses `auth()` from `@/lib/auth/auth`; tests call
 * `dismissAnomalyImpl(req, { authFn: stubAuth(...) })` directly with a stub
 * session function so vitest never has to drag NextAuth into its module
 * graph. Same pattern as `app/manager/invites/actions.ts`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import type { Session } from 'next-auth';
import { getDb } from '@/lib/db/client';
import { managerDismissedAnomalies, users } from '@/lib/db/schema';
import { dismissAnomalySchema } from '@/lib/zod/manager-v2-schemas';

const DISMISS_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const FORBIDDEN_BODY = Object.freeze({
  error: { message: 'forbidden', code: 'forbidden' },
} as const);
const BAD_REQUEST_BODY = Object.freeze({
  error: { message: 'bad request', code: 'bad-request' },
} as const);

export type AuthFn = () => Promise<Session | null>;

export type DismissAnomalyImplDeps = {
  authFn: AuthFn;
};

/**
 * Pure-ish core. Tests inject `authFn`; production wraps with a lazy
 * `auth()` import so vitest doesn't pull NextAuth in.
 */
export const dismissAnomalyImpl = async (
  req: NextRequest | Request,
  deps: DismissAnomalyImplDeps,
): Promise<Response> => {
  // 1. AuthN/Z: require manager or admin role with a non-null orgId/userId.
  const session = await deps.authFn();
  const role = session?.user?.role;
  const orgId = session?.user?.orgId;
  const managerUserId = session?.user?.id;
  if (!managerUserId || !orgId || (role !== 'manager' && role !== 'admin')) {
    return NextResponse.json(FORBIDDEN_BODY, { status: 403 });
  }

  // 2. Body parse + Zod `.strict()` — rejects missing fields AND unknown
  // fields (TC-I-75). A non-JSON body lands as null and fails the Zod
  // parse with a 400 — never a 500.
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(BAD_REQUEST_BODY, { status: 400 });
  }
  const parsed = dismissAnomalySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(BAD_REQUEST_BODY, { status: 400 });
  }
  const { target_user_id: targetUserId, kind } = parsed.data;

  // 3. Cross-org guard (TC-I-78): the target dev MUST belong to the
  // manager's org. Same 403 status as the role gate to avoid an
  // information leak about user-existence in other orgs.
  const db = getDb();
  const [target] = await db
    .select({ orgId: users.orgId })
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1);
  if (!target || target.orgId !== orgId) {
    return NextResponse.json(FORBIDDEN_BODY, { status: 403 });
  }

  // 4. UPSERT: idempotent on (org_id, manager_user_id, target_user_id, kind).
  // ON CONFLICT extends `dismissed_until` to a fresh now+7d AND refreshes
  // `dismissed_at` so the audit trail reflects the latest action.
  const dismissedUntil = new Date(Date.now() + DISMISS_DURATION_MS);
  await db
    .insert(managerDismissedAnomalies)
    .values({
      orgId,
      managerUserId,
      targetUserId,
      kind,
      dismissedUntil,
    })
    .onConflictDoUpdate({
      target: [
        managerDismissedAnomalies.orgId,
        managerDismissedAnomalies.managerUserId,
        managerDismissedAnomalies.targetUserId,
        managerDismissedAnomalies.kind,
      ],
      set: {
        dismissedUntil,
        dismissedAt: sql`now()`,
      },
    });

  return NextResponse.json({ ok: true });
};

/**
 * Lazy-loaded `auth()` — keeps NextAuth out of vitest's module graph for
 * unit tests that import `dismissAnomalyImpl` directly. Mirrors the
 * pattern in `app/manager/invites/actions.ts`.
 */
const lazyDefaultAuth: AuthFn = async () => {
  const mod = await import('@/lib/auth/auth');
  return mod.auth();
};

export const POST = (req: NextRequest): Promise<Response> =>
  dismissAnomalyImpl(req, { authFn: lazyDefaultAuth });
