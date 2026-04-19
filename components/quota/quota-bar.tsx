import type { JSX } from 'react';

import { cn } from '@/lib/cn';
import { computeFillPct, quotaBand } from '@/lib/quota/color';

export type QuotaBarProps = {
  /** Short label shown to the left of the bar (e.g. "5h", "7d", "Sessões 5h"). */
  label: string;
  /** Current usage (absolute). */
  used: number;
  /** Threshold configured by the user. Caller guarantees `limit > 0`. */
  limit: number;
};

const BAND_CLASSES = {
  green: 'bg-emerald-500',
  amber: 'bg-amber-500',
  red: 'bg-red-500',
} as const;

/**
 * Compact progress bar for a single quota threshold.
 *
 * Pure Server Component — props in, JSX out. Color band + visual fill
 * come from `lib/quota/color`. On overflow (pct > 1) the bar fill stays
 * capped at 100% while the text shows the real percentage (e.g. "108%").
 */
export function QuotaBar({ label, used, limit }: QuotaBarProps): JSX.Element {
  const pct = limit > 0 ? used / limit : 0;
  const band = quotaBand(pct);
  const fill = computeFillPct(pct);
  const pctRounded = Math.round(pct * 100);

  return (
    <div
      className="flex items-center gap-2 text-xs tabular-nums"
      aria-label={`Quota ${label}`}
    >
      <span className="text-neutral-600 dark:text-neutral-400">{label}</span>
      <div
        className="h-1.5 w-16 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pctRounded}
      >
        <div
          className={cn('h-full rounded-full transition-all', BAND_CLASSES[band])}
          style={{ width: `${fill * 100}%` }}
        />
      </div>
      <span className="font-medium">{pctRounded}%</span>
    </div>
  );
}
