import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <section className="space-y-6">
      <header>
        <Skeleton className="h-8 w-32" />
        <Skeleton className="mt-2 h-4 w-24" />
      </header>

      <Card className="bg-white dark:bg-neutral-900 border-neutral-200 dark:border-neutral-800">
        <CardContent className="p-0">
          <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {Array.from({ length: 8 }).map((_, i) => (
              <li key={i} className="flex items-center justify-between px-4 py-3">
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-4 w-44" />
                  <Skeleton className="h-3 w-72" />
                </div>
                <div className="flex items-center gap-6 shrink-0">
                  <Skeleton className="h-4 w-16" />
                  <Skeleton className="h-4 w-14" />
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </section>
  );
}
