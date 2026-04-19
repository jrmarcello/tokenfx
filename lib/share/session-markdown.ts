import type { SessionDetail, TurnDetail } from '@/lib/queries/session';
import type { SessionOtelStats } from '@/lib/queries/otel';
import type { SubagentBreakdownRow } from '@/lib/queries/subagent';
import type { CostSource } from '@/lib/queries/overview';
import {
  fmtCompact,
  fmtDateTime,
  fmtPct,
  fmtRating,
  fmtUsd,
} from '@/lib/fmt';

export type { CostSource };
export type OtelSessionStats = SessionOtelStats;

export type SessionShareInput = {
  session: SessionDetail;
  turns: TurnDetail[];
  otel: SessionOtelStats;
  breakdown: SubagentBreakdownRow[];
  globalRate: number | null;
};

export type SessionShareOptions = {
  redact: boolean;
};

/**
 * Returns the minimum fence width (count of consecutive backticks) that can
 * safely wrap `content` as a fenced code block: `max(3, 1 + longest run of
 * backticks found in content)`. This preserves backtick-containing content
 * without prematurely closing the fence.
 */
export const computeFenceWidth = (content: string): number => {
  const runs = content.match(/`+/g);
  if (!runs) return 3;
  const maxRun = Math.max(...runs.map((r) => r.length));
  return Math.max(3, maxRun + 1);
};

/** Truncates `s` to at most `n` chars, appending `…` when shortened. */
export const truncate = (s: string, n: number): string =>
  s.length <= n ? s : s.slice(0, n) + '…';

/**
 * Formats `date` as `YYYYMMDD` in the local timezone. Used for export
 * filenames (tokenfx-session-<id>-YYYYMMDD.md), independent of the runtime
 * locale or UTC offset.
 */
export const formatYyyymmdd = (date: Date): string => {
  const y = String(date.getFullYear()).padStart(4, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
};

const REDACTED = '[REDIGIDO]';
const MAX_TOOL_CHARS = 200;

const costSourceTag = (src: CostSource, globalRate: number | null): string => {
  switch (src) {
    case 'otel':
      return '[otel]';
    case 'calibrated':
      return globalRate === null
        ? '[calibrado]'
        : `[calibrado, ratio ${globalRate.toFixed(2)}]`;
    case 'list':
      return '[list]';
    default: {
      const _exhaustive: never = src;
      return _exhaustive;
    }
  }
};

const ratingLabel = (value: -1 | 0 | 1): string => {
  switch (value) {
    case 1:
      return '👍 Bom';
    case 0:
      return '😐 Neutro';
    case -1:
      return '👎 Ruim';
    default: {
      const _exhaustive: never = value;
      return _exhaustive;
    }
  }
};

const formatActiveTime = (seconds: number): string => {
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)}h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds)}s`;
};

const TURN_TIME_FMT = new Intl.DateTimeFormat('pt-BR', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const formatTurnTime = (ms: number): string => TURN_TIME_FMT.format(new Date(ms));

const renderFencedText = (content: string): string => {
  const width = computeFenceWidth(content);
  const fence = '`'.repeat(width);
  return `${fence}text\n${content}\n${fence}`;
};

const isNonEmpty = (s: string | null): s is string =>
  s !== null && s.length > 0;

const renderMetadata = (session: SessionShareInput['session']): string => {
  const parts = [
    `**ID**: ${session.id}`,
    `**Início**: ${fmtDateTime(session.startedAt)}`,
    `**Fim**: ${fmtDateTime(session.endedAt)}`,
    `**Branch**: ${session.gitBranch ?? '—'}`,
  ];
  return parts.join(' · ');
};

const renderKpis = (
  session: SessionShareInput['session'],
  globalRate: number | null,
): string => {
  const tag = costSourceTag(session.costSource, globalRate);
  return [
    '## KPIs',
    '',
    `- **Custo**: ${fmtUsd(session.totalCostUsd)} ${tag}`,
    `- **Turnos**: ${session.turnCount}`,
    `- **Cache hit**: ${fmtPct(session.cacheHitRatio)}`,
    `- **Avaliação média**: ${fmtRating(session.avgRating)}`,
  ].join('\n');
};

const renderOtel = (otel: SessionOtelStats): string | null => {
  if (!otel.hasData) return null;
  const lines = [
    '## OTEL',
    '',
    `- **Accept rate**: ${fmtPct(otel.acceptRate)}`,
    `- **Linhas +**: ${fmtCompact(otel.linesAdded)}`,
    `- **Linhas −**: ${fmtCompact(otel.linesRemoved)}`,
  ];
  if (otel.activeSeconds > 0) {
    lines.push(`- **Active time**: ${formatActiveTime(otel.activeSeconds)}`);
  }
  return lines.join('\n');
};

const renderSubagents = (breakdown: SubagentBreakdownRow[]): string | null => {
  if (breakdown.length === 0) return null;
  const sorted = [...breakdown].sort((a, b) => b.costUsd - a.costUsd);
  const lines = [
    '## Sub-agentes',
    '',
    '| Tipo | Turnos | Custo | % custo |',
    '| --- | --- | --- | --- |',
  ];
  for (const row of sorted) {
    const tipo = row.subagentType ?? 'Main';
    const pct = `${(row.pct * 100).toFixed(1)}%`;
    lines.push(
      `| ${tipo} | ${row.turns} | ${fmtUsd(row.costUsd)} | ${pct} |`,
    );
  }
  return lines.join('\n');
};

const renderToolCall = (
  tc: TurnDetail['toolCalls'][number],
  redact: boolean,
): string => {
  const status = tc.resultIsError ? '✗' : '✓';
  const inputText = redact ? REDACTED : truncate(tc.inputJson, MAX_TOOL_CHARS);
  const base = `- ${status} **${tc.toolName}** — input: \`${inputText}\``;
  if (tc.resultJson === null) return base;
  const resultText = redact
    ? REDACTED
    : truncate(tc.resultJson, MAX_TOOL_CHARS);
  return `${base} — result: \`${resultText}\``;
};

const renderRating = (
  rating: NonNullable<TurnDetail['rating']>,
  redact: boolean,
): string => {
  const base = `**Avaliação:** ${ratingLabel(rating.value)}`;
  if (!isNonEmpty(rating.note)) return base;
  const note = redact ? REDACTED : rating.note;
  return `${base} — ${note}`;
};

const renderTurn = (
  turn: TurnDetail,
  redact: boolean,
): string => {
  const header = `### Turno ${turn.sequence} — ${turn.model} — ${formatTurnTime(turn.timestamp)}`;

  const blocks: string[] = [];

  if (isNonEmpty(turn.userPrompt)) {
    const prompt = redact ? REDACTED : turn.userPrompt;
    blocks.push(`**Usuário:**\n\n${renderFencedText(prompt)}`);
  }

  if (isNonEmpty(turn.assistantText)) {
    const text = redact ? REDACTED : turn.assistantText;
    blocks.push(`**Assistente:**\n\n${text}`);
  }

  if (turn.toolCalls.length > 0) {
    const bullets = turn.toolCalls
      .map((tc) => renderToolCall(tc, redact))
      .join('\n');
    blocks.push(`**Ferramentas:**\n${bullets}`);
  }

  if (turn.rating !== null) {
    blocks.push(renderRating(turn.rating, redact));
  }

  if (blocks.length === 0) {
    return `${header}\n\n_(sem conteúdo)_`;
  }

  return `${header}\n\n${blocks.join('\n\n')}`;
};

const renderTranscript = (
  turns: TurnDetail[],
  redact: boolean,
): string => {
  if (turns.length === 0) {
    return '## Transcript\n\n_Sem turnos nesta sessão._';
  }
  const body = turns.map((t) => renderTurn(t, redact)).join('\n\n');
  return `## Transcript\n\n${body}`;
};

/**
 * Renders a read-only markdown export of a session for pasting into
 * issues/docs. Pure function: all data is passed in, nothing is fetched,
 * nothing is logged. When `opts.redact` is true, user prompts, assistant
 * text, tool-call inputs/results, and rating notes are replaced with
 * `[REDIGIDO]` — KPIs, timestamps, tool names, and rating values are
 * preserved so the structure of the session remains citable.
 */
export const renderSessionMarkdown = (
  input: SessionShareInput,
  opts: SessionShareOptions,
): string => {
  const { session, turns, otel, breakdown, globalRate } = input;
  const { redact } = opts;

  const sections: string[] = [
    `# Sessão: ${session.project}`,
    renderMetadata(session),
    renderKpis(session, globalRate),
  ];

  const otelBlock = renderOtel(otel);
  if (otelBlock) sections.push(otelBlock);

  const subBlock = renderSubagents(breakdown);
  if (subBlock) sections.push(subBlock);

  sections.push(renderTranscript(turns, redact));

  return sections.join('\n\n') + '\n';
};
