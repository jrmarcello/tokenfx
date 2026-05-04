/**
 * Check-in opportunity card — REQ-11.
 *
 * Server Component. Copy is locked verbatim by REQ-11 — do NOT edit the
 * heading, body, or CTA labels here without changing the spec first.
 *
 * Tone-word policy (REQ-11 + TC-I-35): see the spec for the list of
 * forbidden tone words. The only allowed occurrence in this file is the
 * single spec-locked phrase inside the body sentence below. The runtime
 * grep in TC-I-35 verifies no other matches exist.
 *
 * The secondary "Dismiss for 7 days" CTA is a `<form action={...}>`
 * wrapping a Server Action so this card stays a Server Component. The
 * action revalidates `/manager/health` so the dismissed card disappears.
 */
import Link from 'next/link';
import { dismissAnomalyFormAction } from '@/app/manager/health/dismiss-action';
import type { CheckInOpportunity } from '@/lib/queries/manager-v2';

type Props = {
  opportunity: CheckInOpportunity;
};

export const CheckInCard = ({ opportunity }: Props) => {
  const { targetUserId, displayLabel, teamName, trigger, triggerDescription } =
    opportunity;

  return (
    <article
      className="rounded-lg border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
      data-testid={`check-in-card-${targetUserId}`}
    >
      <h3 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
        Check-in opportunity
      </h3>
      <p className="mt-2 text-sm text-neutral-700 dark:text-neutral-300">
        {displayLabel} on team {teamName} — {triggerDescription}. This may be
        worth a 1:1 conversation about workflow, training, or scope. It&apos;s
        not a flag.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Link
          href={`/manager/check-in/${targetUserId}?reason=cost-investigation`}
          className="inline-flex h-9 items-center justify-center whitespace-nowrap rounded-md bg-neutral-900 px-4 text-sm font-medium text-white shadow transition-colors hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
          data-testid={`check-in-cta-${targetUserId}`}
        >
          Open conversation guide
        </Link>
        <form action={dismissAnomalyFormAction}>
          <input type="hidden" name="targetUserId" value={targetUserId} />
          <input type="hidden" name="kind" value={trigger} />
          <button
            type="submit"
            className="inline-flex h-9 items-center justify-center whitespace-nowrap rounded-md border border-neutral-300 bg-white px-4 text-sm font-medium text-neutral-900 transition-colors hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:bg-neutral-700"
            data-testid={`check-in-dismiss-${targetUserId}`}
          >
            Dismiss for 7 days
          </button>
        </form>
      </div>
    </article>
  );
};
