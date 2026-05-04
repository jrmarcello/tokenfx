/**
 * Knowledge-sharing opportunity section — REQ-13.
 *
 * Server Component. Renders a section heading and a bulleted list of
 * opportunity copy strings produced by `getKnowledgeSharingOpportunities`.
 * The body copy is locked verbatim by REQ-13:
 *
 *   "Team {top} uses {feature} {ratio}× more than {bottom}. Consider
 *    sharing patterns."
 *
 * The query layer (`manager-v2.ts`) already builds the formatted `copy`
 * string with the right ratio precision so this component only needs to
 * render. Empty input → render nothing (the page handles the empty state).
 */
import type { KnowledgeSharingRow } from '@/lib/queries/manager-v2';

type Props = {
  rows: readonly KnowledgeSharingRow[];
};

export const KnowledgeSharingCard = ({ rows }: Props) => {
  if (rows.length === 0) return null;

  return (
    <article
      className="rounded-lg border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
      data-testid="knowledge-sharing-card"
    >
      <h3 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
        Knowledge-sharing opportunity
      </h3>
      <ul className="mt-3 space-y-2 text-sm text-neutral-700 dark:text-neutral-300">
        {rows.map((row) => (
          <li
            key={`${row.feature}-${row.topTeamId}-${row.bottomTeamId}`}
            data-testid={`knowledge-sharing-row-${row.feature}`}
          >
            Team {row.topTeamName} uses {row.feature} {row.ratio.toFixed(1)}×
            more than {row.bottomTeamName}. Consider sharing patterns.
          </li>
        ))}
      </ul>
    </article>
  );
};
