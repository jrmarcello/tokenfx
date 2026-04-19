import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <section className="space-y-8">
      <header className="space-y-2">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-4 w-full max-w-3xl" />
        <Skeleton className="h-4 w-2/3 max-w-xl" />
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card
            key={i}
            className="bg-white dark:bg-neutral-900 border-neutral-200 dark:border-neutral-800"
          >
            <CardHeader className="pb-2">
              <Skeleton className="h-4 w-24" />
            </CardHeader>
            <CardContent className="space-y-3">
              <Skeleton className="h-7 w-28" />
              <Skeleton className="h-2 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>

      <section className="space-y-3">
        <Skeleton className="h-6 w-28" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="space-y-1">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-3 w-56" />
            </div>
          ))}
        </div>
        <Skeleton className="h-9 w-24" />
      </section>

      <Skeleton className="h-56 w-full rounded-lg" />
    </section>
  );
}
