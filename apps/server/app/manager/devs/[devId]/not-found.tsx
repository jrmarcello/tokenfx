/**
 * 404 boundary for `/manager/devs/[devId]` — rendered when
 * `loadDrilldownData` calls `notFound()` because the dev id does not
 * exist or the manager has no team / cross-org access (REQ-15, TC-I-28,
 * TC-I-58).
 */
export default function DevDrilldownNotFound() {
  return (
    <main className="p-8" data-testid="drilldown-not-found">
      <h1 className="text-xl font-bold text-neutral-900 dark:text-neutral-100">
        404 — Dev not found or not in your team
      </h1>
      <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
        You can only drill into devs on a team you manage.
      </p>
    </main>
  );
}
