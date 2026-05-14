/**
 * Shared `extractExecRows` helper — REQ-13 / TASK-C4 in
 * `.specs/review-report-2026-05-14-fixes.md`.
 *
 * Drizzle's `db.execute(...)` returns different shapes depending on the
 * underlying driver:
 *   - postgres-js → `Row[]` (plain array)
 *   - pg          → `{ rows: Row[] }` (wrapper object)
 *
 * Prior to this module, ~11 query sites copy-pasted the same unwrap
 * (`Array.isArray(result) ? result : result.rows`). This helper centralizes
 * the narrowing.
 *
 * The `as Row[]` cast is intentional: `Array.isArray` narrows to `unknown[]`,
 * but the typed Row contract is enforced by the caller via the generic.
 * The DB layer is the trust boundary — Zod parses happen at the route /
 * ingestion boundaries, not on every query result.
 *
 * Throws `DriverShapeError` on unexpected shapes (post-self-review fix,
 * Security MEDIUM-2). Returning `[]` silently is unsafe: many callers
 * interpret empty results as "no rows found" (invite-not-found, etc.), so
 * a future driver upgrade that breaks the shape would surface as silent
 * data loss in security-relevant decisions instead of an actionable
 * health-check failure. Throw loud, fail fast.
 */

export class DriverShapeError extends Error {
  override readonly name = 'DriverShapeError';
  readonly receivedType: string;
  constructor(receivedType: string) {
    super(
      `extractExecRows: unexpected DB result shape (received ${receivedType}). ` +
        `Expected Row[] or { rows: Row[] }. A driver upgrade may have changed ` +
        `the contract.`,
    );
    this.receivedType = receivedType;
  }
}

export const extractExecRows = <Row>(result: unknown): Row[] => {
  if (Array.isArray(result)) return result as Row[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows: unknown }).rows;
    if (Array.isArray(rows)) return rows as Row[];
  }
  throw new DriverShapeError(typeof result);
};
