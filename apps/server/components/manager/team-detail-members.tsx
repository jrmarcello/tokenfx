/**
 * Team detail members table — REQ-21 (b) + REQ-26 anti-leaderboard.
 *
 * Renders the per-user spend table for a team. Rows arrive ALPHABETICAL by
 * email (the query enforces it via `ORDER BY users.email ASC`); this
 * component preserves that order and intentionally does NOT expose a sort
 * control, click-to-rank header, or spend-descending toggle. The column
 * headers are plain `<th>` text elements — never `<button>`s — so the
 * anti-leaderboard rule is also visibly enforced at the UI layer.
 *
 * Server-rendered.
 */
import type { TeamMember } from '@/lib/queries/teams';

type Props = {
  members: ReadonlyArray<TeamMember>;
};

const formatUsd = (n: number): string =>
  n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

export const TeamDetailMembers = ({ members }: Props) => {
  if (members.length === 0) {
    return (
      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        No members on this team yet.
      </p>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
      <table
        className="w-full text-sm"
        data-testid="team-members-table"
      >
        <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
          {/* Static text headers — REQ-26: no sortable controls, no spend ranking. */}
          <tr>
            <th className="px-4 py-2 font-medium">Email (A → Z)</th>
            <th className="px-4 py-2 text-right font-medium">Sessions (30d)</th>
            <th className="px-4 py-2 text-right font-medium">Spend (30d)</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-200 bg-white dark:divide-neutral-800 dark:bg-neutral-900">
          {members.map((m) => (
            <tr key={m.userId}>
              <td className="px-4 py-2">{m.email}</td>
              <td className="px-4 py-2 text-right tabular-nums">
                {m.sessions30d}
              </td>
              <td className="px-4 py-2 text-right tabular-nums">
                {formatUsd(m.spend30d)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
