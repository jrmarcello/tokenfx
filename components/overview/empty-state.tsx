export function OverviewEmptyState() {
  return (
    <div className="mt-8 rounded-lg border border-dashed border-neutral-700 p-8 text-center text-neutral-400">
      <p className="text-sm">
        Sem dados ainda. Rode{' '}
        <code className="bg-neutral-800 px-1.5 py-0.5 rounded">pnpm ingest</code>{' '}
        para popular o dashboard.
      </p>
    </div>
  );
}
