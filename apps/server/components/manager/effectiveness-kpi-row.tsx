/**
 * Effectiveness KPI row — manager-dashboard-v2 REQ-1..4 + Q2-C.
 *
 * Composes 4 `<KpiCard>` tiles for the `/manager/effectiveness` page header
 * (TC-I-14: 4 KPI cards in HTML, TC-E2E-01: KPI section present in DOM):
 *   1. Cache hit ratio (REQ-1)        — `kpi-cache-hit`
 *   2. Good session %   (REQ-2)        — `kpi-good-session`
 *   3. Subagent adoption % (REQ-4)     — `kpi-subagent-adoption`
 *   4. Composite avg (Q2-C summary)    — `kpi-composite`
 *
 * Pure server component. Numbers are pre-formatted by the page (the row does
 * not localize / round) — same convention as the existing org overview.
 *
 * Aggregation note (REQ-1..4 + spec-locked manager scope):
 *   The page passes per-team metrics aggregated to a single number. Since a
 *   manager scopes to their org's teams (locked spec), the page is responsible
 *   for the cross-team mean (documented inline at the call site). This row
 *   only renders.
 */
import { KpiCard } from '@/components/manager/kpi-card';

type Props = {
  cacheHitPct: string;
  goodSessionPct: string;
  subagentAdoptionPct: string;
  compositeAvg: string;
  /** Optional subtext per tile (e.g. "across N teams"). */
  subtext?: string;
};

export const EffectivenessKpiRow = ({
  cacheHitPct,
  goodSessionPct,
  subagentAdoptionPct,
  compositeAvg,
  subtext,
}: Props) => {
  return (
    <div
      className="grid grid-cols-2 gap-4 sm:grid-cols-4"
      data-testid="effectiveness-kpi-row"
    >
      <KpiCard
        label="Cache hit"
        value={cacheHitPct}
        subtext={subtext}
        testId="kpi-cache-hit"
      />
      <KpiCard
        label="Good sessions"
        value={goodSessionPct}
        subtext={subtext}
        testId="kpi-good-session"
      />
      <KpiCard
        label="Subagent adoption"
        value={subagentAdoptionPct}
        subtext={subtext}
        testId="kpi-subagent-adoption"
      />
      <KpiCard
        label="Composite (avg)"
        value={compositeAvg}
        subtext={subtext}
        testId="kpi-composite"
      />
    </div>
  );
};
