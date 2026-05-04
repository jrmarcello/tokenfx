/**
 * Drop-off card — REQ-12.
 *
 * Server Component. Copy is locked verbatim by REQ-12. The supportive tone
 * mirrors the check-in card: it is a prompt to start a conversation about
 * training, blockers, or scope changes — never a performance signal.
 *
 * Tone-word policy (TC-I-69): this file MUST contain ZERO occurrences of
 * the forbidden tone words listed in the spec. Do not reference those
 * words anywhere — including comments, ARIA roles, class names, or
 * labels. The runtime grep is keyword-only and case-insensitive.
 *
 * The secondary "Dismiss for 7 days" CTA is a `<form action={...}>`
 * wrapping a Server Action with `kind="dropoff-wow"` (the constant the
 * `getDropOffCandidates` query uses to filter dismissed rows).
 */
import Link from 'next/link';
import { dismissAnomalyFormAction } from '@/app/manager/health/dismiss-action';
import type { DropOffCandidate } from '@/lib/queries/manager-v2';

type Props = {
  candidate: DropOffCandidate;
};

export const DropoffCard = ({ candidate }: Props) => {
  const { targetUserId, displayLabel, teamName, dropPct } = candidate;
  const pct = Math.round(dropPct);

  return (
    <article
      className="rounded-lg border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
      data-testid={`dropoff-card-${targetUserId}`}
    >
      <h3 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
        May need support
      </h3>
      <p className="mt-2 text-sm text-neutral-700 dark:text-neutral-300">
        {displayLabel} on team {teamName} — usage down {pct}% week-over-week.
        Consider checking in about training, blockers, or scope changes.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Link
          href={`/manager/check-in/${targetUserId}?reason=training-check`}
          className="inline-flex h-9 items-center justify-center whitespace-nowrap rounded-md bg-neutral-900 px-4 text-sm font-medium text-white shadow transition-colors hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
          data-testid={`dropoff-cta-${targetUserId}`}
        >
          Open conversation guide
        </Link>
        <form action={dismissAnomalyFormAction}>
          <input type="hidden" name="targetUserId" value={targetUserId} />
          <input type="hidden" name="kind" value="dropoff-wow" />
          <button
            type="submit"
            className="inline-flex h-9 items-center justify-center whitespace-nowrap rounded-md border border-neutral-300 bg-white px-4 text-sm font-medium text-neutral-900 transition-colors hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:bg-neutral-700"
            data-testid={`dropoff-dismiss-${targetUserId}`}
          >
            Dismiss for 7 days
          </button>
        </form>
      </div>
    </article>
  );
};
