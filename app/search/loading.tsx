export default function Loading() {
  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <div className="h-8 w-32 animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />
        <div className="h-4 w-64 animate-pulse rounded bg-neutral-100/60 dark:bg-neutral-800/60" />
      </div>
      <div className="h-10 w-full animate-pulse rounded bg-neutral-100/60 dark:bg-neutral-800/60" />
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="h-20 animate-pulse rounded-lg bg-neutral-100/40 dark:bg-neutral-800/40"
          />
        ))}
      </div>
    </section>
  );
}
