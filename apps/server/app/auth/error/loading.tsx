/**
 * Minimal loading state for `/auth/error`. The page does no async work
 * (the audit-row write happens out-of-band in `auth.ts`'s logger hook),
 * so this is effectively never seen — returning null is correct.
 */
export default function Loading() {
  return null;
}
