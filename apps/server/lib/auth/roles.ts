/**
 * Shared role typing + narrowing for the manager UI auth gate.
 *
 * Lives in its own module (NOT inside `auth.ts`) so the Edge-safe
 * `auth.config.ts` can import it without pulling the Drizzle/`pg` graph
 * that lives in `auth.ts`. Pure types + a string check — no runtime
 * dependencies — so it's safe in Edge middleware.
 *
 * REQ-16/17: `member` is the default for any newly upserted user;
 * members are blocked from `/manager/*` by middleware. `manager` may
 * read manager pages; `admin` may additionally hit `/manager/admin/*`.
 */
export type Role = 'member' | 'manager' | 'admin';

export const isRole = (value: unknown): value is Role =>
  value === 'member' || value === 'manager' || value === 'admin';
