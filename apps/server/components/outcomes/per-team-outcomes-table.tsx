/**
 * Per-team outcomes comparison table — manager-dashboard-v3-outcomes
 * spec REQ-13. Server-rendered (no interactivity for v3 — sort is by
 * total_loc_added DESC). Conditionally rendered by the page when the
 * manager has 2+ teams (REQ-14).
 */
type Row = {
  teamId: string;
  teamName: string;
  costPerMergedLoc: number | null;
  tokensPerMergedLoc: number | null;
  revertRate: number | null;
  totalLocAdded: number;
  totalCommits: number;
};

type Props = {
  rows: ReadonlyArray<Row>;
};

const formatCurrency = (n: number | null): string => {
  if (n === null) return '—';
  return `$${n.toFixed(4)}`;
};

const formatTokens = (n: number | null): string => {
  if (n === null) return '—';
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
};

const formatPct = (n: number | null): string => {
  if (n === null) return '—';
  return `${(n * 100).toFixed(1)}%`;
};

const formatInt = (n: number): string => n.toLocaleString('en-US');

export const PerTeamOutcomesTable = ({ rows }: Props) => {
  if (rows.length === 0) {
    return null;
  }
  // Sort by total LOC added desc (most active team first).
  const sorted = [...rows].sort((a, b) => b.totalLocAdded - a.totalLocAdded);

  return (
    <div
      className="overflow-x-auto rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
      data-testid="per-team-outcomes-table"
    >
      <table className="w-full text-sm">
        <thead className="border-b border-neutral-200 dark:border-neutral-800">
          <tr className="text-left text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
            <th className="px-4 py-2">Team</th>
            <th className="px-4 py-2 text-right">Cost / LOC</th>
            <th className="px-4 py-2 text-right">Tokens / LOC</th>
            <th className="px-4 py-2 text-right">Revert rate</th>
            <th className="px-4 py-2 text-right">LOC added</th>
            <th className="px-4 py-2 text-right">Commits</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
          {sorted.map((r) => (
            <tr
              key={r.teamId}
              data-testid={`per-team-row-${r.teamId}`}
              className="text-neutral-900 dark:text-neutral-100"
            >
              <td className="px-4 py-2 font-medium">{r.teamName}</td>
              <td className="px-4 py-2 text-right tabular-nums">
                {formatCurrency(r.costPerMergedLoc)}
              </td>
              <td className="px-4 py-2 text-right tabular-nums">
                {formatTokens(r.tokensPerMergedLoc)}
              </td>
              <td className="px-4 py-2 text-right tabular-nums">
                {formatPct(r.revertRate)}
              </td>
              <td className="px-4 py-2 text-right tabular-nums">
                {formatInt(r.totalLocAdded)}
              </td>
              <td className="px-4 py-2 text-right tabular-nums">
                {formatInt(r.totalCommits)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
