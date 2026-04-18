import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <section className="space-y-6">
      <header>
        <Skeleton className="h-8 w-36" />
        <Skeleton className="mt-2 h-4 w-72" />
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="bg-neutral-900 border-neutral-800">
            <CardHeader className="pb-2">
              <Skeleton className="h-4 w-36" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-7 w-20" />
              <Skeleton className="mt-2 h-3 w-28" />
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section>
          <Skeleton className="h-5 w-56 mb-3" />
          <Skeleton className="h-64 w-full rounded-lg" />
        </section>
        <section>
          <Skeleton className="h-5 w-56 mb-3" />
          <Skeleton className="h-64 w-full rounded-lg" />
        </section>
        <section className="lg:col-span-2">
          <Skeleton className="h-5 w-40 mb-3" />
          <Card className="bg-neutral-900 border-neutral-800">
            <CardContent className="p-0">
              <ul className="divide-y divide-neutral-800">
                {Array.from({ length: 6 }).map((_, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between px-4 py-2"
                  >
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-4 w-20" />
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </section>
      </div>
    </section>
  );
}
