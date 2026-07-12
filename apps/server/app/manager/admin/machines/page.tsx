/**
 * `/manager/admin/machines` — admin-only machine-credential revocation UI
 * (machine-revocation-ui, REQ-1/2/3/7).
 *
 * Gated by three layers (defense-in-depth), same as `/manager/admin/users`:
 *   1. `middleware.ts` — `/manager/admin/*` requires `role === 'admin'`.
 *   2. `app/manager/layout.tsx` — re-checks the role server-side.
 *   3. `revokeMachineAction` — re-checks `role === 'admin'` on every submit.
 *
 * Tenant scoping: `listOrgMachines` filters on `users.orgId === session orgId`
 * via a join, and the revoke path's UPDATE self-guards with the same
 * predicate — a cross-org machine can neither be listed nor revoked. Only the
 * 8-char key-id prefix is rendered; the full key_id never reaches the DOM.
 */
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth/auth';
import { getDb } from '@/lib/db/client';
import { listOrgMachines } from '@/lib/queries/machines';
import { revokeMachineAction } from './actions';

const ERROR_COPY: Record<string, string> = {
  collision:
    'Two machines in your org share that key-id prefix — revoke by full key-id via SQL (see the server README, "Revocation procedure").',
  not_found: 'That machine was not found in your org.',
  invalid_input: 'Invalid machine identifier.',
  unauthorized: 'You are not authorized to revoke machines.',
};

const fmt = (d: Date | null): string => (d ? new Date(d).toISOString().slice(0, 10) : '—');

export default async function AdminMachinesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.orgId) {
    redirect('/api/auth/signin');
  }
  const orgId = session.user.orgId;

  const db = getDb();
  const machines = await listOrgMachines(db, orgId);
  const { error } = await searchParams;
  const errorMessage = error ? ERROR_COPY[error] : undefined;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
          Machines
        </h1>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Revoke a machine&apos;s push credential (e.g. stolen laptop). Revocation
          is immediate and permanent — the dev must re-onboard to push again.
        </p>
      </div>

      {errorMessage ? (
        <div
          role="alert"
          className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
        >
          {errorMessage}
        </div>
      ) : null}

      {machines.length === 0 ? (
        <p className="text-sm text-neutral-500">No machines onboarded in your org yet.</p>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-200 text-left dark:border-neutral-800">
              <th className="py-2 pr-4 font-medium">Key</th>
              <th className="py-2 pr-4 font-medium">Owner</th>
              <th className="py-2 pr-4 font-medium">Provisioned</th>
              <th className="py-2 pr-4 font-medium">Created</th>
              <th className="py-2 pr-4 font-medium">Last seen</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {machines.map((m) => (
              <tr
                key={m.machineId}
                className="border-b border-neutral-100 dark:border-neutral-900"
              >
                <td className="py-2 pr-4 font-mono">{m.keyPrefix}…</td>
                <td className="py-2 pr-4">{m.userEmail}</td>
                <td className="py-2 pr-4">{m.provisionedVia}</td>
                <td className="py-2 pr-4">{fmt(m.createdAt)}</td>
                <td className="py-2 pr-4">{fmt(m.lastSeenAt)}</td>
                <td className="py-2 pr-4">
                  {m.revokedAt ? (
                    <span className="text-red-600 dark:text-red-400">
                      revoked {fmt(m.revokedAt)}
                    </span>
                  ) : (
                    <span className="text-green-700 dark:text-green-400">active</span>
                  )}
                </td>
                <td className="py-2">
                  {m.revokedAt ? null : (
                    <form action={revokeMachineAction}>
                      <input type="hidden" name="prefix" value={m.keyPrefix} />
                      <button
                        type="submit"
                        className="rounded border border-red-300 px-3 py-1 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950"
                      >
                        Revoke
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
