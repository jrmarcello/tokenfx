/**
 * `/manager/invites` — invite list for the acting manager's org (REQ-21).
 *
 * Server Component. Pulls every invite for the org via `listInvitesForOrg`
 * (joins teams + users for the display labels). The query already projects
 * only the `token_prefix` column — the full plaintext token NEVER reaches this page,
 * so there is nothing here that could leak a usable token even via a bug.
 *
 * Empty state: encourages the manager to create the first invite. The table
 * is rendered only when `rows.length > 0` so the empty-state and the table
 * are mutually exclusive (avoids both a heading-less skeleton and an
 * always-visible "no rows" footer).
 *
 * Auth: the parent `app/manager/layout.tsx` already enforces role
 * (manager|admin). We re-read the session to get `orgId` for the query —
 * that's the same defense-in-depth pattern the other manager pages follow.
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth/auth';
import { getDb } from '@/lib/db/client';
import { listInvitesForOrg } from '@/lib/queries/invites';
import { InviteRow } from '@/components/manager/invite-row';

export default async function ManagerInvitesPage() {
  const session = await auth();
  if (!session?.user?.orgId) {
    redirect('/api/auth/signin');
  }
  const orgId = session.user.orgId;

  const db = getDb();
  const rows = await listInvitesForOrg(db, orgId);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <nav
            className="mb-1 text-xs text-neutral-500 dark:text-neutral-400"
            aria-label="Breadcrumb"
          >
            <Link
              href="/manager"
              className="hover:text-neutral-700 hover:underline dark:hover:text-neutral-200"
            >
              Manager
            </Link>
            <span className="mx-1.5">/</span>
            <span>Invites</span>
          </nav>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
            Invites
          </h1>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            Onboarding invites issued to this org. The full token is never
            shown here — only the 8-character prefix.
          </p>
        </div>
        <Link
          href="/manager/invites/create"
          className="inline-flex h-9 items-center justify-center whitespace-nowrap rounded-md bg-neutral-900 px-4 text-sm font-medium text-neutral-50 shadow transition-colors hover:bg-neutral-900/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-950 dark:bg-neutral-50 dark:text-neutral-900 dark:hover:bg-neutral-50/90 dark:focus-visible:ring-neutral-300"
          data-testid="invite-create-link"
        >
          Create invite
        </Link>
      </div>

      {rows.length === 0 ? (
        <p
          className="rounded-lg border border-dashed border-neutral-300 bg-white p-6 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400"
          data-testid="invites-empty"
        >
          No invites yet — create one to onboard a teammate.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          <table
            className="w-full text-sm"
            data-testid="invites-table"
          >
            <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500 dark:bg-neutral-800/50 dark:text-neutral-400">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">
                  Prefix
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Team
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Email pattern
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium">
                  Uses
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Expires
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Created by
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {rows.map((row) => (
                <InviteRow key={row.tokenPrefix} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
