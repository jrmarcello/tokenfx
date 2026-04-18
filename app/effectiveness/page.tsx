export default function EffectivenessPage() {
  return (
    <section>
      <h1 className="text-2xl font-semibold">Effectiveness</h1>
      <p className="mt-1 text-sm text-neutral-400">
        Token-to-outcome analysis for your Claude Code usage.
      </p>
      <div className="mt-8 rounded-lg border border-dashed border-neutral-700 p-8 text-center text-neutral-400">
        <p className="text-sm">
          No data yet. Run{" "}
          <code className="bg-neutral-800 px-1.5 py-0.5 rounded">pnpm ingest</code>{" "}
          to populate the dashboard.
        </p>
      </div>
    </section>
  );
}
