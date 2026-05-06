'use server';

/**
 * Server Action: dismiss a (target_user_id, kind) anomaly card for 7 days.
 *
 * Used by the secondary CTA on `<CheckInCard>` and `<DropoffCard>` on
 * `/manager/health`. Performs the same UPSERT semantics as
 * `POST /api/manager/dismiss-anomaly` (REQ-22):
 *
 *   - manager / admin role required (defense-in-depth on top of the
 *     `/manager/*` layout role gate)
 *   - cross-org guard: target user MUST belong to the manager's org
 *   - idempotent on (org_id, manager_user_id, target_user_id, kind);
 *     repeated submits extend `dismissed_until` to a fresh now+7d
 *
 * After the upsert it `revalidatePath('/manager/health')` so the cards
 * disappear from the next render — Server Components will re-execute the
 * `getCheckInOpportunities` / `getDropOffCandidates` queries which already
 * filter active dismissals.
 *
 * The form layer in the cards always submits a hidden `targetUserId` and
 * `kind`. We re-validate both with Zod here because Server Actions accept
 * raw FormData and we never trust client-controlled fields.
 */
import { revalidatePath as nextRevalidatePath } from 'next/cache';
import type { Session } from 'next-auth';
import { getDb } from '@/lib/db/client';
import { performDismissAnomaly } from '@/lib/queries/manager-dismissed';
import { dismissAnomalySchema } from '@/lib/zod/manager-v2-schemas';

export type DismissResult =
  | { ok: true }
  | { ok: false; code: 'forbidden' | 'invalid_input' };

export type AuthFn = () => Promise<Session | null>;

export type DismissAnomalyImplDeps = {
  authFn: AuthFn;
  /**
   * `revalidatePath` requires a Next.js request context (static generation
   * store) which vitest does not provide. The DI seam lets tests pass a
   * no-op while production keeps the real revalidation. Mirrors the
   * `notifyChannel`/`afterFn` seam pattern from `_drilldown/render.tsx`.
   */
  revalidatePathFn: (path: string) => void;
};

/**
 * Pure-ish core. Tests inject `authFn` + `revalidatePathFn` so vitest
 * never has to drag NextAuth or the static-generation store into its
 * module graph. Mirrors the `dismissAnomalyImpl` pattern in
 * `app/api/manager/dismiss-anomaly/route.ts`. (Self-review M-code: this
 * replaces the earlier `vi.mock`-based test approach with the same DI
 * seam pattern the rest of the codebase already uses.)
 */
export const dismissAnomalyImpl = async (
  formData: FormData,
  deps: DismissAnomalyImplDeps,
): Promise<DismissResult> => {
  const session = await deps.authFn();
  const role = session?.user?.role;
  const orgId = session?.user?.orgId;
  const managerUserId = session?.user?.id;
  if (!managerUserId || !orgId || (role !== 'manager' && role !== 'admin')) {
    return { ok: false, code: 'forbidden' };
  }

  const raw = {
    target_user_id: formData.get('targetUserId'),
    kind: formData.get('kind'),
  };
  const parsed = dismissAnomalySchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, code: 'invalid_input' };
  }
  const { target_user_id: targetUserId, kind } = parsed.data;

  // Delegate to the shared helper. `performDismissAnomaly` owns the
  // cross-org guard + UPSERT + DISMISS_DURATION_MS — single source of
  // truth (REQ-4 of manager-dashboard-v2-followups). DB errors throw
  // (helper contract); we don't catch — Server Action runtime surfaces
  // a 500 and the form re-renders, which is the right UX for an
  // infrastructure failure.
  const result = await performDismissAnomaly(getDb(), {
    orgId,
    managerUserId,
    targetUserId,
    kind,
  });
  if (!result.ok) {
    // `cross-org` from the helper maps to `forbidden` at this surface
    // (same status the role gate uses, anti-probing).
    return { ok: false, code: 'forbidden' };
  }

  deps.revalidatePathFn('/manager/health');
  return { ok: true };
};

/**
 * Lazy-loaded `auth()` — keeps NextAuth out of vitest's module graph for
 * unit tests that import `dismissAnomalyImpl` directly. Same pattern as
 * `app/api/manager/dismiss-anomaly/route.ts:lazyDefaultAuth`.
 */
const lazyDefaultAuth: AuthFn = async () => {
  const mod = await import('@/lib/auth/auth');
  return mod.auth();
};

export const dismissAnomalyAction = async (
  formData: FormData,
): Promise<DismissResult> =>
  dismissAnomalyImpl(formData, {
    authFn: lazyDefaultAuth,
    revalidatePathFn: nextRevalidatePath,
  });

/**
 * Form-action adapter for `<form action={...}>` consumers.
 *
 * `<form action>` requires the action signature to be
 * `(formData: FormData) => void | Promise<void>` — it does not accept a
 * non-void return. We swallow the `DismissResult` here and rely on
 * `revalidatePath` (already called inside `dismissAnomalyAction` on the
 * happy path) to refresh the cards. Forbidden / invalid-input results
 * silently no-op the form: the page re-renders with the same data, which
 * is the correct UX for a defense-in-depth gate that the layout already
 * enforces (a non-manager would not see the form in the first place).
 */
export const dismissAnomalyFormAction = async (
  formData: FormData,
): Promise<void> => {
  await dismissAnomalyAction(formData);
};

