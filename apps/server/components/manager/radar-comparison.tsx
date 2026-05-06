'use client';

/**
 * Radar comparison chart — manager-dashboard-v2 REQ-6 + Q13.
 *
 * Renders a Recharts `RadarChart` with 5 axes (cache hit, good session %,
 * subagent adoption %, Edit-tool share, Read-tool share). One polygon per
 * team. Values are min-max normalized to [0, 1] across the manager's team
 * set (done upstream in `getRadarComparison` via `normalizeRadarMetrics`)
 * so the chart shows **relative** standing, intentionally hiding absolute
 * numbers (anti-surveillance trade-off).
 *
 * **Q13 lock — TC-I-59 / TC-E2E-13**: when `comparison` is `null` (manager
 * has only 1 team — `getRadarComparison` returns null when `teamIds.length
 * < 2`), the component returns `null` so the radar section is **absent
 * from the DOM** entirely (not just hidden via CSS). The page caller is
 * expected to skip the wrapping section when this component returns null;
 * we additionally guard at this leaf so a misuse upstream still does the
 * right thing.
 *
 * Client-only because Recharts uses ResizeObserver via `ResponsiveContainer`.
 */
import {
  Legend,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';

export type RadarComparisonTeam = {
  teamId: string;
  /** Normalized 0..1 axes from `normalizeRadarMetrics`. */
  cacheHit: number;
  goodSessionPct: number;
  subagentAdoptionPct: number;
  editToolShare: number;
  readToolShare: number;
};

type Props = {
  /** `null` when the manager has < 2 teams (Q13). Component returns null. */
  comparison: ReadonlyArray<RadarComparisonTeam> | null;
  /** Optional map `teamId -> teamName` for legend labels. */
  teamNameById?: ReadonlyMap<string, string>;
  testId?: string;
};

// Limited palette — REQ-6 caps at 6 teams (multi-select handles >6 upstream).
const TEAM_COLORS = [
  '#2563eb',
  '#16a34a',
  '#9333ea',
  '#ea580c',
  '#0891b2',
  '#dc2626',
] as const;

type RadarRow = {
  axis: string;
  [teamLabel: string]: string | number;
};

const buildRadarData = (
  comparison: ReadonlyArray<RadarComparisonTeam>,
  teamLabel: (teamId: string) => string,
): RadarRow[] => {
  // Recharts RadarChart wants one row per axis with one column per series.
  const axes: Array<{ key: keyof RadarComparisonTeam; label: string }> = [
    { key: 'cacheHit', label: 'Cache hit' },
    { key: 'goodSessionPct', label: 'Good sessions' },
    { key: 'subagentAdoptionPct', label: 'Subagents' },
    { key: 'editToolShare', label: 'Edit share' },
    { key: 'readToolShare', label: 'Read share' },
  ];
  return axes.map(({ key, label }) => {
    const row: RadarRow = { axis: label };
    for (const team of comparison) {
      row[teamLabel(team.teamId)] = Number(team[key]);
    }
    return row;
  });
};

export const RadarComparison = ({
  comparison,
  teamNameById,
  testId,
}: Props) => {
  // Q13: render absolutely nothing when there is no comparison set. Returning
  // null (NOT an empty wrapper) keeps the section out of the DOM so
  // TC-I-59 / TC-E2E-13 pass — they assert ABSENCE, not hidden visibility.
  if (comparison === null || comparison.length < 2) return null;

  const teamLabel = (teamId: string): string =>
    teamNameById?.get(teamId) ?? teamId;
  const data = buildRadarData(comparison, teamLabel);

  return (
    <div
      role="img"
      aria-label="Team comparison (5 effectiveness axes)"
      className="h-80 w-full rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
      style={{ minHeight: '20rem' }}
      data-testid={testId}
      // Deterministic source-of-truth count for E2E (TC-E2E-02): exposes
      // the team count from server-rendered props, independent of Recharts'
      // ResponsiveContainer/ResizeObserver render timing in headless
      // Chromium. A zero-height container can transiently suppress the
      // legend + polygon paths, but this attribute is always present.
      data-team-count={comparison.length}
    >
      <ResponsiveContainer>
        <RadarChart data={data} outerRadius="75%">
          <PolarGrid stroke="#e5e7eb" />
          <PolarAngleAxis dataKey="axis" tick={{ fontSize: 11, fill: '#6b7280' }} />
          <PolarRadiusAxis
            angle={90}
            domain={[0, 1]}
            tick={{ fontSize: 10, fill: '#9ca3af' }}
            tickCount={3}
          />
          {comparison.map((team, idx) => {
            const label = teamLabel(team.teamId);
            const color = TEAM_COLORS[idx % TEAM_COLORS.length];
            return (
              <Radar
                key={team.teamId}
                name={label}
                dataKey={label}
                stroke={color}
                fill={color}
                fillOpacity={0.2}
                isAnimationActive={false}
              />
            );
          })}
          <Tooltip contentStyle={{ fontSize: 12 }} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
};
