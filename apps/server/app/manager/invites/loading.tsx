/**
 * `/manager/invites` loading skeleton.
 *
 * Server Component. Mirrors the table layout in `page.tsx` so the layout
 * doesn't shift when the data resolves. Pure CSS skeleton (no JS, no
 * external animation library) — relies on Tailwind's `animate-pulse`.
 */

const SKELETON_ROWS = 5;

export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <div>
        <div className="h-3 w-24 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />
        <div className="mt-2 h-7 w-40 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />
        <div className="mt-2 h-4 w-96 max-w-full animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />
      </div>

      <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
        <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
          <div className="flex items-center gap-4 bg-neutral-50 px-4 py-2 dark:bg-neutral-800/50">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="h-3 w-20 animate-pulse rounded bg-neutral-200 dark:bg-neutral-700"
              />
            ))}
          </div>
          {Array.from({ length: SKELETON_ROWS }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3">
              <div className="h-4 w-24 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />
              <div className="h-5 w-16 animate-pulse rounded-full bg-neutral-200 dark:bg-neutral-800" />
              <div className="h-4 w-28 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />
              <div className="h-4 w-32 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />
              <div className="ml-auto h-4 w-12 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />
              <div className="h-4 w-24 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
