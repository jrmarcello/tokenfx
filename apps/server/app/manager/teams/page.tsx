/**
 * `/manager/teams` — alphabetical list of every team in the org.
 *
 * Tiny page — single SELECT, no aggregation. Server-rendered. The query
 * uses Drizzle's parameterized builder (NOT raw `sql` interpolation), so
 * the `orgId` value is bound, not concatenated (security rule: prepared
 * statements with parameter binding).
 */
import Link from 'next/link';
import type { Route } from 'next';
import { redirect } from 'next/navigation';
import { asc, eq } from 'drizzle-orm';
import { auth } from '@/lib/auth/auth';
import { getDb } from '@/lib/db/client';
import { teams } from '@/lib/db/schema';

export default async function ManagerTeamsPage() {
  const session = await auth();
  if (!session?.user?.orgId) {
    redirect('/api/auth/signin');
  }
  const orgId = session.user.orgId;

  const db = getDb();
  const rows = await db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(eq(teams.orgId, orgId))
    .orderBy(asc(teams.name));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
          Teams
        </h1>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Alphabetical. Click a team to see members and per-team spend trend.
        </p>
      </div>

      {rows.length === 0 ? (
        <p
          className="rounded-lg border border-dashed border-neutral-300 bg-white p-6 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400"
          data-testid="teams-empty"
        >
          No teams yet. Create a team via the admin page (or seed script) to
          group users.
        </p>
      ) : (
        <ul
          className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 bg-white dark:divide-neutral-800 dark:border-neutral-800 dark:bg-neutral-900"
          data-testid="teams-list"
        >
          {rows.map((t) => (
            <li key={t.id}>
              <Link
                href={`/manager/teams/${t.id}` as Route}
                className="block px-4 py-3 text-sm text-blue-600 hover:bg-neutral-50 hover:underline dark:text-blue-400 dark:hover:bg-neutral-800"
              >
                {t.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
