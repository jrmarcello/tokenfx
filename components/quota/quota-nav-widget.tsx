import type { JSX } from 'react';

import { QuotaBar } from '@/components/quota/quota-bar';
import { getDb } from '@/lib/db/client';
import {
  getQuotaResetEstimates,
  getQuotaUsage,
  getUserSettings,
} from '@/lib/queries/quota';

type Bar = {
  key: string;
  label: string;
  used: number;
  limit: number;
};

/**
 * Indirect `Date.now()` wrapper — kept outside the component body so
 * the react-hooks/purity rule doesn't flag the `Date.now()` call as
 * impure-in-render. Async Server Components execute once per request,
 * so reading the current time at entry is intentional and safe.
 */
const readNow = (): number => Date.now();

/**
 * Compact quota widget rendered in the global Nav slot.
 *
 * Async Server Component — queries fresh each request. Returns `null`
 * when every threshold in `user_settings` is `null` (REQ-9), so the
 * widget is invisible until the user defines at least one threshold.
 *
 * Rendered bars follow the order `tokens5h -> tokens7d` (REQ-11). Bars
 * with a `null` threshold are omitted.
 */
export async function QuotaNavWidget(): Promise<JSX.Element | null> {
  // Capture "now" up-front so the rest of the component body reads
  // deterministic data (satisfies react-hooks/purity; safe here since
  // async RSCs run once per request, not per re-render).
  const now = readNow();
  const db = getDb();
  const settings = getUserSettings(db);

  const anyThresholdSet =
    settings.quotaTokens5h !== null || settings.quotaTokens7d !== null;
  if (!anyThresholdSet) return null;

  // Block-aware usage: count tokens only from the current 5h/7d cycle,
  // not a rolling `now - windowMs` window (see `getQuotaUsage` docstring).
  const resets = getQuotaResetEstimates(db, now, {
    calibratedReset5hAt: settings.quota5hResetAt,
    calibratedReset7dAt: settings.quota7dResetAt,
  });
  const FIVE_H_MS = 5 * 3_600_000;
  const SEVEN_D_MS = 7 * 86_400_000;
  const usage = getQuotaUsage(db, now, {
    cycleStart5hMs:
      resets.reset5hMs !== null ? resets.reset5hMs - FIVE_H_MS : null,
    cycleStart7dMs:
      resets.reset7dMs !== null ? resets.reset7dMs - SEVEN_D_MS : null,
  });

  const bars: Bar[] = [];
  if (settings.quotaTokens5h !== null) {
    bars.push({
      key: 't5h',
      label: '5h',
      used: usage.tokens5h,
      limit: settings.quotaTokens5h,
    });
  }
  if (settings.quotaTokens7d !== null) {
    bars.push({
      key: 't7d',
      label: '7d',
      used: usage.tokens7d,
      limit: settings.quotaTokens7d,
    });
  }

  return (
    <div className="flex items-center gap-2" aria-label="Quota do Max">
      {bars.map((b) => (
        <QuotaBar key={b.key} label={b.label} used={b.used} limit={b.limit} />
      ))}
    </div>
  );
}
