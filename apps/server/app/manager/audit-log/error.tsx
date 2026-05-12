'use client';

/**
 * `/manager/audit-log` error boundary.
 *
 * Client Component (Next.js App Router requires `error.tsx` to be client).
 * Renders a generic message + retry button. We never echo `error.message`
 * to the UI — error strings can carry stack frames, library internals, or
 * SQL fragments. The `error.digest` (opaque server correlation id, set by
 * Next when the error originated server-side) is surfaced so a developer
 * can grep server logs.
 */
type Props = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function ManagerAuditLogError({ error, reset }: Props) {
  return (
    <div
      className="space-y-4 rounded-lg border border-red-200 bg-red-50 p-6 text-sm dark:border-red-900 dark:bg-red-950"
      data-testid="audit-log-error"
      role="alert"
    >
      <div>
        <h2 className="text-base font-semibold text-red-900 dark:text-red-100">
          Algo deu errado ao carregar o audit log.
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
        data-testid="audit-log-error-retry"
      >
        Tentar novamente
      </button>
    </div>
  );
}
