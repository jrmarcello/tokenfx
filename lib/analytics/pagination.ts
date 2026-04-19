import { z } from 'zod';

/**
 * Pure pagination state computation. Takes the raw `offset` from a URL
 * searchParam plus the total row count, returns everything the UI needs
 * to render the Prev/Next controls and the "N rows · exibindo A–B" label.
 *
 * See `.specs/sessions-pagination.md` for the REQ contract — notably:
 *
 * - REQ-5a: silent clamp for negative / non-numeric / >10k offsets → 0.
 * - REQ-5b: explicit overflow (offset >= total && total > 0) surfaces via
 *   `overflow: true` so the page can render a "back to page 1" CTA instead
 *   of a list.
 * - REQ-9: `pageSize` default 25 — mirrors `listSessions` default.
 *
 * Integer, non-negative, capped at 10_000 to keep SQL OFFSET sane.
 * `.catch(0)` swallows every validation failure into the default — no
 * throws, no redirects, no banner.
 */

const offsetSchema = z.coerce.number().int().min(0).max(10_000).catch(0);

export type ComputePaginationInput = {
  rawOffset: string | undefined;
  total: number;
  pageSize?: number; // default 25
};

export type PaginationState = {
  offset: number;
  pageSize: number;
  hasPrev: boolean;
  hasNext: boolean;
  /** 1-based start of the visible range; 0 when the page is empty. */
  rangeStart: number;
  /** 1-based (inclusive) end of the visible range; 0 when the page is empty. */
  rangeEnd: number;
  /** `true` when offset >= total && total > 0 (user navigated past the end). */
  overflow: boolean;
};

export function computePagination(
  input: ComputePaginationInput,
): PaginationState {
  const pageSize = input.pageSize ?? 25;
  const total = Math.max(0, Math.floor(input.total));
  const offset = offsetSchema.parse(input.rawOffset ?? 0);

  // Empty DB short-circuits both overflow and the range computation.
  if (total === 0) {
    return {
      offset,
      pageSize,
      hasPrev: false,
      hasNext: false,
      rangeStart: 0,
      rangeEnd: 0,
      overflow: false,
    };
  }

  // REQ-5b: offset past the end — the page renders a CTA, not a list.
  if (offset >= total) {
    return {
      offset,
      pageSize,
      hasPrev: true,
      hasNext: false,
      rangeStart: 0,
      rangeEnd: 0,
      overflow: true,
    };
  }

  const rangeStart = offset + 1;
  const rangeEnd = Math.min(offset + pageSize, total);

  return {
    offset,
    pageSize,
    hasPrev: offset > 0,
    hasNext: rangeEnd < total,
    rangeStart,
    rangeEnd,
    overflow: false,
  };
}
