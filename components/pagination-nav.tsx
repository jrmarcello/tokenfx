import Link from 'next/link';

export type PaginationNavProps = {
  /** Base pathname. E.g. '/sessions' or '/search'. No trailing slash. */
  basePath: string;
  /** Current offset (0-based). */
  currentOffset: number;
  pageSize: number;
  /** Total row count (post-filter when applicable). */
  total: number;
  /**
   * Other search params to preserve on Prev/Next navigation. Keys with
   * `undefined` values are dropped. E.g. `{ date: '2026-04-19', q: 'auth' }`.
   */
  preserveParams?: Record<string, string | number | undefined>;
};

/**
 * Reusable Prev/Next pagination controls. Renders `null` when total fits in
 * a single page (total <= pageSize). Boundary links render as
 * `<span aria-disabled="true" class="opacity-40">` instead of `<a>` so
 * they stay visible + screen-reader-addressable but aren't clickable.
 *
 * Preserves the caller's `preserveParams` in every generated href.
 */
export function PaginationNav({
  basePath,
  currentOffset,
  pageSize,
  total,
  preserveParams,
}: PaginationNavProps) {
  if (total <= pageSize) return null;

  const hasPrev = currentOffset > 0;
  const hasNext = currentOffset + pageSize < total;

  const buildHref = (offset: number): string => {
    const sp = new URLSearchParams();
    if (preserveParams) {
      for (const [key, value] of Object.entries(preserveParams)) {
        if (value === undefined) continue;
        sp.set(key, String(value));
      }
    }
    if (offset > 0) sp.set('offset', String(offset));
    const qs = sp.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };

  const baseClass =
    'rounded border border-neutral-200 dark:border-neutral-800 px-3 py-1.5 text-sm text-neutral-700 dark:text-neutral-300 transition';

  const prevHref = buildHref(Math.max(0, currentOffset - pageSize));
  const nextHref = buildHref(currentOffset + pageSize);

  return (
    <nav
      aria-label="Paginação"
      className="flex items-center justify-between pt-2 text-sm"
    >
      {hasPrev ? (
        <Link
          href={prevHref}
          aria-label="Página anterior"
          className={`${baseClass} hover:border-neutral-600`}
        >
          ← Anterior
        </Link>
      ) : (
        <span
          aria-label="Página anterior"
          aria-disabled="true"
          className={`${baseClass} opacity-40`}
        >
          ← Anterior
        </span>
      )}
      {hasNext ? (
        <Link
          href={nextHref}
          aria-label="Próxima página"
          className={`${baseClass} hover:border-neutral-600`}
        >
          Próxima →
        </Link>
      ) : (
        <span
          aria-label="Próxima página"
          aria-disabled="true"
          className={`${baseClass} opacity-40`}
        >
          Próxima →
        </span>
      )}
    </nav>
  );
}
