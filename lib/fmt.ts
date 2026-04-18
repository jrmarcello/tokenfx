const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const USD_FINE = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});

const COMPACT = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

const DATE = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

export const fmtUsd = (n: number): string => USD.format(n);
export const fmtUsdFine = (n: number): string => USD_FINE.format(n);
export const fmtCompact = (n: number): string => COMPACT.format(n);
export const fmtNum = (n: number): string => n.toLocaleString('en-US');
export const fmtPct = (n: number | null): string =>
  n === null ? '—' : `${(n * 100).toFixed(1)}%`;
export const fmtDate = (ms: number): string => DATE.format(new Date(ms));
export const fmtDateTime = (ms: number): string => new Date(ms).toLocaleString();
export const fmtTime = (ms: number): string => new Date(ms).toLocaleTimeString();
export const fmtRating = (n: number | null): string =>
  n === null ? '—' : n.toFixed(2);
export const fmtScore = (n: number | null): string =>
  n === null ? '—' : n.toFixed(1);
export const fmtRatio = (n: number | null): string =>
  n === null ? '—' : n.toFixed(2);
