'use client';

/**
 * `/manager/invites` error boundary.
 *
 * Client Component (Next.js App Router requirement for `error.tsx`).
 * Renders a generic message + retry button. Crucially, it does NOT echo
 * `error.message` directly to the UI — error messages can carry stack /
 * library internals / SQL fragments. We only surface `error.digest` (an
 * opaque server-side correlation id) so a developer can grep server logs.
 *
 * The error type from Next is `Error & { digest?: string }` — the digest
 * is set by Next's error-handling layer when the error originated on the
 * server.
 */
type Props = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function ManagerInvitesError({ error, reset }: Props) {

  return (
    <div
      className="space-y-4 rounded-lg border border-red-200 bg-red-50 p-6 text-sm dark:border-red-900 dark:bg-red-950"
      data-testid="invites-error"
      role="alert"
    >
      <div>
        <h2 className="text-base font-semibold text-red-900 dark:text-red-100">
          Algo deu errado ao carregar os convites.
        </h2>
        <p className="mt-1 text-red-900/80 dark:text-red-100/80">
          Tente novamente. Se o problema persistir, contate o admin da org.
        </p>
        {error.digest ? (
          <p className="mt-2 font-mono text-xs text-red-900/60 dark:text-red-100/60">
            ref: {error.digest}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => reset()}
        className="inline-flex h-9 items-center justify-center whitespace-nowrap rounded-md border border-red-300 bg-white px-4 text-sm font-medium text-red-900 shadow-sm transition-colors hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 dark:border-red-800 dark:bg-red-900 dark:text-red-100 dark:hover:bg-red-800"
        data-testid="invites-error-retry"
      >
        Tentar novamente
      </button>
    </div>
  );
}
