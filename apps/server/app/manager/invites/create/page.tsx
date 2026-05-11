/**
 * `/manager/invites/create` — invite-creation page (REQ-22).
 *
 * Server Component shell. The actual form is a Client Component
 * (`InviteCreateForm`) because it needs `crypto.randomUUID()` for the
 * idempotency key + a `useTransition` for the submit pending state +
 * `useRouter` for the redirect-on-success.
 *
 * Team selector: we load the org's team list here on the server and pass
 * it down as props. The team list is small (typical N << 100); a server
 * fetch is simpler than a client API call. If the org has no teams, the
 * form renders the "(no team / org-wide)" option only.
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { asc, eq } from 'drizzle-orm';
import { auth } from '@/lib/auth/auth';
import { getDb } from '@/lib/db/client';
import { teams } from '@/lib/db/schema';
import { InviteCreateForm } from '@/components/manager/invite-create-form';

export default async function ManagerInvitesCreatePage() {
  const session = await auth();
  if (!session?.user?.orgId) {
    redirect('/api/auth/signin');
  }
  const orgId = session.user.orgId;

  const db = getDb();
  const teamRows = await db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(eq(teams.orgId, orgId))
    .orderBy(asc(teams.name));

  return (
    <div className="space-y-6">
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
          <Link
            href="/manager/invites"
            className="hover:text-neutral-700 hover:underline dark:hover:text-neutral-200"
          >
            Invites
          </Link>
          <span className="mx-1.5">/</span>
          <span>Create</span>
        </nav>
        <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
          Create invite
        </h1>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          The full URL is shown only once on the next screen. Copy and send it
          via your team&apos;s secure channel.
        </p>
      </div>

      <InviteCreateForm
        teams={teamRows.map((t) => ({ id: t.id, name: t.name }))}
      />
    </div>
  );
}
