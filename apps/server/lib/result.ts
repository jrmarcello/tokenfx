/**
 * Canonical Result<T, E> discriminated union for apps/server.
 *
 * Used at module boundaries where errors are anticipated and typed
 * (e.g., `sendEmail` returns `Result<EmailResult, EmailError>`, not throw).
 *
 * Mirrors the root tokenfx `lib/result.ts` shape — duplicated here because
 * apps/server is a separate package (different tsconfig + module resolution).
 */
export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

/** Constructor for the ok branch. Pure helper for ergonomic call-site use. */
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

/** Constructor for the error branch. */
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
