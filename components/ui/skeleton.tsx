import { cn } from '@/lib/cn';

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn('animate-pulse bg-neutral-200/80 dark:bg-neutral-800/80 rounded-md', className)}
    />
  );
}
