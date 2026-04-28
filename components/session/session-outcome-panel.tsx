import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { InfoTooltip } from '@/components/info-tooltip';
import { fmtCompact } from '@/lib/fmt';
import type { SessionOutcome } from '@/lib/queries/outcomes';

/**
 * Session-level outcome panel: commits attributed to the user in the
 * session window, plus a small grid of LOC / files / reverts derived from
 * `session_outcomes`. Empty-state copy is derived from the persisted
 * `status` field — we never re-touch the filesystem from the UI (REQ-15a).
 *
 * Server Component: reads a plain `outcome` prop and renders synchronously.
 */
export function SessionOutcomePanel({
  outcome,
}: {
  outcome: SessionOutcome | null;
}) {
  return (
    <Card className="bg-white dark:bg-neutral-900 border-neutral-200 dark:border-neutral-800">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
          Outcomes
        </CardTitle>
      </CardHeader>
      <CardContent>
        <PanelBody outcome={outcome} />
      </CardContent>
    </Card>
  );
}

/**
 * Decide which body variant to render. Branches:
 *   - `outcome === null`            → "not yet evaluated" skeleton (no row)
 *   - `status === 'cwd-missing'`    → unavailable copy (cwd-missing)
 *   - `status === 'not-a-git-repo'` → unavailable copy (not a git repo)
 *   - `status === 'no-user-email'`  → unavailable copy (git email)
 *   - `status === 'evaluated' && commit_count === 0` → "no commits attributed"
 *   - `status === 'evaluated' && commit_count  > 0`  → metrics grid
 *
 * Exhaustive switch over `OutcomeStatus` keeps TS honest if a new status
 * value is added later.
 */
function PanelBody({ outcome }: { outcome: SessionOutcome | null }) {
  if (outcome === null) {
    return <NotYetEvaluated />;
  }

  switch (outcome.status) {
    case 'cwd-missing':
    case 'not-a-git-repo':
      return (
        <EmptyMessage>
          Outcomes unavailable: cwd is not a git repository
        </EmptyMessage>
      );
    case 'no-user-email':
      return (
        <EmptyMessage>
          Outcomes unavailable: git user.email not configured
        </EmptyMessage>
      );
    case 'evaluated':
      if (outcome.commitCount === 0) {
        return <EmptyMessage>No commits attributed in this window</EmptyMessage>;
      }
      return <MetricsGrid outcome={outcome} />;
    default: {
      const _exhaustive: never = outcome.status;
      return _exhaustive;
    }
  }
}

const NotYetEvaluated = () => (
  <div className="space-y-3">
    <p className="text-sm text-neutral-600 dark:text-neutral-400">
      Outcome not yet evaluated. Run{' '}
      <code className="rounded border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 px-1.5 py-0.5 font-mono text-[11px] text-neutral-600 dark:text-neutral-400">
        pnpm ingest
      </code>{' '}
      to refresh.
    </p>
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-full" />
    </div>
  </div>
);

const EmptyMessage = ({ children }: { children: React.ReactNode }) => (
  <p className="text-sm text-neutral-600 dark:text-neutral-400">{children}</p>
);

/**
 * Metrics grid rendered for `status === 'evaluated' && commit_count > 0`.
 * `merged_pr_count` is suppressed when null (GH lookup disabled / not yet
 * evaluated) — `0` is a meaningful "evaluated, zero merged" value and
 * still renders.
 */
const MetricsGrid = ({ outcome }: { outcome: SessionOutcome }) => {
  const showReverts = outcome.revertsWithin7d > 0;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <Metric
        label="Commits"
        value={fmtCompact(outcome.commitCount)}
      />
      <Metric
        label="LOC"
        value={
          <span className="inline-flex items-baseline gap-2 text-2xl font-semibold tabular-nums">
            <span className="text-emerald-600 dark:text-emerald-400">
              +{fmtCompact(outcome.locAdded)}
            </span>
            <span className="text-neutral-300 dark:text-neutral-700">/</span>
            <span className="text-red-600 dark:text-red-400">
              −{fmtCompact(outcome.locRemoved)}
            </span>
          </span>
        }
      />
      <Metric
        label="Files changed"
        value={fmtCompact(outcome.filesChanged)}
      />
      <Metric
        label={
          <span className="inline-flex items-center gap-1.5">
            <span>Reverts (7d)</span>
            <InfoTooltip label="Como reverts são contados?" align="end">
              Heuristic: counts commits whose message matches{' '}
              <code className="font-mono">Revert.*&lt;short-sha&gt;</code>.
              Misses cherry-picked reverts, rebases that drop commits, and
              manual reverts without the short-sha pattern.
            </InfoTooltip>
          </span>
        }
        value={
          showReverts ? (
            <span className="inline-flex items-center gap-2">
              <span className="rounded-md bg-red-100 dark:bg-red-950/60 px-2 py-0.5 text-base font-semibold text-red-700 dark:text-red-300">
                {fmtCompact(outcome.revertsWithin7d)}
              </span>
            </span>
          ) : (
            <span className="text-neutral-700 dark:text-neutral-300">0</span>
          )
        }
      />
      {outcome.mergedPrCount !== null && (
        <Metric
          label="Merged PRs"
          value={fmtCompact(outcome.mergedPrCount)}
        />
      )}
    </div>
  );
};

const Metric = ({
  label,
  value,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
}) => (
  <div className="flex flex-col gap-1">
    <div className="text-xs font-normal text-neutral-600 dark:text-neutral-400">
      {label}
    </div>
    <div className="text-2xl font-semibold tabular-nums tracking-tight">
      {value}
    </div>
  </div>
);
