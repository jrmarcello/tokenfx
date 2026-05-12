'use client';

/**
 * `<AuditLogFilters />` — leaf Client Component for `/manager/audit-log`.
 *
 * URL is the source of truth: every submit calls `router.push` with the
 * new query-string, which preserves browser back/forward semantics and
 * lets the Server Component re-render on navigation. No DB access here —
 * the only props are the rendered filter VALUES + the outcome enum (a
 * compile-time constant from the page).
 *
 * Implementation notes:
 *  - `useSearchParams` returns the current URL state. We seed local form
 *    state from props (server-parsed values) so a malformed query string
 *    is normalized BEFORE the form mounts. After mount, local state is
 *    the live editing buffer — URL is only updated on submit.
 *  - "Reset" clears local + navigates to the bare path.
 *  - The form uses `method="get"` semantically (filters via URL) but we
 *    intercept onSubmit to drive navigation through Next's router so the
 *    page transition stays client-side.
 */
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';

type InitialFilters = {
  outcome: string;
  iss: string;
  city: string;
  browser: string;
  from: string;
  to: string;
};

type Props = {
  outcomeOptions: ReadonlyArray<string>;
  initialFilters: InitialFilters;
};

const FILTER_BASE_PATH = '/manager/audit-log';

export const AuditLogFilters = ({ outcomeOptions, initialFilters }: Props) => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [state, setState] = useState<InitialFilters>(initialFilters);

  const update = <K extends keyof InitialFilters>(
    key: K,
    value: InitialFilters[K],
  ): void => {
    setState((prev) => ({ ...prev, [key]: value }));
  };

  const buildHref = (filters: InitialFilters): string => {
    const params = new URLSearchParams();
    if (filters.outcome) params.set('outcome', filters.outcome);
    if (filters.iss) params.set('iss', filters.iss);
    if (filters.city) params.set('city', filters.city);
    if (filters.browser) params.set('browser', filters.browser);
    if (filters.from) params.set('from', toIsoStartOfDay(filters.from));
    if (filters.to) params.set('to', toIsoEndOfDay(filters.to));
    // Note: `page` is intentionally dropped on filter change — a new filter
    // set means a new result space; resetting to page 0 is the only sane UX.
    const qs = params.toString();
    return qs.length > 0 ? `${FILTER_BASE_PATH}?${qs}` : FILTER_BASE_PATH;
  };

  const onSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    router.push(buildHref(state));
  };

  const onReset = (): void => {
    const cleared: InitialFilters = {
      outcome: '',
      iss: '',
      city: '',
      browser: '',
      from: '',
      to: '',
    };
    setState(cleared);
    router.push(FILTER_BASE_PATH);
  };

  // `searchParams` is read to make this component re-render reactive to
  // URL changes (e.g. someone clicks a pagination link); without referencing
  // it Next may skip refreshing the hook.
  void searchParams;

  return (
    <form
      onSubmit={onSubmit}
      className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
      data-testid="audit-log-filters"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs font-medium text-neutral-700 dark:text-neutral-300">
          Outcome
          <select
            value={state.outcome}
            onChange={(e) => update('outcome', e.target.value)}
            className="h-9 rounded-md border border-neutral-300 bg-white px-2 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
            data-testid="audit-log-filter-outcome"
          >
            <option value="">All</option>
            {outcomeOptions.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs font-medium text-neutral-700 dark:text-neutral-300">
          Issuer (exact)
          <input
            type="text"
            value={state.iss}
            onChange={(e) => update('iss', e.target.value)}
            maxLength={200}
            placeholder="https://accounts.google.com"
            className="h-9 rounded-md border border-neutral-300 bg-white px-2 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
            data-testid="audit-log-filter-iss"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs font-medium text-neutral-700 dark:text-neutral-300">
          City (substring)
          <input
            type="text"
            value={state.city}
            onChange={(e) => update('city', e.target.value)}
            maxLength={200}
            placeholder="London"
            className="h-9 rounded-md border border-neutral-300 bg-white px-2 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
            data-testid="audit-log-filter-city"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs font-medium text-neutral-700 dark:text-neutral-300">
          Browser (substring of UA)
          <input
            type="text"
            value={state.browser}
            onChange={(e) => update('browser', e.target.value)}
            maxLength={200}
            placeholder="Chrome"
            className="h-9 rounded-md border border-neutral-300 bg-white px-2 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
            data-testid="audit-log-filter-browser"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs font-medium text-neutral-700 dark:text-neutral-300">
          From (UTC)
          <input
            type="date"
            value={dateInputValue(state.from)}
            onChange={(e) => update('from', e.target.value)}
            className="h-9 rounded-md border border-neutral-300 bg-white px-2 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
            data-testid="audit-log-filter-from"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs font-medium text-neutral-700 dark:text-neutral-300">
          To (UTC)
          <input
            type="date"
            value={dateInputValue(state.to)}
            onChange={(e) => update('to', e.target.value)}
            className="h-9 rounded-md border border-neutral-300 bg-white px-2 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
            data-testid="audit-log-filter-to"
          />
        </label>
      </div>

      <div className="mt-4 flex gap-2">
        <button
          type="submit"
          className="inline-flex h-9 items-center justify-center whitespace-nowrap rounded-md bg-neutral-900 px-4 text-sm font-medium text-neutral-50 shadow transition-colors hover:bg-neutral-900/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-950 dark:bg-neutral-50 dark:text-neutral-900 dark:hover:bg-neutral-50/90 dark:focus-visible:ring-neutral-300"
          data-testid="audit-log-filter-apply"
        >
          Apply
        </button>
        <button
          type="button"
          onClick={onReset}
          className="inline-flex h-9 items-center justify-center whitespace-nowrap rounded-md border border-neutral-300 bg-white px-4 text-sm font-medium text-neutral-900 shadow-sm transition-colors hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-950 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800"
          data-testid="audit-log-filter-reset"
        >
          Reset
        </button>
      </div>
    </form>
  );
};

/**
 * `<input type="date">` requires `YYYY-MM-DD`. If the parsed URL value
 * was a full ISO datetime, project just the date slice; otherwise pass
 * through (covers the bare `YYYY-MM-DD` case the user typed).
 */
const dateInputValue = (raw: string): string => {
  if (raw === '') return '';
  // Full ISO datetime → strip to date portion.
  const tIdx = raw.indexOf('T');
  return tIdx > 0 ? raw.slice(0, tIdx) : raw;
};

/**
 * Promote a `YYYY-MM-DD` date input to ISO start-of-day in UTC so the
 * query layer's `gte` comparison is inclusive of the entire selected day.
 */
const toIsoStartOfDay = (yyyyMmDd: string): string => {
  // Already a full datetime — pass through.
  if (yyyyMmDd.includes('T')) return yyyyMmDd;
  return `${yyyyMmDd}T00:00:00.000Z`;
};

/**
 * Promote a `YYYY-MM-DD` date input to ISO end-of-day (23:59:59.999) in
 * UTC so the query layer's `lte` includes the entire selected day.
 */
const toIsoEndOfDay = (yyyyMmDd: string): string => {
  if (yyyyMmDd.includes('T')) return yyyyMmDd;
  return `${yyyyMmDd}T23:59:59.999Z`;
};
