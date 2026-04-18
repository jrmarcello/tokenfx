import { KpiCard } from "@/components/kpi-card";

export default function Home() {
  return (
    <section>
      <h1 className="text-2xl font-semibold">Overview</h1>
      <p className="mt-1 text-sm text-neutral-400">
        Last 30 days of Claude Code activity.
      </p>
      <div className="mt-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard title="Total spend (30d)" value="—" />
        <KpiCard title="Total tokens (30d)" value="—" />
        <KpiCard title="Cache hit ratio" value="—" />
        <KpiCard title="Sessions (30d)" value="—" />
      </div>
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
