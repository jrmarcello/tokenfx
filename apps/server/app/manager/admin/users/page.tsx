/**
 * `/manager/admin/users` — admin-only role assignment (REQ-17, TASK-20).
 *
 * Lists every user in the admin's org alphabetically by email and renders a
 * tiny per-row Server-Action form to update the role. The page is gated by
 * three layers (defense-in-depth):
 *
 *   1. `apps/server/middleware.ts` — `/manager/admin/*` requires
 *      `role === 'admin'` (TASK-12). 403s a `manager` request.
 *   2. `apps/server/app/manager/layout.tsx` — re-checks the role server-side.
 *   3. `updateUserRoleAction` — re-checks the role on every submit.
 *
 * Tenant scoping: every read AND write filters on `users.orgId === session
 * orgId`. A cross-org row update is impossible because the WHERE in the
 * Server Action ANDs the admin's `orgId` (Drizzle parameterized query —
 * security rule).
 */
import { redirect } from 'next/navigation';
import { asc, eq } from 'drizzle-orm';
import { auth } from '@/lib/auth/auth';
import { getDb } from '@/lib/db/client';
import { users } from '@/lib/db/schema';
import { updateUserRoleAction } from './actions';

export default async function AdminUsersPage() {
  const session = await auth();
  if (!session?.user?.orgId) {
    redirect('/api/auth/signin');
  }
  const orgId = session.user.orgId;

  const db = getDb();
  const rows = await db
    .select({ id: users.id, email: users.email, role: users.role })
    .from(users)
    .where(eq(users.orgId, orgId))
    .orderBy(asc(users.email));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
          Users
        </h1>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Assign roles. Members are blocked from `/manager/*`. Managers can read
          dashboards. Admins can additionally manage roles.
        </p>
      </div>

      {rows.length === 0 ? (
        <p
          className="rounded-lg border border-dashed border-neutral-300 bg-white p-6 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400"
          data-testid="admin-users-empty"
        >
          No users in this org yet.
        </p>
      ) : (
        <div
          className="overflow-hidden rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
          data-testid="admin-users-list"
        >
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500 dark:bg-neutral-800/50 dark:text-neutral-400">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">
                  Email
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Current role
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Update
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {rows.map((u) => (
                <tr key={u.id}>
                  <td className="px-4 py-3 text-neutral-900 dark:text-neutral-100">
                    {u.email}
                  </td>
                  <td className="px-4 py-3 text-neutral-700 dark:text-neutral-300">
                    {u.role}
                  </td>
                  <td className="px-4 py-3">
                    <form action={updateUserRoleAction} className="flex items-center gap-2">
                      <input type="hidden" name="userId" value={u.id} />
                      <label className="sr-only" htmlFor={`role-${u.id}`}>
                        Role for {u.email}
                      </label>
                      <select
                        id={`role-${u.id}`}
                        name="role"
                        defaultValue={u.role}
                        className="rounded border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
                      >
                        <option value="member">member</option>
                        <option value="manager">manager</option>
                        <option value="admin">admin</option>
                      </select>
                      <button
                        type="submit"
                        className="rounded border border-neutral-300 bg-white px-3 py-1 text-sm font-medium text-neutral-900 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:bg-neutral-700"
                      >
                        Save
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
