import { cn } from '@/lib/cn';

type Side = 'top' | 'bottom';
type Align = 'start' | 'center' | 'end';

/**
 * Hover/focus-revealed explanatory tooltip.
 *
 * CSS-only (no client-side JS, no Radix) — the popup visibility is
 * controlled via Tailwind `group-hover` / `group-focus-within` on a
 * wrapping span. Placement is static: pick `side` ('top' | 'bottom')
 * and `align` ('start' | 'center' | 'end') at the call site based on
 * where the trigger sits in the layout, since there's no JS to flip
 * it automatically when the popup would overflow the viewport.
 */
export function InfoTooltip({
  children,
  label = 'Mais informação',
  className,
  side = 'top',
  align = 'center',
}: {
  children: React.ReactNode;
  label?: string;
  className?: string;
  side?: Side;
  align?: Align;
}) {
  const sideClass = side === 'top' ? 'bottom-full mb-2' : 'top-full mt-2';
  const alignClass =
    align === 'center'
      ? 'left-1/2 -translate-x-1/2'
      : align === 'start'
        ? 'left-0'
        : 'right-0';
  return (
    <span className={cn('relative group inline-flex items-center', className)}>
      <button
        type="button"
        aria-label={label}
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-neutral-300 dark:border-neutral-700 bg-transparent text-[10px] font-medium leading-none text-neutral-500 transition-colors hover:border-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400"
      >
        ?
      </button>
      <span
        role="tooltip"
        className={cn(
          'pointer-events-none absolute z-50 w-64 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-950 px-3 py-2 text-xs font-normal leading-snug text-neutral-800 dark:text-neutral-200 opacity-0 shadow-xl shadow-black/40 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100',
          sideClass,
          alignClass,
        )}
      >
        {children}
      </span>
    </span>
  );
}
