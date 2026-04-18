import { notFound } from 'next/navigation';
import { getDb } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';
import { getSession, getTurns } from '@/lib/queries/session';
import { TranscriptViewer } from '@/components/transcript-viewer';
import { Card, CardContent } from '@/components/ui/card';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function fmtUsd(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}
function fmtDate(ms: number) {
  return new Date(ms).toLocaleString();
}
function fmtPct(n: number | null) {
  return n === null ? '—' : `${(n * 100).toFixed(1)}%`;
}
function fmtRating(n: number | null) {
  return n === null ? '—' : n.toFixed(2);
}

export default async function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const db = getDb();
  migrate(db);
  const session = getSession(db, id);
  if (!session) notFound();
  const turns = getTurns(db, id);

  return (
    <section className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">{session.project}</h1>
        <p className="text-sm text-neutral-500 mt-1">{session.id}</p>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
        <Card className="bg-neutral-900 border-neutral-800">
          <CardContent className="p-4">
            <div className="text-neutral-400 text-xs">Cost</div>
            <div className="text-xl font-semibold tabular-nums">
              {fmtUsd(session.totalCostUsd)}
            </div>
          </CardContent>
        </Card>
        <Card className="bg-neutral-900 border-neutral-800">
          <CardContent className="p-4">
            <div className="text-neutral-400 text-xs">Turns</div>
            <div className="text-xl font-semibold">{session.turnCount}</div>
          </CardContent>
        </Card>
        <Card className="bg-neutral-900 border-neutral-800">
          <CardContent className="p-4">
            <div className="text-neutral-400 text-xs">Cache hit</div>
            <div className="text-xl font-semibold">
              {fmtPct(session.cacheHitRatio)}
            </div>
          </CardContent>
        </Card>
        <Card className="bg-neutral-900 border-neutral-800">
          <CardContent className="p-4">
            <div className="text-neutral-400 text-xs">Avg rating</div>
            <div className="text-xl font-semibold">
              {fmtRating(session.avgRating)}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="text-xs text-neutral-500 space-x-4">
        <span>Started: {fmtDate(session.startedAt)}</span>
        <span>Ended: {fmtDate(session.endedAt)}</span>
        {session.gitBranch && (
          <span>
            Branch: <code className="text-neutral-400">{session.gitBranch}</code>
          </span>
        )}
      </div>

      <TranscriptViewer turns={turns} />
    </section>
  );
}
