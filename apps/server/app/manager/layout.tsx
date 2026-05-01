/**
 * `/manager/*` layout — auth + role gate (REQ-16, REQ-17).
 *
 * The root `apps/server/middleware.ts` already redirects unauthenticated
 * requests and 403s the wrong roles. This layout adds a defense-in-depth
 * check for two reasons:
 *
 *  1. The middleware matcher is route-prefix based; if the matcher config
 *     ever drifts (e.g. someone adds a `/manager-foo` page that bypasses
 *     it), the layout still enforces the role contract.
 *  2. Server Components rendered here trust `session.user.role` for
 *     conditional UI (the admin-nav link). Re-reading the session on the
 *     server is the safest place to do that.
 *
 * Renders a 403 banner instead of redirecting on wrong-role so the user
 * sees a clear message rather than bouncing through sign-in. Unauth
 * redirect path matches the middleware (`/api/auth/signin`).
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth/auth';

export default async function ManagerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) {
    redirect('/api/auth/signin');
  }
  const role = session.user.role;

  if (role !== 'manager' && role !== 'admin') {
    return (
      <main className="p-8" data-testid="manager-403">
        <h1 className="text-xl font-bold text-neutral-900 dark:text-neutral-100">
          403 — Manager role required
        </h1>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          Ask an org admin to grant you the manager role.
        </p>
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-950">
      <header className="border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
        <nav className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3 text-sm">
          <Link
            href="/manager"
            className="font-semibold text-neutral-900 dark:text-neutral-100"
          >
            TokenFx
          </Link>
          <Link
            href="/manager"
            className="text-neutral-700 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-100"
          >
            Overview
          </Link>
          <Link
            href="/manager/teams"
            className="text-neutral-700 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-100"
          >
            Teams
          </Link>
          {role === 'admin' ? (
            <Link
              href="/manager/admin/users"
              className="text-neutral-700 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-100"
            >
              Admin
            </Link>
          ) : null}
          <span className="ml-auto text-xs text-neutral-500 dark:text-neutral-400">
            {session.user.email} · {role}
          </span>
        </nav>
      </header>
      <main className="mx-auto max-w-6xl p-6">{children}</main>
    </div>
  );
}
