import type * as React from 'react';
import { ActivityHeatmap } from '@/components/overview/activity-heatmap';

/**
 * Per-day effectiveness point as produced by `getDailyEffectivenessHeatmap`
 * (TASK-6). `score` is `null` for days without rated sessions.
 */
type EffectivenessHeatmapInput = {
  date: string;
  score: number | null;
  sessionCount: number;
};

/**
 * Server Component wrapper around `<ActivityHeatmap />` that switches the
 * underlying calendar to the effectiveness colour scheme. The shared heatmap
 * primitive consumes `DailyPoint & { score? }` — this adapter fills the
 * spend-channel fields the primitive needs for empty-state detection
 * (`spend > 0` flags an "active" day) without leaking spend semantics into
 * effectiveness callers.
 */
export function EffectivenessHeatmap({
  data,
}: {
  data: EffectivenessHeatmapInput[];
}): React.JSX.Element {
  const adapted = data.map((d) => ({
    date: d.date,
    // `spend` doubles as the "is active" flag for the underlying heatmap; we
    // mark days with sessions as active (1) so they render and stay clickable
    // even when the day has no rated sessions (score === null).
    spend: d.sessionCount > 0 ? 1 : 0,
    tokens: 0,
    sessionCount: d.sessionCount,
    score: d.score,
  }));

  return <ActivityHeatmap data={adapted} colorScheme="effectiveness" />;
}
