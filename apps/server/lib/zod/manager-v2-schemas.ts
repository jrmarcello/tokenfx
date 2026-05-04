/**
 * Zod schemas for manager-dashboard-v2 (REQ-14, REQ-17, REQ-22 dismiss).
 *
 * These shapes are the SINGLE SOURCE OF TRUTH for runtime validation at the
 * route / Server Component boundary. Route handlers call `.safeParse(...)`
 * and translate failures to HTTP responses (or `redirect(...)`):
 *   - drilldownParamsSchema  → drives REQ-14 (drilldown query params)
 *   - paginationSchema       → drives REQ-17 (`/me/visibility?page=N`)
 *   - dismissAnomalySchema   → drives REQ-22 (`POST /api/manager/dismiss-anomaly`)
 *
 * Locks documented in the spec:
 *   - REQ-14 reason enum is case-sensitive and closed (TC-U-22..24).
 *   - REQ-14 `reasonText` is required ONLY when `reason='other'` and must be
 *     10..500 chars (TC-U-25..28).
 *   - TC-U-36: when `reason !== 'other'`, an extra `reasonText` is silently
 *     accepted/ignored — NOT a 400. The drilldown schema therefore declares
 *     `reasonText` as optional and only enforces presence + length via
 *     `superRefine` when `reason === 'other'`.
 */
import { z } from 'zod';

/** Closed enum of audit reasons. Order is the canonical presentation order. */
export const REASON_ENUM = [
  'training-check',
  'quota-investigation',
  'cost-investigation',
  'other',
] as const;

export type ReasonTag = (typeof REASON_ENUM)[number];

/**
 * Single reason-tag value. Case-sensitive; values outside the enum are
 * rejected (TC-U-22..24).
 */
export const reasonTagSchema = z.enum(REASON_ENUM);

/**
 * Free-text complement for `reason='other'`. 10..500 chars inclusive
 * (TC-U-25..28). Validated independently of the drilldown shape so it can be
 * reused by other entry points (e.g. a future PATCH endpoint).
 */
export const reasonTextSchema = z.string().min(10).max(500);

/**
 * Drilldown query params (Server Component reads from `searchParams`).
 *
 *   - `reason`: required, must be in `REASON_ENUM` (case-sensitive).
 *   - `reasonText`: required ONLY when `reason='other'`; 10..500 chars.
 *     When `reason !== 'other'`, `reasonText` is ALLOWED but IGNORED — silent
 *     acceptance per TC-U-36 lock. Downstream callers should NOT persist
 *     `reasonText` unless `reason === 'other'`.
 *   - `devId`: required, must be a valid UUID.
 *
 * The conditional requirement on `reasonText` is enforced via `superRefine`
 * because it depends on the value of a sibling field. We attach the issue at
 * `path: ['reasonText']` so the route handler can map it to the
 * `?error=missing-reason-text` / `?error=invalid-reason-text` redirect
 * branches (TC-I-22, TC-I-23, TC-I-25).
 */
export const drilldownParamsSchema = z
  .object({
    reason: reasonTagSchema,
    // Untyped at the object level so non-'other' callers can pass any string
    // (including a short one) without triggering a length error — the
    // TC-U-36 silent-ignore lock. The 10..500 length check is applied
    // conditionally below via `superRefine` when `reason === 'other'`.
    reasonText: z.string().optional(),
    devId: z.string().uuid(),
  })
  .superRefine((val, ctx) => {
    if (val.reason !== 'other') return;
    const parsed = reasonTextSchema.safeParse(val.reasonText);
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'reasonText required (10..500 chars) when reason=other',
        path: ['reasonText'],
      });
    }
  });

export type DrilldownParams = z.infer<typeof drilldownParamsSchema>;

/**
 * Pagination shape for `/me/visibility?page=N` (REQ-17). 1-indexed.
 *   - Missing `page` defaults to 1.
 *   - `page <= 0` is rejected (TC-I-71, TC-I-72).
 *   - Numeric strings are coerced (`?page=2` arrives as a string).
 */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
});

export type PaginationParams = z.infer<typeof paginationSchema>;

/**
 * POST body for `/api/manager/dismiss-anomaly` (REQ-22 dismiss).
 *
 *   - `target_user_id`: UUID of the dev whose anomaly is being dismissed.
 *   - `kind`: anomaly kind string (e.g. `spend-spike-30d`). Non-empty —
 *     finer validation against the closed CHECK constraint happens at the
 *     DB layer.
 *
 * `.strict()` rejects unknown fields so an attacker can't smuggle extra
 * columns through the route into the DB writer (TC-I-75 + the `.strict()`
 * extra-field rejection case in the test plan).
 */
export const dismissAnomalySchema = z
  .object({
    target_user_id: z.string().uuid(),
    kind: z.string().min(1),
  })
  .strict();

export type DismissAnomalyBody = z.infer<typeof dismissAnomalySchema>;
