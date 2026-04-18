import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import type { TopSession } from '@/lib/queries/overview';

function fmtUsd(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function TopSessions({ items }: { items: TopSession[] }) {
  if (items.length === 0) return null;
  return (
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
                  <div className="text-sm font-medium truncate">{s.project}</div>
                  <div className="text-xs text-neutral-500 truncate">
                    {s.id} • {fmtDate(s.startedAt)}
                  </div>
                </div>
                <div className="flex items-center gap-6 text-sm shrink-0">
                  <span className="tabular-nums">{fmtUsd(s.totalCostUsd)}</span>
                  <span className="text-neutral-500">{s.turnCount} turns</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
