'use server';

/**
 * Server Actions scoped to `/manager` (overview page) — TASK-17, REQ-1.
 *
 * Currently exposes the acknowledgement action for the first-auto-provision
 * banner. The banner is rendered by the dashboard page (`/manager`), so the
 * action lives in `app/manager/actions.ts` rather than a deeper subroute —
 * the page is its sole caller today.
 *
 * Pattern mirrors `app/manager/health/dismiss-action.ts`:
 *   - Pure-ish `Impl` core with injected `authFn` + `revalidatePathFn` so
 *     unit tests never have to drag NextAuth or the static-generation store
 *     into vitest's module graph.
 *   - Thin production wrapper applies `lazyDefaultAuth` + the real
 *     `revalidatePath`.
 *   - A `formAction` adapter swallows the Result so `<form action={...}>`
 *     (void return signature) is happy.
 *
 * Role enforcement: defense-in-depth on top of the `/manager/*` middleware
 * gate — `manager | admin` only. Member-role callers get
 * `{ ok: false, code: 'unauthorized' }`.
 *
 * Idempotency: `acknowledgeAlert` is an UPSERT with `ON CONFLICT DO NOTHING`,
 * so repeated submits (e.g. double-click) are silent no-ops. The forensic
 * invariant (first acked_at preserved) is enforced at the DB layer.
 */
import { revalidatePath as nextRevalidatePath } from 'next/cache';
import { z } from 'zod';
import type { Session } from 'next-auth';
import { getDb } from '@/lib/db/client';
import { acknowledgeAlert } from '@/lib/queries/manager-alerts';

// ---------------------------------------------------------------------------
// Zod schema — boundary validation. `.strict()` would over-reject because
// FormData submits arbitrary fields; we extract only `event_id` and coerce
// it to a positive int.
// ---------------------------------------------------------------------------

const ackSchema = z.object({
  event_id: z.coerce.number().int().positive(),
});

// ---------------------------------------------------------------------------
// Types — exported so the *Impl is testable.
// ---------------------------------------------------------------------------

export type AuthFn = () => Promise<Session | null>;

export type AcknowledgeFirstAutoProvisionResult =
  | { ok: true }
  | { ok: false; code: 'unauthorized' | 'invalid_input' };

export type AcknowledgeFirstAutoProvisionImplDeps = {
  authFn: AuthFn;
  /**
   * `revalidatePath` requires a Next.js request context (static generation
   * store) which vitest does not provide. DI seam mirrors the
   * `dismissAnomalyImpl` pattern.
   */
  revalidatePathFn: (path: string) => void;
  /** Allows tests to swap in a stub instead of touching Postgres. */
  acknowledgeFn?: (
    db: ReturnType<typeof getDb>,
    managerId: string,
    kind: 'first-auto-provision',
    eventId: number,
    orgId: string,
  ) => Promise<void>;
  /** Test seam — defaults to the real `getDb()` */
  db?: ReturnType<typeof getDb>;
};

// ---------------------------------------------------------------------------
// Pure-ish core.
// ---------------------------------------------------------------------------

export const acknowledgeFirstAutoProvisionImpl = async (
  formData: FormData,
  deps: AcknowledgeFirstAutoProvisionImplDeps,
): Promise<AcknowledgeFirstAutoProvisionResult> => {
  const session = await deps.authFn();
  const role = session?.user?.role;
  const userId = session?.user?.id;
  const orgId = session?.user?.orgId;
  // Defensive narrow: a session with a manager/admin role ALWAYS carries
  // orgId in our auth.config wiring, but the typed narrow eliminates a
  // class of "what if orgId is missing" bugs at the call site below.
  // Returning `unauthorized` keeps the response shape identical to the
  // other auth-narrow failures (no info-leak about session shape).
  if (!userId || !orgId || (role !== 'manager' && role !== 'admin')) {
    return { ok: false, code: 'unauthorized' };
  }

  const parsed = ackSchema.safeParse({
    event_id: formData.get('event_id'),
  });
  if (!parsed.success) {
    return { ok: false, code: 'invalid_input' };
  }

  const ack = deps.acknowledgeFn ?? acknowledgeAlert;
  const db = deps.db ?? getDb();
  // `orgId` flows into the query so the WHERE EXISTS predicate can
  // reject tampered form payloads pointing to cross-org event_ids
  // (silent ignore — see security context in
  // .specs/fix-manager-alert-ack-org-scoping.md).
  await ack(db, userId, 'first-auto-provision', parsed.data.event_id, orgId);

  deps.revalidatePathFn('/manager');
  return { ok: true };
};

// ---------------------------------------------------------------------------
// Production wrapper.
// ---------------------------------------------------------------------------

const lazyDefaultAuth: AuthFn = async () => {
  const mod = await import('@/lib/auth/auth');
  return mod.auth();
};

export const acknowledgeFirstAutoProvisionAction = async (
  formData: FormData,
): Promise<AcknowledgeFirstAutoProvisionResult> =>
  acknowledgeFirstAutoProvisionImpl(formData, {
    authFn: lazyDefaultAuth,
    revalidatePathFn: nextRevalidatePath,
  });

/**
 * Form-action adapter for `<form action={...}>` consumers (must return void).
 * Result is swallowed; `revalidatePath` (already called on the happy path)
 * refreshes the banner state on next render. Unauthorized / invalid_input
 * silently no-op — the defense-in-depth gate already prevents non-managers
 * from seeing the form.
 */
export const acknowledgeFirstAutoProvisionFormAction = async (
  formData: FormData,
): Promise<void> => {
  await acknowledgeFirstAutoProvisionAction(formData);
};
