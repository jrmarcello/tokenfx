/**
 * KPI card — server-renderable presentational tile for the manager dashboard.
 *
 * Used by the org overview (REQ-18 spend windows, REQ-20 DAU/WAU/MAU) and the
 * team detail page (REQ-21 team spend). No interactivity, no client runtime —
 * keep it a pure server component so it stays in the React Server tree.
 *
 * `subtext` is rendered as plain text (e.g. "X otel · Y calibrated · Z list"
 * for the source-mix breakdown — REQ-18 (d)). The caller is responsible for
 * formatting numbers; this component does not localize.
 */
type Props = {
  label: string;
  value: string;
  subtext?: string;
  /** Optional `data-testid` so E2E tests (TC-E2E-01..02) can pin specific tiles. */
  testId?: string;
};

export const KpiCard = ({ label, value, subtext, testId }: Props) => {
  return (
    <div
      className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
      data-testid={testId}
    >
      <div className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-neutral-900 dark:text-neutral-100">
        {value}
      </div>
      {subtext ? (
        <div className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
          {subtext}
        </div>
      ) : null}
    </div>
  );
};
