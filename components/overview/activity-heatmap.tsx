'use client';

import { useRouter } from 'next/navigation';
import {
  EMERALD_PALETTE,
  arrangeWeeks,
  monthLabels,
  type Week,
} from '@/lib/analytics/heatmap';
import {
  EFFECTIVENESS_PALETTE,
  effectivenessLevelFor,
} from '@/lib/analytics/effectiveness-v2';
import type { DailyPoint } from '@/lib/queries/overview';
import { fmtUsd } from '@/lib/fmt';

type ColorScheme = 'spend' | 'effectiveness';

/**
 * Per-day point consumed by the heatmap. The `spend` field doubles as the
 * generic "value" channel — when `colorScheme === 'effectiveness'` callers
 * pass the score (0..100) in `score` and a non-zero `spend` to mark the day
 * as active (drives empty-state detection + click-through). `score` is
 * ignored under the default `'spend'` scheme.
 */
type HeatmapDataPoint = DailyPoint & { score?: number | null };

type Props = {
  data: HeatmapDataPoint[];
  colorScheme?: ColorScheme;
};

const CELL = 12;
const GAP = 2;
const STEP = CELL + GAP;
const LEFT_LABEL_W = 28;
const TOP_LABEL_H = 16;
const LEGEND_GAP = 12;

const DAY_LABELS: Array<{ row: number; text: string }> = [
  { row: 1, text: 'Mon' },
  { row: 3, text: 'Wed' },
  { row: 5, text: 'Fri' },
];

const spendCellTitle = (
  date: string,
  spend: number,
  sessionCount: number,
): string => {
  if (spend <= 0) return `${date} — sem atividade`;
  const noun = sessionCount === 1 ? 'sessão' : 'sessões';
  return `${date} — ${fmtUsd(spend)} (${sessionCount} ${noun})`;
};

const effectivenessCellTitle = (
  date: string,
  score: number | null | undefined,
  sessionCount: number,
): string => {
  if (score === null || score === undefined) {
    return `${date} — sem atividade`;
  }
  const noun = sessionCount === 1 ? 'sessão' : 'sessões';
  return `${date} — score ${Math.round(score)}/100 (${sessionCount} ${noun})`;
};

export function ActivityHeatmap({ data, colorScheme = 'spend' }: Props) {
  const router = useRouter();

  if (data.length === 0 || data.every((d) => d.spend === 0)) {
    return (
      <div className="flex h-32 items-center justify-center rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 text-sm text-neutral-500">
        Sem sessões ainda
      </div>
    );
  }

  // Index input by date so we can recover the score (effectiveness scheme)
  // for cells that `arrangeWeeks` produces — `arrangeWeeks` only knows about
  // the `spend`/`sessionCount` channels by design.
  const scoreByDate = new Map<string, number | null | undefined>();
  if (colorScheme === 'effectiveness') {
    for (const d of data) scoreByDate.set(d.date, d.score);
  }

  const palette =
    colorScheme === 'effectiveness' ? EFFECTIVENESS_PALETTE : EMERALD_PALETTE;

  const endDate = data[data.length - 1].date;
  const allWeeks: Week[] = arrangeWeeks(data, endDate);
  const allMonths = monthLabels(allWeeks);

  // Trim a leading week that is almost entirely null padding (≤ 1 real cell)
  // so the grid doesn't start with an isolated dangling cell.
  const firstWeekCellCount =
    allWeeks[0]?.filter((c) => c !== null).length ?? 0;
  const trim = firstWeekCellCount <= 1 && allWeeks.length > 1 ? 1 : 0;
  const weeks = allWeeks.slice(trim);
  const months = allMonths.slice(trim);

  const svgWidth = LEFT_LABEL_W + weeks.length * STEP;
  const svgHeight = TOP_LABEL_H + 7 * STEP;

  const navigateToDate = (date: string, spend: number) => {
    if (spend <= 0) return;
    router.push(`/sessions?date=${date}`);
  };

  const onSvgClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const target = e.target as SVGElement;
    const date = target.getAttribute('data-date');
    const spendAttr = target.getAttribute('data-spend');
    if (!date || !spendAttr) return;
    navigateToDate(date, Number(spendAttr));
  };

  const onCellKeyDown = (
    e: React.KeyboardEvent<SVGRectElement>,
    date: string,
    spend: number,
  ) => {
    if (spend <= 0) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      navigateToDate(date, spend);
    }
  };

  return (
    <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
      {/* Horizontal scroll on narrow viewports — the 53-week grid has an
          intrinsic minimum width; letting the SVG stretch to w-full in
          mobile compresses cells to ~5px and erases the month labels. */}
      <div className="w-full overflow-x-auto">
        <svg
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          preserveAspectRatio="xMidYMid meet"
          role="grid"
          aria-label="Atividade diária do último ano"
          onClick={onSvgClick}
          className="block h-auto w-full min-w-[720px]"
        >
          {months.map((label, i) =>
            label ? (
              <text
                key={`m-${i}`}
                x={LEFT_LABEL_W + i * STEP}
                y={TOP_LABEL_H - 4}
                fontSize={10}
                fill="#737373"
              >
                {label}
              </text>
            ) : null,
          )}

          {DAY_LABELS.map(({ row, text }) => (
            <text
              key={`d-${row}`}
              x={0}
              y={TOP_LABEL_H + row * STEP + 10}
              fontSize={10}
              fill="#737373"
            >
              {text}
            </text>
          ))}

          {weeks.map((week, w) => (
            <g key={`w-${w}`}>
              {week.map((cell, r) => {
                const x = LEFT_LABEL_W + w * STEP;
                const y = TOP_LABEL_H + r * STEP;
                if (cell === null) {
                  return (
                    <rect
                      key={`c-${w}-${r}`}
                      x={x}
                      y={y}
                      width={CELL}
                      height={CELL}
                      fill="transparent"
                    />
                  );
                }
                // Resolve the level + tooltip per scheme. For effectiveness
                // we override the max-relative `cell.level` from
                // `arrangeWeeks` with the absolute 0..100 mapping so a score
                // of 30 always renders as L2 regardless of weekly maxima
                // (REQ-24).
                let level: 0 | 1 | 2 | 3 | 4;
                let title: string;
                if (colorScheme === 'effectiveness') {
                  const score = scoreByDate.get(cell.date) ?? null;
                  level = effectivenessLevelFor(score);
                  title = effectivenessCellTitle(
                    cell.date,
                    score,
                    cell.sessionCount,
                  );
                } else {
                  level = cell.level;
                  title = spendCellTitle(
                    cell.date,
                    cell.spend,
                    cell.sessionCount,
                  );
                }
                const clickable = cell.spend > 0;
                return (
                  <rect
                    key={`c-${w}-${r}`}
                    x={x}
                    y={y}
                    width={CELL}
                    height={CELL}
                    rx={2}
                    fill={palette[level]}
                    data-date={cell.date}
                    data-spend={cell.spend}
                    data-level={level}
                    role="gridcell"
                    aria-label={title}
                    tabIndex={clickable ? 0 : -1}
                    onKeyDown={(e) =>
                      onCellKeyDown(e, cell.date, cell.spend)
                    }
                    className={
                      clickable
                        ? 'cursor-pointer outline-none focus-visible:stroke-emerald-300 focus-visible:stroke-2'
                        : 'cursor-default'
                    }
                  >
                    <title>{title}</title>
                  </rect>
                );
              })}
            </g>
          ))}
        </svg>
      </div>

      <div
        className="flex items-center justify-end gap-1.5 text-[11px] text-neutral-500"
        style={{ marginTop: LEGEND_GAP }}
      >
        <span>Menos</span>
        {([0, 1, 2, 3, 4] as const).map((lvl) => (
          <span
            key={`sw-${lvl}`}
            aria-hidden="true"
            className="inline-block rounded-sm"
            style={{
              width: CELL,
              height: CELL,
              backgroundColor: palette[lvl],
            }}
          />
        ))}
        <span>Mais</span>
      </div>
    </div>
  );
}
