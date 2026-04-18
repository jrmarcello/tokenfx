import Link from 'next/link';
import { getDb } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';
import { listSessions } from '@/lib/queries/session';
import { Card, CardContent } from '@/components/ui/card';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function fmtUsd(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}
function fmtDate(ms: number) {
  return new Date(ms).toLocaleString();
}

export default async function SessionsPage() {
  const db = getDb();
  migrate(db);
  const items = listSessions(db, 100);

  return (
    <section className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Sessions</h1>
        <p className="text-sm text-neutral-400 mt-1">{items.length} recent</p>
      </header>
      {items.length === 0 ? (
        <div className="mt-8 rounded-lg border border-dashed border-neutral-700 p-8 text-center text-neutral-400 text-sm">
          No sessions yet. Run{' '}
          <code className="bg-neutral-800 px-1.5 py-0.5 rounded">
            pnpm ingest
          </code>
          .
        </div>
      ) : (
        <Card className="bg-neutral-900 border-neutral-800">
          <CardContent className="p-0">
            <ul className="divide-y divide-neutral-800">
              {items.map((s) => (
                <li key={s.id}>
                  <Link
                    href={`/sessions/${s.id}`}
                    className="flex items-center justify-between px-4 py-3 hover:bg-neutral-800/60 transition"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">
                        {s.project}
                      </div>
                      <div className="text-xs text-neutral-500 truncate">
                        {s.id} • {fmtDate(s.startedAt)}
                      </div>
                    </div>
                    <div className="flex items-center gap-6 text-sm shrink-0 tabular-nums">
                      <span>{fmtUsd(s.totalCostUsd)}</span>
                      <span className="text-neutral-500">
                        {s.turnCount} turns
                      </span>
                      {s.avgRating !== null && (
                        <span className="text-neutral-400">
                          {s.avgRating.toFixed(1)}★
                        </span>
                      )}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </section>
  );
}
