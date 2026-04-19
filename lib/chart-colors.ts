'use client';

import { useSyncExternalStore } from 'react';

export type ChartColors = {
  grid: string;
  axis: string;
  tooltipBg: string;
  tooltipBorder: string;
  tooltipText: string;
  pieStroke: string;
  linePrimary: string;
  lineSecondary: string;
  positive: string;
  negative: string;
};

// Defaults used during SSR and as the initial client render (before the
// external store is subscribed). Values match the dark theme so a cold
// render in dark mode is visually stable.
const DEFAULTS: ChartColors = {
  grid: '#262626',
  axis: '#737373',
  tooltipBg: '#171717',
  tooltipBorder: '#262626',
  tooltipText: '#e5e5e5',
  pieStroke: '#171717',
  linePrimary: '#10b981',
  lineSecondary: '#a78bfa',
  positive: '#10b981',
  negative: '#ef4444',
};

const VARS: Record<keyof ChartColors, string> = {
  grid: '--chart-grid',
  axis: '--chart-axis',
  tooltipBg: '--chart-tooltip-bg',
  tooltipBorder: '--chart-tooltip-border',
  tooltipText: '--chart-tooltip-text',
  pieStroke: '--chart-pie-stroke',
  linePrimary: '--chart-line-primary',
  lineSecondary: '--chart-line-secondary',
  positive: '--chart-positive',
  negative: '--chart-negative',
};

function readFromDom(): ChartColors {
  if (typeof window === 'undefined') return DEFAULTS;
  const s = getComputedStyle(document.documentElement);
  const out = { ...DEFAULTS };
  (Object.keys(VARS) as Array<keyof ChartColors>).forEach((k) => {
    const v = s.getPropertyValue(VARS[k]).trim();
    if (v) out[k] = v;
  });
  return out;
}

// useSyncExternalStore needs referentially-stable snapshots. We cache the
// last result and only allocate a new object when any var changed, so
// subscribers aren't re-rendered on every DOM mutation when colors are
// unchanged.
let cached: ChartColors = DEFAULTS;

function snapshotDom(): ChartColors {
  const fresh = readFromDom();
  const differs = (Object.keys(fresh) as Array<keyof ChartColors>).some(
    (k) => fresh[k] !== cached[k],
  );
  if (differs) cached = fresh;
  return cached;
}

function subscribe(onChange: () => void): () => void {
  const obs = new MutationObserver(onChange);
  obs.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class'],
  });
  return () => obs.disconnect();
}

function getServerSnapshot(): ChartColors {
  return DEFAULTS;
}

/**
 * Read the current Recharts color palette from CSS vars on the `<html>`
 * element. Values update when `next-themes` toggles the `.dark` class —
 * a MutationObserver drives the re-read via React 18+ `useSyncExternalStore`.
 *
 * Use this hook inside Client Components that feed Recharts props that
 * don't accept CSS `var(...)` strings directly (e.g. `Tooltip.contentStyle`,
 * `Pie.stroke`). For simple SVG attrs like `<CartesianGrid stroke>`, you
 * can also pass `"var(--chart-grid)"` as a literal string.
 */
export function useChartColors(): ChartColors {
  return useSyncExternalStore(subscribe, snapshotDom, getServerSnapshot);
}
