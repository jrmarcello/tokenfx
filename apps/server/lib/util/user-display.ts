/**
 * Presentation helper for rendering a user's display label.
 *
 * Belongs under `lib/util/` (presentation helpers, not auth-concern).
 * `lib/auth/` is reserved for the auth pipeline — hashing, token
 * validation, role narrowing. `displayLabelFor` is presentation, NOT auth,
 * so `lib/util/` is the correct home.
 *
 * Used by:
 *   - `/manager/health` check-in cards (REQ-11)
 *   - `/manager/health` drop-off cards (REQ-12)
 *   - `/me/visibility` audit log
 *   - the manager nav
 *
 * The fallback chain mirrors REQ-18's SQL-side ordering expression
 * `COALESCE(users.display_name, split_part(users.email, '@', 1))`, so the
 * label rendered in the UI is identical to the key the database sorts by.
 */

export type UserForDisplay = {
  display_name: string | null | undefined;
  email: string; // guaranteed non-null by the `users` table schema
};

/**
 * Centralized fallback chain for rendering a user's display label.
 *
 * Resolution order:
 *   1. `display_name` if it is a non-empty, non-whitespace-only string.
 *   2. Email local-part (`split_part(email, '@', 1)` equivalent).
 *   3. Whole `email` string if there is no `@` sign (defensive — should
 *      never happen because the schema requires a valid email, but keeps
 *      the helper total).
 *
 * Always returns a non-empty string because `email` is NOT NULL at the
 * DB layer.
 *
 * @example
 *   displayLabelFor({ display_name: 'Alice', email: 'a@x.com' })   // 'Alice'
 *   displayLabelFor({ display_name: null,    email: 'a@x.com' })   // 'a'
 *   displayLabelFor({ display_name: '   ',   email: 'a@x.com' })   // 'a'
 */
export const displayLabelFor = (user: UserForDisplay): string => {
  if (user.display_name && user.display_name.trim() !== '') {
    return user.display_name;
  }
  // Fallback: email local-part. Email is guaranteed non-null by schema.
  const at = user.email.indexOf('@');
  return at > 0 ? user.email.slice(0, at) : user.email;
};
