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

// Date / time formatters pinned to pt-BR + 24h clock. Don't rely on
// `toLocaleString()` without a locale — Node picks up `LANG`/system
// locale and flips between en-US and pt-BR across environments,
// producing mixed formats in the UI.
const DATE = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

const DATE_TIME = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const TIME = new Intl.DateTimeFormat('pt-BR', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export const fmtUsd = (n: number): string => USD.format(n);
export const fmtUsdFine = (n: number): string => USD_FINE.format(n);
export const fmtCompact = (n: number): string => COMPACT.format(n);
export const fmtNum = (n: number): string => n.toLocaleString('en-US');
export const fmtPct = (n: number | null): string =>
  n === null ? '—' : `${(n * 100).toFixed(1)}%`;
export const fmtDate = (ms: number): string => DATE.format(new Date(ms));
export const fmtDateTime = (ms: number): string => DATE_TIME.format(new Date(ms));
export const fmtTime = (ms: number): string => TIME.format(new Date(ms));
export const fmtRating = (n: number | null): string =>
  n === null ? '—' : n.toFixed(2);
export const fmtScore = (n: number | null): string =>
  n === null ? '—' : n.toFixed(1);
export const fmtRatio = (n: number | null): string =>
  n === null ? '—' : n.toFixed(2);
