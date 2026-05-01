/**
 * Team breakdown table — REQ-18 (c).
 *
 * Lists every team in the org with its 30d spend, 7d active-user count, and
 * a tiny inline 7-day sparkline. Rows are sorted ALPHABETICALLY by team name
 * (the query already returns them sorted; we do not re-sort here).
 *
 * REQ-26 anti-leaderboard rule applies at the per-USER level. The breakdown
 * here is per-TEAM, where ranking by spend is allowed by REQ-18, but we
 * still default to alphabetical to avoid implying an internal scoreboard
 * (and to match the per-user table convention so reviewers see one
 * consistent pattern). Column headers are static `<th>` elements — never
 * sortable buttons — to match REQ-26's spirit.
 *
 * Server-rendered (no client interactivity).
 */
import Link from 'next/link';
import type { Route } from 'next';
import type { TeamRow } from '@/lib/queries/overview';

type Props = {
  teams: ReadonlyArray<TeamRow>;
};

const formatUsd = (n: number): string =>
  n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/**
 * Inline SVG sparkline. Drawn at fixed dimensions so the row height is
 * stable. Pure render; safe to server-render.
 */
const Sparkline = ({ values }: { values: ReadonlyArray<number> }) => {
  const width = 80;
  const height = 24;
  if (values.length === 0) {
    return <span className="text-xs text-neutral-400">—</span>;
  }
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const stepX = values.length > 1 ? width / (values.length - 1) : 0;
  const points = values
    .map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="7-day spend sparkline"
    >
      <polyline
        fill="none"
        stroke="#2563eb"
        strokeWidth={1.5}
        points={points}
      />
    </svg>
  );
};

export const TeamBreakdownTable = ({ teams }: Props) => {
  if (teams.length === 0) {
    return (
      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        No teams yet.
      </p>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
      <table
        className="w-full text-sm"
        data-testid="team-breakdown-table"
      >
        <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
          <tr>
            <th className="px-4 py-2 font-medium">Team</th>
            <th className="px-4 py-2 text-right font-medium">Spend (30d)</th>
            <th className="px-4 py-2 text-right font-medium">Active users (7d)</th>
            <th className="px-4 py-2 font-medium">Trend (7d)</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-200 bg-white dark:divide-neutral-800 dark:bg-neutral-900">
          {teams.map((t) => (
            <tr key={t.teamId}>
              <td className="px-4 py-2">
                <Link
                  href={`/manager/teams/${t.teamId}` as Route}
                  className="text-blue-600 hover:underline dark:text-blue-400"
                >
                  {t.teamName}
                </Link>
              </td>
              <td className="px-4 py-2 text-right tabular-nums">
                {formatUsd(t.spend30d)}
              </td>
              <td className="px-4 py-2 text-right tabular-nums">
                {t.activeUsers7d}
              </td>
              <td className="px-4 py-2">
                <Sparkline values={t.sparkline7d} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
