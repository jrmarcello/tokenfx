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
import { revalidatePath } from 'next/cache';
import { eq, sql } from 'drizzle-orm';
import { auth } from '@/lib/auth/auth';
import { getDb } from '@/lib/db/client';
import { managerDismissedAnomalies, users } from '@/lib/db/schema';
import { dismissAnomalySchema } from '@/lib/zod/manager-v2-schemas';

const DISMISS_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export type DismissResult =
  | { ok: true }
  | { ok: false; code: 'forbidden' | 'invalid_input' };

export const dismissAnomalyAction = async (
  formData: FormData,
): Promise<DismissResult> => {
  const session = await auth();
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

  const db = getDb();
  const [target] = await db
    .select({ orgId: users.orgId })
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1);
  if (!target || target.orgId !== orgId) {
    return { ok: false, code: 'forbidden' };
  }

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

  revalidatePath('/manager/health');
  return { ok: true };
};

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

