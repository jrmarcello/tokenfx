/**
 * Empty-org onboarding card — REQ-28.
 *
 * Rendered by `/manager` when the org has zero pushed sessions / zero seats
 * (no users registered). Surfaces the reporter setup CTA so an admin can
 * unblock their team without reading docs.
 *
 * Server-rendered.
 */

export const OnboardingCard = () => {
  return (
    <div
      className="rounded-lg border border-blue-200 bg-blue-50 p-6 dark:border-blue-900 dark:bg-blue-950"
      data-testid="onboarding-card"
    >
      <h2 className="text-lg font-semibold text-blue-900 dark:text-blue-100">
        No data yet
      </h2>
      <p className="mt-2 text-sm text-blue-900 dark:text-blue-100">
        Share <code className="rounded bg-blue-100 px-1.5 py-0.5 font-mono text-xs dark:bg-blue-900">pnpm reporter:setup</code>{' '}
        with your team. Once a developer runs that command on their machine,
        their sessions will appear here.
      </p>
      <p className="mt-2 text-xs text-blue-900/80 dark:text-blue-100/80">
        Run <code className="rounded bg-blue-100 px-1.5 py-0.5 font-mono text-xs dark:bg-blue-900">pnpm reporter:setup</code> on each dev&apos;s machine.
      </p>
    </div>
  );
};
