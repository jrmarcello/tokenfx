/**
 * First-auto-provision banner — TASK-17, REQ-1.
 *
 * Server Component. Surfaces unacknowledged SSO auto-provision events for
 * the current manager (within the last 7 days) at the top of `/manager`.
 *
 * Copy & behavior (locked by REQ-1):
 *   - Headline uses `formatBannerCount` so singular/plural copy stays in
 *     one place — same helper unit-tested in `manager-alerts.test.ts`
 *     (TC-U-17/18/19).
 *   - Shows up to 5 most recent events (events are already DESC-ordered
 *     by `loadFirstAutoProvisionAlert`). When `count > 5`, the overflow
 *     collapses into a "+N more" hint; per-event acks for older events
 *     happen on the audit-log page (REQ-4).
 *   - Each visible event has a per-event "Acknowledge" button — a
 *     `<form action={...}>` Server Action submission. No client JS needed.
 *   - Single "Review in audit log" link to `/manager/audit-log`.
 *
 * Privacy: `emailHashPrefix` (8 chars of the peppered hash) is the only
 * identifier shown — REQ "Privacy" in the lib/queries module docstring.
 *
 * The component requires a non-null `alert`. The parent page handles the
 * null case by simply not rendering the banner.
 */
import Link from 'next/link';

import { acknowledgeFirstAutoProvisionFormAction } from '@/app/manager/actions';
import {
  formatBannerCount,
  type FirstAutoProvisionAlert,
  type FirstAutoProvisionEvent,
} from '@/lib/queries/manager-alerts';

type Props = {
  /** Pre-loaded from `loadFirstAutoProvisionAlert`. The page must skip rendering when null. */
  alert: FirstAutoProvisionAlert;
};

/** REQ-1: cap the inline event list — overflow surfaces only as "+N more". */
const VISIBLE_EVENT_LIMIT = 5;

const formatReceivedAt = (date: Date): string =>
  // Compact ISO-ish date+time without seconds — keeps the banner narrow.
  // Using `en-CA` for the YYYY-MM-DD shape, then appending HH:mm in UTC
  // so server/client renders match (no locale-dependent timezone drift).
  `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)}Z`;

const EventRow = ({ event }: { event: FirstAutoProvisionEvent }) => {
  return (
    <li
      className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm dark:border-amber-900 dark:bg-amber-950/40"
      data-testid={`first-auto-provision-event-${event.eventId}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-amber-900 dark:text-amber-100">
        <span className="font-mono text-xs">{event.emailHashPrefix}…</span>
        <span className="text-xs text-amber-800/80 dark:text-amber-200/80">
          via {event.ssoProvider ?? 'unknown'}
        </span>
        <span className="text-xs text-amber-800/80 dark:text-amber-200/80">
          {formatReceivedAt(event.receivedAt)}
        </span>
      </div>
      <form action={acknowledgeFirstAutoProvisionFormAction}>
        <input type="hidden" name="event_id" value={event.eventId} />
        <button
          type="submit"
          className="inline-flex h-7 items-center justify-center whitespace-nowrap rounded-md border border-amber-300 bg-white px-3 text-xs font-medium text-amber-900 transition-colors hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-amber-800 dark:bg-amber-900/40 dark:text-amber-100 dark:hover:bg-amber-900/60"
          data-testid={`first-auto-provision-ack-${event.eventId}`}
        >
          Acknowledge
        </button>
      </form>
    </li>
  );
};

export const FirstAutoProvisionBanner = ({ alert }: Props) => {
  const headline = formatBannerCount(alert.count);
  // Defensive: parent only renders when alert !== null, so count >= 1 and
  // `headline` should be non-null. If somehow null slips through (count=0
  // via a stale read), the component silently renders nothing rather than
  // an empty banner shell.
  if (headline === null) return null;

  const visibleEvents = alert.events.slice(0, VISIBLE_EVENT_LIMIT);
  const overflowCount = Math.max(0, alert.count - visibleEvents.length);

  return (
    <aside
      role="status"
      aria-label="First-auto-provision banner"
      className="rounded-lg border border-amber-300 bg-amber-50/60 p-4 shadow-sm dark:border-amber-900 dark:bg-amber-950/30"
      data-testid="first-auto-provision-banner"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold text-amber-900 dark:text-amber-100">
          {headline}
        </h2>
        <Link
          href="/manager/audit-log"
          className="text-xs font-medium text-amber-800 underline-offset-2 hover:underline dark:text-amber-200"
          data-testid="first-auto-provision-audit-log-link"
        >
          Review in audit log
        </Link>
      </div>
      <ul className="mt-3 space-y-2">
        {visibleEvents.map((event) => (
          <EventRow key={event.eventId} event={event} />
        ))}
      </ul>
      {overflowCount > 0 ? (
        <p
          className="mt-2 text-xs text-amber-800/80 dark:text-amber-200/80"
          data-testid="first-auto-provision-overflow"
        >
          +{overflowCount} more — review in the audit log
        </p>
      ) : null}
    </aside>
  );
};
