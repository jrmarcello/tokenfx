import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Skeleton para `/effectiveness`. Reflete a ordem das seções (heading +
 * KPIs + heatmap + funnel + scatter + insight panel + score distribution
 * + tool success trend + subagent usage) sem replicar cada subitem
 * fielmente — basta dar peso visual coerente enquanto a página resolve.
 */
export default function Loading() {
  return (
    <section className="space-y-8">
      <header className="space-y-1">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="mt-2 h-4 w-48" />
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card
            key={i}
            className="bg-white dark:bg-neutral-900 border-neutral-200 dark:border-neutral-800"
          >
            <CardHeader className="pb-2">
              <Skeleton className="h-4 w-28" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-7 w-24" />
              <Skeleton className="mt-2 h-3 w-40" />
            </CardContent>
          </Card>
        ))}
      </div>

      <Skeleton className="h-32 w-full rounded-lg" />
      <Skeleton className="h-48 w-full rounded-lg" />
      <Skeleton className="h-64 w-full rounded-lg" />
      <Skeleton className="h-56 w-full rounded-lg" />
      <Skeleton className="h-40 w-full rounded-lg" />
      <Skeleton className="h-64 w-full rounded-lg" />
      <Skeleton className="h-24 w-full rounded-lg" />
    </section>
  );
}
