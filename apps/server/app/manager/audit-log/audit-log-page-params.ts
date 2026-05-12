/**
 * Pure TS sibling of `page.tsx` — holds the search-params Zod schema +
 * its supporting constants. Extracted so `parseAuditLogSearchParams` is
 * unit-testable without spinning up the Next.js Server Component runtime
 * (see `.specs/sso-test-coverage-orphans.md` REQ-2 / TC-U-02a..h).
 *
 * Single source of truth for the `/manager/audit-log` query-string
 * contract; `page.tsx` imports everything it needs from here.
 */
import { z } from 'zod';

/** Mirrors the `auth_event_log_outcome_check` CHECK constraint in schema.ts. */
export const OUTCOME_VALUES = [
  'accepted-sso-auto',
  'rejected-public-domain',
  'rejected-multiple-matches',
  'rejected-no-match',
  'rejected-race',
  'rejected-csrf',
  'rejected-replay',
  'rejected-cross-idp',
  'rejected-pre-existing-binding',
  'email-not-verified',
] as const;

export type AuditLogOutcome = (typeof OUTCOME_VALUES)[number];

/** Filter string field cap (iss, city, browser). */
export const MAX_TEXT_LEN = 200;

/**
 * Pagination index ceiling for the audit-log page. NOT related to the
 * CSV export's 10k-row cap — those are independent limits at different
 * routes.
 */
export const MAX_PAGE = 10_000;

/** Audit-log page rows-per-page. */
export const PAGE_SIZE = 50;

/**
 * Single source of truth for query-string parsing. `.catch(undefined)` /
 * `.catch(0)` makes every field bullet-proof against malformed input: the
 * page renders the first results page silently rather than surfacing a 4xx.
 *
 * Because EVERY field has `.catch()`, `auditLogSearchParamsSchema.parse(...)`
 * NEVER throws — callers can use `.parse()` directly (no need for
 * `.safeParse()`).
 */
export const auditLogSearchParamsSchema = z.object({
  // `.default(0)` engages when the page key is absent or undefined
  // (Next.js delivers `{}` for a URL with no query string, and
  // `flattenSearchParams` in page.tsx normalises missing keys to
  // `undefined`). `.catch(0)` then handles validation failures
  // (non-numeric, negative, >MAX_PAGE, fractional). Output type
  // stays `number` — no `| undefined` leak to the caller.
  page: z
    .coerce.number()
    .int()
    .min(0)
    .max(MAX_PAGE)
    .default(0)
    .catch(0),
  outcome: z
    .enum(OUTCOME_VALUES)
    .optional()
    .catch(undefined),
  iss: z
    .string()
    .max(MAX_TEXT_LEN)
    .optional()
    .catch(undefined),
  city: z
    .string()
    .max(MAX_TEXT_LEN)
    .optional()
    .catch(undefined),
  browser: z
    .string()
    .max(MAX_TEXT_LEN)
    .optional()
    .catch(undefined),
  from: z
    .string()
    .datetime({ offset: true })
    .optional()
    .catch(undefined),
  to: z
    .string()
    .datetime({ offset: true })
    .optional()
    .catch(undefined),
});

export type AuditLogSearchParams = z.infer<typeof auditLogSearchParamsSchema>;

/**
 * Convenience wrapper around `auditLogSearchParamsSchema.parse(raw)`.
 *
 * Accepts the raw `searchParams` shape Next.js delivers — `Record<string,
 * string | string[] | undefined>` — and returns the typed, defaulted
 * result. NEVER throws (every field has `.catch()`).
 */
export const parseAuditLogSearchParams = (
  raw: Record<string, string | string[] | undefined>,
): AuditLogSearchParams => auditLogSearchParamsSchema.parse(raw);
