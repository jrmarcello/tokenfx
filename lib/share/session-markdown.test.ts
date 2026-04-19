import { describe, it, expect } from 'vitest';
import type { SessionDetail, TurnDetail } from '@/lib/queries/session';
import type { SessionOtelStats } from '@/lib/queries/otel';
import {
  renderSessionMarkdown,
  computeFenceWidth,
  truncate,
  formatYyyymmdd,
  type SessionShareInput,
} from './session-markdown';

// ----- Stubs / factories (hand-written, no mocking lib) -----

const BASE_SESSION: SessionDetail = {
  id: 'session-123',
  slug: null,
  cwd: '/tmp',
  project: 'tokenfx',
  gitBranch: 'main',
  ccVersion: '1.0.0',
  startedAt: Date.UTC(2026, 0, 2, 12, 0, 0),
  endedAt: Date.UTC(2026, 0, 2, 13, 0, 0),
  totalInputTokens: 100,
  totalOutputTokens: 200,
  totalCacheReadTokens: 50,
  totalCacheCreationTokens: 10,
  totalCostUsd: 1.23,
  totalCostUsdLocal: 1.23,
  turnCount: 3,
  toolCallCount: 2,
  avgRating: 0.75,
  cacheHitRatio: 0.82,
  outputInputRatio: 2,
  costSource: 'list',
};

const EMPTY_OTEL: SessionOtelStats = {
  hasData: false,
  accepts: 0,
  rejects: 0,
  acceptRate: null,
  linesAdded: 0,
  linesRemoved: 0,
  activeSeconds: 0,
  commits: 0,
};

const FULL_OTEL: SessionOtelStats = {
  hasData: true,
  accepts: 80,
  rejects: 20,
  acceptRate: 0.8,
  linesAdded: 1500,
  linesRemoved: 300,
  activeSeconds: 120,
  commits: 2,
};

const makeTurn = (partial: Partial<TurnDetail> = {}): TurnDetail => ({
  id: partial.id ?? 'turn-1',
  sequence: partial.sequence ?? 1,
  timestamp: partial.timestamp ?? Date.UTC(2026, 0, 2, 12, 30, 0),
  model: partial.model ?? 'claude-opus-4-7',
  inputTokens: partial.inputTokens ?? 10,
  outputTokens: partial.outputTokens ?? 20,
  cacheReadTokens: partial.cacheReadTokens ?? 0,
  cacheCreationTokens: partial.cacheCreationTokens ?? 0,
  costUsd: partial.costUsd ?? 0.01,
  stopReason: partial.stopReason ?? null,
  userPrompt: partial.userPrompt ?? null,
  assistantText: partial.assistantText ?? null,
  toolCalls: partial.toolCalls ?? [],
  rating: partial.rating ?? null,
});

const makeInput = (
  overrides: Partial<SessionShareInput> = {},
): SessionShareInput => ({
  session: overrides.session ?? BASE_SESSION,
  turns: overrides.turns ?? [],
  otel: overrides.otel ?? EMPTY_OTEL,
  breakdown: overrides.breakdown ?? [],
  globalRate: overrides.globalRate ?? null,
});

// ----- Pure helper tests -----

describe('computeFenceWidth', () => {
  it('returns 3 for content without backticks', () => {
    expect(computeFenceWidth('hello world')).toBe(3);
  });
  it('returns 4 when content contains triple backticks', () => {
    expect(computeFenceWidth('```code```')).toBe(4);
  });
  it('returns 5 when content contains 4 consecutive backticks', () => {
    expect(computeFenceWidth('````x````')).toBe(5);
  });
  it('returns 3 when content has only single backticks', () => {
    expect(computeFenceWidth('`a` and `b`')).toBe(3);
  });
});

describe('truncate', () => {
  it('returns as-is when under limit', () => {
    expect(truncate('abc', 5)).toBe('abc');
  });
  it('truncates with ellipsis when over limit', () => {
    expect(truncate('abcdef', 3)).toBe('abc…');
  });
  it('returns as-is when exactly at limit', () => {
    expect(truncate('abcde', 5)).toBe('abcde');
  });
});

describe('formatYyyymmdd', () => {
  it('formats a date in local timezone as YYYYMMDD with zero-padding', () => {
    // Use local-time construction so the asserted values match regardless of TZ.
    const d = new Date(2026, 3, 9); // April 9, 2026 local
    expect(formatYyyymmdd(d)).toBe('20260409');
  });
});

// ----- TC-U-01..30 -----

describe('renderSessionMarkdown', () => {
  it('TC-U-01: full session renders H1, metadata, ## KPIs, ## OTEL, ## Sub-agentes, ## Transcript in order', () => {
    const md = renderSessionMarkdown(
      makeInput({
        otel: FULL_OTEL,
        breakdown: [
          { subagentType: 'reviewer', turns: 2, costUsd: 0.5, pct: 0.5, outputTokens: 100 },
          { subagentType: null, turns: 1, costUsd: 0.3, pct: 0.3, outputTokens: 100 },
        ],
        turns: [
          makeTurn({ id: 't1', sequence: 1, userPrompt: 'oi' }),
          makeTurn({ id: 't2', sequence: 2, assistantText: 'ok' }),
          makeTurn({ id: 't3', sequence: 3, userPrompt: 'a', assistantText: 'b' }),
        ],
      }),
      { redact: false },
    );
    const iH1 = md.indexOf('# Sessão: tokenfx');
    const iMeta = md.indexOf('**ID**:');
    const iKpis = md.indexOf('## KPIs');
    const iOtel = md.indexOf('## OTEL');
    const iSub = md.indexOf('## Sub-agentes');
    const iTx = md.indexOf('## Transcript');
    expect(iH1).toBe(0);
    expect(iMeta).toBeGreaterThan(iH1);
    expect(iKpis).toBeGreaterThan(iMeta);
    expect(iOtel).toBeGreaterThan(iKpis);
    expect(iSub).toBeGreaterThan(iOtel);
    expect(iTx).toBeGreaterThan(iSub);
  });

  it('TC-U-02: session without OTEL omits ## OTEL section', () => {
    const md = renderSessionMarkdown(
      makeInput({ otel: EMPTY_OTEL }),
      { redact: false },
    );
    expect(md).not.toContain('## OTEL');
  });

  it('TC-U-03: session without sub-agents omits ## Sub-agentes section', () => {
    const md = renderSessionMarkdown(
      makeInput({ breakdown: [] }),
      { redact: false },
    );
    expect(md).not.toContain('## Sub-agentes');
  });

  it('TC-U-04: session without branch renders **Branch**: —', () => {
    const md = renderSessionMarkdown(
      makeInput({
        session: { ...BASE_SESSION, gitBranch: null },
      }),
      { redact: false },
    );
    expect(md).toContain('**Branch**: —');
  });

  it("TC-U-05: costSource='otel' emits [otel] tag", () => {
    const md = renderSessionMarkdown(
      makeInput({
        session: { ...BASE_SESSION, costSource: 'otel' },
      }),
      { redact: false },
    );
    expect(md).toMatch(/\*\*Custo\*\*: \$1\.23 \[otel\]/);
  });

  it("TC-U-06: costSource='calibrated' with globalRate 0.2 emits [calibrado, ratio 0.20]", () => {
    const md = renderSessionMarkdown(
      makeInput({
        session: { ...BASE_SESSION, costSource: 'calibrated' },
        globalRate: 0.2,
      }),
      { redact: false },
    );
    expect(md).toContain('[calibrado, ratio 0.20]');
  });

  it("TC-U-07: costSource='calibrated' with globalRate null emits [calibrado] (no ratio)", () => {
    const md = renderSessionMarkdown(
      makeInput({
        session: { ...BASE_SESSION, costSource: 'calibrated' },
        globalRate: null,
      }),
      { redact: false },
    );
    // must contain the bare tag but NOT ", ratio"
    expect(md).toContain('[calibrado]');
    expect(md).not.toContain('[calibrado, ratio');
  });

  it("TC-U-08: costSource='list' emits [list] tag", () => {
    const md = renderSessionMarkdown(
      makeInput({
        session: { ...BASE_SESSION, costSource: 'list' },
      }),
      { redact: false },
    );
    expect(md).toContain('[list]');
  });

  it('TC-U-09: sub-agents table ordered by cost desc — first data row is the 5$ bucket', () => {
    const md = renderSessionMarkdown(
      makeInput({
        breakdown: [
          { subagentType: 'mid', turns: 1, costUsd: 3, pct: 0.3, outputTokens: 100 },
          { subagentType: 'high', turns: 1, costUsd: 5, pct: 0.5, outputTokens: 100 },
          { subagentType: 'low', turns: 1, costUsd: 2, pct: 0.2, outputTokens: 100 },
        ],
      }),
      { redact: false },
    );
    const tableIdx = md.indexOf('## Sub-agentes');
    const body = md.slice(tableIdx);
    // Data rows are after the header + separator row.
    const dataLines = body
      .split('\n')
      .filter((l) => l.startsWith('| ') && !l.includes('Tipo') && !l.includes('---'));
    expect(dataLines[0]).toContain('high');
    expect(dataLines[1]).toContain('mid');
    expect(dataLines[2]).toContain('low');
  });

  it('TC-U-10: sub-agent with subagentType=null renders literal Main', () => {
    const md = renderSessionMarkdown(
      makeInput({
        breakdown: [
          { subagentType: null, turns: 1, costUsd: 0.5, pct: 0.5, outputTokens: 100 },
        ],
      }),
      { redact: false },
    );
    expect(md).toContain('| Main |');
  });

  it('TC-U-11: sub-agent cost is $12.34 and pct is 45.2%', () => {
    const md = renderSessionMarkdown(
      makeInput({
        breakdown: [
          { subagentType: 'x', turns: 1, costUsd: 12.34, pct: 0.452, outputTokens: 100 },
        ],
      }),
      { redact: false },
    );
    expect(md).toContain('$12.34');
    expect(md).toContain('45.2%');
  });

  it('TC-U-12: turn with userPrompt "oi" renders **Usuário:** label followed by 3-backtick fence with oi', () => {
    const md = renderSessionMarkdown(
      makeInput({
        turns: [makeTurn({ userPrompt: 'oi' })],
      }),
      { redact: false },
    );
    expect(md).toContain('**Usuário:**');
    expect(md).toContain('```text\noi\n```');
  });

  it('TC-U-13: turn with assistantText "# Header" renders text as-is, preserving the markdown', () => {
    const md = renderSessionMarkdown(
      makeInput({
        turns: [makeTurn({ assistantText: '# Header' })],
      }),
      { redact: false },
    );
    expect(md).toContain('**Assistente:**');
    expect(md).toContain('# Header');
    // no fence wrapping assistant text
    expect(md).not.toContain('```text\n# Header\n```');
  });

  it('TC-U-14: turn with both user and assistant — user block appears before assistant', () => {
    const md = renderSessionMarkdown(
      makeInput({
        turns: [
          makeTurn({ userPrompt: 'hello', assistantText: 'world' }),
        ],
      }),
      { redact: false },
    );
    const iUser = md.indexOf('**Usuário:**');
    const iAssistant = md.indexOf('**Assistente:**');
    expect(iUser).toBeGreaterThan(-1);
    expect(iAssistant).toBeGreaterThan(iUser);
  });

  it('TC-U-15: turn with successful toolCall renders ✓ bullet with bold toolName and input inline code', () => {
    const md = renderSessionMarkdown(
      makeInput({
        turns: [
          makeTurn({
            toolCalls: [
              {
                id: 'tc-1',
                toolName: 'Bash',
                inputJson: '{"cmd":"ls"}',
                resultJson: '{"ok":true}',
                resultIsError: false,
              },
            ],
          }),
        ],
      }),
      { redact: false },
    );
    expect(md).toContain('**Ferramentas:**');
    expect(md).toContain('- ✓ **Bash**');
    expect(md).toMatch(/input: `\{"cmd":"ls"\}`/);
  });

  it('TC-U-16: toolCall with resultIsError=true renders ✗ bullet', () => {
    const md = renderSessionMarkdown(
      makeInput({
        turns: [
          makeTurn({
            toolCalls: [
              {
                id: 'tc-1',
                toolName: 'Bash',
                inputJson: '{}',
                resultJson: 'err',
                resultIsError: true,
              },
            ],
          }),
        ],
      }),
      { redact: false },
    );
    expect(md).toContain('- ✗ **Bash**');
  });

  it('TC-U-17: toolCall with resultJson=null omits "— result:" segment', () => {
    const md = renderSessionMarkdown(
      makeInput({
        turns: [
          makeTurn({
            toolCalls: [
              {
                id: 'tc-1',
                toolName: 'Grep',
                inputJson: '{"q":"x"}',
                resultJson: null,
                resultIsError: false,
              },
            ],
          }),
        ],
      }),
      { redact: false },
    );
    expect(md).toContain('**Grep**');
    expect(md).not.toContain('— result:');
  });

  it('TC-U-18: toolCall with inputJson over 200 chars truncates with …', () => {
    const longInput = 'a'.repeat(250);
    const md = renderSessionMarkdown(
      makeInput({
        turns: [
          makeTurn({
            toolCalls: [
              {
                id: 'tc-1',
                toolName: 'Read',
                inputJson: longInput,
                resultJson: null,
                resultIsError: false,
              },
            ],
          }),
        ],
      }),
      { redact: false },
    );
    const expected = 'a'.repeat(200) + '…';
    expect(md).toContain(expected);
    // no 201+ consecutive a's
    expect(md).not.toContain('a'.repeat(201));
  });

  it('TC-U-19: rating +1 renders "**Avaliação:** 👍 Bom"', () => {
    const md = renderSessionMarkdown(
      makeInput({
        turns: [
          makeTurn({ rating: { value: 1, note: null, ratedAt: 0 } }),
        ],
      }),
      { redact: false },
    );
    expect(md).toContain('**Avaliação:** 👍 Bom');
  });

  it('TC-U-20: rating 0 renders "**Avaliação:** 😐 Neutro"', () => {
    const md = renderSessionMarkdown(
      makeInput({
        turns: [
          makeTurn({ rating: { value: 0, note: null, ratedAt: 0 } }),
        ],
      }),
      { redact: false },
    );
    expect(md).toContain('**Avaliação:** 😐 Neutro');
  });

  it('TC-U-21: rating -1 renders "**Avaliação:** 👎 Ruim"', () => {
    const md = renderSessionMarkdown(
      makeInput({
        turns: [
          makeTurn({ rating: { value: -1, note: null, ratedAt: 0 } }),
        ],
      }),
      { redact: false },
    );
    expect(md).toContain('**Avaliação:** 👎 Ruim');
  });

  it('TC-U-22: rating with note "great" appends — great', () => {
    const md = renderSessionMarkdown(
      makeInput({
        turns: [
          makeTurn({ rating: { value: 1, note: 'great', ratedAt: 0 } }),
        ],
      }),
      { redact: false },
    );
    expect(md).toContain('**Avaliação:** 👍 Bom — great');
  });

  it('TC-U-23: rating=null omits the Avaliação line', () => {
    const md = renderSessionMarkdown(
      makeInput({
        turns: [
          makeTurn({ userPrompt: 'x', rating: null }),
        ],
      }),
      { redact: false },
    );
    expect(md).not.toContain('**Avaliação:**');
  });

  it('TC-U-24: userPrompt with triple backticks forces 4-backtick fence', () => {
    const md = renderSessionMarkdown(
      makeInput({
        turns: [makeTurn({ userPrompt: '```embedded```' })],
      }),
      { redact: false },
    );
    expect(md).toContain('````text\n```embedded```\n````');
  });

  it('TC-U-25: userPrompt with 4 consecutive backticks forces 5-backtick fence', () => {
    const md = renderSessionMarkdown(
      makeInput({
        turns: [makeTurn({ userPrompt: '````x````' })],
      }),
      { redact: false },
    );
    expect(md).toContain('`````text\n````x````\n`````');
  });

  it('TC-U-26: userPrompt without backticks uses 3-backtick fence', () => {
    const md = renderSessionMarkdown(
      makeInput({
        turns: [makeTurn({ userPrompt: 'plain' })],
      }),
      { redact: false },
    );
    expect(md).toContain('```text\nplain\n```');
    expect(md).not.toContain('````text');
  });

  it('TC-U-27: redact=true replaces user/assistant/tool/rating-note with [REDIGIDO]', () => {
    const md = renderSessionMarkdown(
      makeInput({
        turns: [
          makeTurn({
            userPrompt: 'secret prompt',
            assistantText: 'secret answer',
            toolCalls: [
              {
                id: 'tc-1',
                toolName: 'Bash',
                inputJson: '{"secret":"xyz"}',
                resultJson: '{"secretOutput":true}',
                resultIsError: false,
              },
            ],
            rating: { value: 1, note: 'secret note', ratedAt: 0 },
          }),
        ],
      }),
      { redact: true },
    );
    expect(md).not.toContain('secret prompt');
    expect(md).not.toContain('secret answer');
    expect(md).not.toContain('xyz');
    expect(md).not.toContain('secretOutput');
    expect(md).not.toContain('secret note');
    // Each category should appear at least once.
    expect(md.match(/\[REDIGIDO\]/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });

  it('TC-U-28: redact=true preserves toolName, model, timestamp, rating.value structure', () => {
    const md = renderSessionMarkdown(
      makeInput({
        turns: [
          makeTurn({
            model: 'claude-opus-4-7',
            userPrompt: 'secret',
            toolCalls: [
              {
                id: 'tc-1',
                toolName: 'Bash',
                inputJson: 'xx',
                resultJson: 'yy',
                resultIsError: false,
              },
            ],
            rating: { value: 1, note: 'secret note', ratedAt: 0 },
          }),
        ],
      }),
      { redact: true },
    );
    expect(md).toContain('claude-opus-4-7');
    expect(md).toContain('**Bash**');
    expect(md).toContain('👍 Bom');
  });

  it('TC-U-29: empty turn renders `_(sem conteúdo)_` under H3', () => {
    const md = renderSessionMarkdown(
      makeInput({
        turns: [
          makeTurn({
            userPrompt: null,
            assistantText: null,
            toolCalls: [],
            rating: null,
          }),
        ],
      }),
      { redact: false },
    );
    expect(md).toContain('_(sem conteúdo)_');
  });

  it('TC-U-30: session with 0 turns renders `_Sem turnos nesta sessão._`', () => {
    const md = renderSessionMarkdown(
      makeInput({ turns: [] }),
      { redact: false },
    );
    expect(md).toContain('## Transcript');
    expect(md).toContain('_Sem turnos nesta sessão._');
  });
});
