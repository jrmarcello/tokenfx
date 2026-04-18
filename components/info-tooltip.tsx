import { cn } from '@/lib/cn';

/**
 * Hover/focus-revealed explanatory tooltip.
 *
 * CSS-only (no client-side JS, no Radix) — the popup visibility is
 * controlled purely via Tailwind `group-hover` / `group-focus-within`
 * on a wrapping span. Accessible: the trigger is a keyboard-focusable
 * `<button>`; keyboard users see the same popup when they tab to it.
 */
export function InfoTooltip({
  children,
  label = 'Mais informação',
  className,
}: {
  children: React.ReactNode;
  label?: string;
  className?: string;
}) {
  return (
    <span className={cn('relative group inline-flex items-center', className)}>
      <button
        type="button"
        aria-label={label}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-neutral-700 text-[9px] font-semibold text-neutral-500 hover:text-neutral-200 hover:border-neutral-500 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400"
        tabIndex={0}
      >
        ?
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 w-64 -translate-x-1/2 rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-xs font-normal leading-snug text-neutral-200 opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {children}
      </span>
    </span>
  );
}
