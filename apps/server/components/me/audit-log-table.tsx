/**
 * Audit log table — manager-dashboard-v2 REQ-17.
 *
 * Server-renderable presentational table for the `/me/visibility` page. Renders
 * the chronological audit log of every drilldown row where
 * `target_user_id = self`, newest-first. Columns: `viewedAt`, `manager`,
 * `reason`, `reasonText`.
 *
 * # Why a dedicated component (not inline JSX)
 *
 * Anti-surveillance principle 5 (LOCKED): "Devs see what their manager sees."
 * Even if the org disables `drilldown_notification_enabled`, historical audit
 * rows are STILL shown to the dev. Encapsulating the table keeps the empty-
 * state copy ("No views recorded") in one place and pins the column order +
 * `data-testid` hooks E2E tests rely on.
 *
 * # Empty state
 *
 * When `items.length === 0`, render the `data-testid="audit-empty"` panel
 * with the locked copy "No views recorded." (TC-I-32). The page does NOT
 * suppress the section — the audit table is always present so the dev can
 * confirm "nothing has been seen" rather than wonder if the section is
 * missing because of a bug.
 *
 * # No client-side interactivity
 *
 * Pagination is server-side (the page reads `?page=N` from `searchParams`
 * and re-renders). The table is a pure server component — no `'use client'`,
 * no event handlers.
 */
import type { MyDrilldownAuditItem } from '@/lib/queries/me-visibility';

type Props = {
  items: ReadonlyArray<MyDrilldownAuditItem>;
  /** Optional `data-testid` override. Defaults to `audit-log-table`. */
  testId?: string;
};

const REASON_HUMAN: Record<string, string> = {
  'training-check': 'Training check',
  'quota-investigation': 'Quota investigation',
  'cost-investigation': 'Cost investigation',
  other: 'Other',
};

const formatViewedAt = (d: Date): string => {
  // ISO timestamp → human-friendly UTC string. Locale-free so SSR and CSR
  // produce identical output (no hydration mismatch).
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
};

export const AuditLogTable = ({ items, testId = 'audit-log-table' }: Props) => {
  if (items.length === 0) {
    return (
      <div
        className="rounded-lg border border-neutral-200 bg-white p-6 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400"
        data-testid="audit-empty"
      >
        No views recorded.
      </div>
    );
  }

  return (
    <div
      className="overflow-x-auto rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
      data-testid={testId}
    >
      <table className="w-full text-sm">
        <thead className="bg-neutral-50 text-left text-xs font-medium uppercase tracking-wide text-neutral-500 dark:bg-neutral-800/50 dark:text-neutral-400">
          <tr>
            <th scope="col" className="px-4 py-2">
              Viewed at
            </th>
            <th scope="col" className="px-4 py-2">
              Manager
            </th>
            <th scope="col" className="px-4 py-2">
              Reason
            </th>
            <th scope="col" className="px-4 py-2">
              Notes
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-200 text-neutral-900 dark:divide-neutral-800 dark:text-neutral-100">
          {items.map((row, idx) => (
            <tr
              key={`${row.viewedAt.toISOString()}-${idx}`}
              data-testid="audit-row"
            >
              <td className="whitespace-nowrap px-4 py-2 tabular-nums text-neutral-700 dark:text-neutral-300">
                {formatViewedAt(row.viewedAt)}
              </td>
              <td className="px-4 py-2">{row.managerDisplayLabel}</td>
              <td className="px-4 py-2 text-neutral-700 dark:text-neutral-300">
                {REASON_HUMAN[row.reason] ?? row.reason}
              </td>
              <td className="px-4 py-2 text-neutral-600 dark:text-neutral-400">
                {row.reasonText ?? ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
