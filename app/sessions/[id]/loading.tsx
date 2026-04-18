import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <section className="space-y-6">
      <header>
        <Skeleton className="h-8 w-56" />
        <Skeleton className="mt-2 h-3 w-80" />
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="bg-neutral-900 border-neutral-800">
            <CardContent className="p-4 space-y-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-6 w-24" />
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex gap-4">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-3 w-24" />
      </div>

      <ol className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <li
            key={i}
            className="rounded-lg border border-neutral-800 bg-neutral-900 overflow-hidden"
          >
            <header className="flex items-center justify-between px-4 py-2 border-b border-neutral-800">
              <div className="flex items-center gap-3">
                <Skeleton className="h-4 w-6" />
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-16" />
              </div>
              <Skeleton className="h-4 w-48" />
            </header>
            <div className="p-4 space-y-3">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-16 w-full" />
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
