/**
 * `/manager/health` page — REQ-10/11/12/13.
 *
 * Server-rendered manager Health view. Three sections rendered in this
 * order, each driven by its own query:
 *
 *   1. Check-in opportunities → `getCheckInOpportunities`           (REQ-10/11)
 *   2. Drop-off candidates    → `getDropOffCandidates`              (REQ-12)
 *   3. Knowledge-sharing      → `getKnowledgeSharingOpportunities`  (REQ-13)
 *
 * The three queries are independent and run in parallel via `Promise.all`.
 * Each section has a small empty-state message when its query returns no
 * rows — the manager should always understand why the page looks quiet
 * rather than guessing whether ingestion ran.
 *
 * Auth: `apps/server/app/manager/layout.tsx` already enforces the manager
 * / admin role gate. We re-read the session here only to resolve
 * `managerId` (= `session.user.id`) and `orgId` for the queries — REQ-19
 * org-scoping is enforced inside each query.
 */
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth/auth';
import { getDb } from '@/lib/db/client';
import {
  getCheckInOpportunities,
  getDropOffCandidates,
  getKnowledgeSharingOpportunities,
} from '@/lib/queries/manager-v2';
import { CheckInCard } from '@/components/manager/check-in-card';
import { DropoffCard } from '@/components/manager/dropoff-card';
import { KnowledgeSharingCard } from '@/components/manager/knowledge-sharing-card';

export default async function ManagerHealthPage() {
  const session = await auth();
  if (!session?.user?.id || !session.user.orgId) {
    redirect('/api/auth/signin');
  }
  const managerId = session.user.id;
  const orgId = session.user.orgId;

  const db = getDb();
  const [checkIns, dropOffs, knowledgeRows] = await Promise.all([
    getCheckInOpportunities(db, { managerId, orgId }),
    getDropOffCandidates(db, { managerId, orgId }),
    getKnowledgeSharingOpportunities(db, { managerId, orgId }),
  ]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
          Health
        </h1>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Supportive prompts for 1:1 conversations with your teams. None of
          this is a performance signal.
        </p>
      </div>

      <section
        aria-labelledby="check-ins-heading"
        className="space-y-3"
        data-testid="section-check-ins"
      >
        <h2
          id="check-ins-heading"
          className="text-sm font-semibold uppercase tracking-wide text-neutral-700 dark:text-neutral-300"
        >
          Check-in opportunities
        </h2>
        {checkIns.length === 0 ? (
          <p
            className="text-sm text-neutral-500 dark:text-neutral-400"
            data-testid="check-ins-empty"
          >
            No check-ins to surface this week.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {checkIns.map((opportunity) => (
              <CheckInCard
                key={`${opportunity.targetUserId}-${opportunity.trigger}`}
                opportunity={opportunity}
              />
            ))}
          </div>
        )}
      </section>

      <section
        aria-labelledby="dropoffs-heading"
        className="space-y-3"
        data-testid="section-dropoffs"
      >
        <h2
          id="dropoffs-heading"
          className="text-sm font-semibold uppercase tracking-wide text-neutral-700 dark:text-neutral-300"
        >
          May need support
        </h2>
        {dropOffs.length === 0 ? (
          <p
            className="text-sm text-neutral-500 dark:text-neutral-400"
            data-testid="dropoffs-empty"
          >
            No drop-offs to surface this week.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {dropOffs.map((candidate) => (
              <DropoffCard
                key={candidate.targetUserId}
                candidate={candidate}
              />
            ))}
          </div>
        )}
      </section>

      <section
        aria-labelledby="knowledge-sharing-heading"
        className="space-y-3"
        data-testid="section-knowledge-sharing"
      >
        <h2
          id="knowledge-sharing-heading"
          className="text-sm font-semibold uppercase tracking-wide text-neutral-700 dark:text-neutral-300"
        >
          Knowledge-sharing opportunities
        </h2>
        {knowledgeRows.length === 0 ? (
          <p
            className="text-sm text-neutral-500 dark:text-neutral-400"
            data-testid="knowledge-sharing-empty"
          >
            No knowledge-sharing opportunities to surface this week.
          </p>
        ) : (
          <KnowledgeSharingCard rows={knowledgeRows} />
        )}
      </section>
    </div>
  );
}
