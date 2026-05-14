import { describe, it, expect } from 'vitest';
import { parseTranscriptString, detectCorrectionPenalty } from './parser';
import type { ParsedTurn } from './types';

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

const SESSION_ID = 'sess-1';
const CWD = '/home/user/project-x';

function userLine(uuid: string, parentUuid: string | null, text: string, ts: string) {
  return line({
    type: 'user',
    uuid,
    parentUuid,
    sessionId: SESSION_ID,
    timestamp: ts,
    cwd: CWD,
    version: '1.2.3',
    gitBranch: 'main',
    message: { role: 'user', content: text },
  });
}

function userToolResultLine(
  uuid: string,
  parentUuid: string | null,
  toolUseId: string,
  content: unknown,
  ts: string,
  isError = false,
) {
  return line({
    type: 'user',
    uuid,
    parentUuid,
    sessionId: SESSION_ID,
    timestamp: ts,
    cwd: CWD,
    version: '1.2.3',
    gitBranch: 'main',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content,
          is_error: isError,
        },
      ],
    },
  });
}

function assistantLine(
  uuid: string,
  parentUuid: string | null,
  opts: {
    text?: string;
    ts: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheRead?: number;
    cacheCreate?: number;
    model?: string;
    stopReason?: string;
    toolUses?: Array<{ id: string; name: string; input: unknown }>;
  },
) {
  const content: Array<Record<string, unknown>> = [];
  if (opts.text) content.push({ type: 'text', text: opts.text });
  if (opts.toolUses) {
    for (const tu of opts.toolUses) {
      content.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
    }
  }
  return line({
    type: 'assistant',
    uuid,
    parentUuid,
    sessionId: SESSION_ID,
    timestamp: opts.ts,
    cwd: CWD,
    version: '1.2.3',
    gitBranch: 'main',
    message: {
      id: `msg-${uuid}`,
      role: 'assistant',
      model: opts.model ?? 'claude-opus-4',
      stop_reason: opts.stopReason ?? 'end_turn',
      content,
      usage: {
        input_tokens: opts.inputTokens ?? 0,
        output_tokens: opts.outputTokens ?? 0,
        cache_creation_input_tokens: opts.cacheCreate ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
      },
    },
  });
}

describe('parseTranscriptString', () => {
  it('TC-U-01: happy path — parses tokens, cwd, project, single turn', () => {
    const content = [
      userLine('u1', null, 'hello', '2026-04-18T10:00:00.000Z'),
      assistantLine('a1', 'u1', {
        text: 'hi there',
        ts: '2026-04-18T10:00:05.000Z',
        inputTokens: 100,
        outputTokens: 20,
        cacheRead: 50,
        cacheCreate: 0,
      }),
      userLine('u2', 'a1', 'follow up', '2026-04-18T10:00:10.000Z'),
    ].join('\n');

    const res = parseTranscriptString(content);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const session = res.value;
    expect(session.id).toBe(SESSION_ID);
    expect(session.cwd).toBe(CWD);
    expect(session.project).toBe('project-x');
    expect(session.turns).toHaveLength(1);
    const turn = session.turns[0];
    expect(turn.inputTokens).toBe(100);
    expect(turn.outputTokens).toBe(20);
    expect(turn.cacheReadTokens).toBe(50);
    expect(turn.cacheCreationTokens).toBe(0);
    expect(turn.userPrompt).toBe('hello');
    expect(turn.assistantText).toBe('hi there');
    expect(turn.model).toBe('claude-opus-4');
    expect(session.startedAt).toBe(Date.parse('2026-04-18T10:00:00.000Z'));
    expect(session.endedAt).toBe(Date.parse('2026-04-18T10:00:10.000Z'));
  });

  it('TC-U-02: edge — skips malformed lines, still returns ok with valid turns', () => {
    const warnings: string[] = [];
    const valid = [
      userLine('u1', null, 'hello', '2026-04-18T10:00:00.000Z'),
      assistantLine('a1', 'u1', {
        text: 'hi',
        ts: '2026-04-18T10:00:05.000Z',
        inputTokens: 10,
        outputTokens: 5,
      }),
      userLine('u2', 'a1', 'bye', '2026-04-18T10:00:10.000Z'),
    ];
    const malformed = ['{not valid json', 'totally random text not json'];
    const content = [valid[0], malformed[0], valid[1], malformed[1], valid[2]].join('\n');

    const res = parseTranscriptString(content, undefined, (m) => warnings.push(m));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.turns).toHaveLength(1);
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('tool_use/tool_result linkage', () => {
    const content = [
      userLine('u1', null, 'do it', '2026-04-18T10:00:00.000Z'),
      assistantLine('a1', 'u1', {
        text: 'running tool',
        ts: '2026-04-18T10:00:05.000Z',
        inputTokens: 5,
        outputTokens: 3,
        toolUses: [{ id: 'tu_1', name: 'calc', input: { x: 1 } }],
      }),
      userToolResultLine('u2', 'a1', 'tu_1', '42', '2026-04-18T10:00:06.000Z'),
    ].join('\n');

    const res = parseTranscriptString(content);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const turn = res.value.turns[0];
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0].id).toBe('tu_1');
    expect(turn.toolCalls[0].toolName).toBe('calc');
    expect(turn.toolCalls[0].inputJson).toBe(JSON.stringify({ x: 1 }));
    expect(turn.toolCalls[0].resultJson).toBe(JSON.stringify('42'));
    expect(turn.toolCalls[0].resultIsError).toBe(false);
  });

  it('TC-U-24: REQ-15 happy — extracts text from block.type === "text" (no cast)', () => {
    const content = [
      userLine('u1', null, 'ping', '2026-04-18T10:00:00.000Z'),
      assistantLine('a1', 'u1', {
        text: 'hello from text block',
        ts: '2026-04-18T10:00:05.000Z',
        inputTokens: 1,
        outputTokens: 1,
      }),
    ].join('\n');
    const res = parseTranscriptString(content);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.turns).toHaveLength(1);
    expect(res.value.turns[0].assistantText).toBe('hello from text block');
  });

  it('TC-U-25: REQ-15 happy — extracts id/name/input from block.type === "tool_use" (no cast)', () => {
    const content = [
      userLine('u1', null, 'run it', '2026-04-18T10:00:00.000Z'),
      assistantLine('a1', 'u1', {
        text: 'sure',
        ts: '2026-04-18T10:00:05.000Z',
        inputTokens: 1,
        outputTokens: 1,
        toolUses: [{ id: 'tu_42', name: 'bash', input: { cmd: 'ls' } }],
      }),
    ].join('\n');
    const res = parseTranscriptString(content);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const turn = res.value.turns[0];
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0].id).toBe('tu_42');
    expect(turn.toolCalls[0].toolName).toBe('bash');
    expect(turn.toolCalls[0].inputJson).toBe(JSON.stringify({ cmd: 'ls' }));
  });

  it('TC-U-26: REQ-15 happy — preserves usage.service_tier string (no cast)', () => {
    const content = [
      userLine('u1', null, 'go', '2026-04-18T10:00:00.000Z'),
      line({
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: SESSION_ID,
        timestamp: '2026-04-18T10:00:05.000Z',
        cwd: CWD,
        version: '1.2.3',
        gitBranch: 'main',
        message: {
          id: 'msg-a1',
          role: 'assistant',
          model: 'claude-opus-4',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'ok' }],
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            service_tier: 'priority',
          },
        },
      }),
    ].join('\n');
    const res = parseTranscriptString(content);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.turns).toHaveLength(1);
    expect(res.value.turns[0].serviceTier).toBe('priority');
  });

  it('returns error for inconsistent sessionId', () => {
    const a = userLine('u1', null, 'hi', '2026-04-18T10:00:00.000Z');
    const bad = line({
      type: 'user',
      uuid: 'u2',
      parentUuid: null,
      sessionId: 'OTHER',
      timestamp: '2026-04-18T10:00:05.000Z',
      cwd: CWD,
      version: '1',
      message: { role: 'user', content: 'hey' },
    });
    const res = parseTranscriptString([a, bad].join('\n'));
    expect(res.ok).toBe(false);
  });
});

function compactBoundaryLine(
  ts: string,
  metadata?: { trigger?: string; preTokens?: number; postTokens?: number },
) {
  const compactMetadata: Record<string, unknown> = {};
  if (metadata?.trigger !== undefined) compactMetadata.trigger = metadata.trigger;
  if (metadata?.preTokens !== undefined) compactMetadata.preTokens = metadata.preTokens;
  if (metadata?.postTokens !== undefined) compactMetadata.postTokens = metadata.postTokens;
  return line({
    type: 'system',
    subtype: 'compact_boundary',
    compactMetadata,
    timestamp: ts,
  });
}

describe('parseTranscriptString — compaction events', () => {
  it('TC-U-15: REQ-1 happy — JSONL with 2 compact_boundary lines + user/assistant entries', () => {
    const content = [
      userLine('u1', null, 'first ask', '2026-04-15T12:00:00.000Z'),
      assistantLine('a1', 'u1', {
        text: 'first reply',
        ts: '2026-04-15T12:00:01.000Z',
        inputTokens: 10,
        outputTokens: 5,
      }),
      compactBoundaryLine('2026-04-15T12:34:56.789Z', {
        trigger: 'auto',
        preTokens: 968559,
        postTokens: 16672,
      }),
      userLine('u2', 'a1', 'second ask', '2026-04-15T12:35:00.000Z'),
      assistantLine('a2', 'u2', {
        text: 'second reply',
        ts: '2026-04-15T12:35:01.000Z',
        inputTokens: 8,
        outputTokens: 4,
      }),
      compactBoundaryLine('2026-04-15T13:00:00.000Z', {
        trigger: 'manual',
        preTokens: 500000,
        postTokens: 12000,
      }),
      userLine('u3', 'a2', 'third ask', '2026-04-15T13:00:30.000Z'),
      assistantLine('a3', 'u3', {
        text: 'third reply',
        ts: '2026-04-15T13:00:31.000Z',
        inputTokens: 6,
        outputTokens: 3,
      }),
    ].join('\n');

    const res = parseTranscriptString(content);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.compactionEvents).toHaveLength(2);
    expect(res.value.compactionEvents[0]).toEqual({
      sequence_in_file: 0,
      trigger: 'auto',
      pre_tokens: 968559,
      post_tokens: 16672,
      ts: Date.parse('2026-04-15T12:34:56.789Z'),
    });
    expect(res.value.compactionEvents[1]).toEqual({
      sequence_in_file: 1,
      trigger: 'manual',
      pre_tokens: 500000,
      post_tokens: 12000,
      ts: Date.parse('2026-04-15T13:00:00.000Z'),
    });
    // user/assistant turns still parsed normally
    expect(res.value.turns).toHaveLength(3);
  });

  it('TC-U-16: REQ-1 edge — JSONL with NO compact_boundary returns empty array', () => {
    const content = [
      userLine('u1', null, 'hello', '2026-04-18T10:00:00.000Z'),
      assistantLine('a1', 'u1', {
        text: 'hi',
        ts: '2026-04-18T10:00:05.000Z',
        inputTokens: 10,
        outputTokens: 5,
      }),
    ].join('\n');
    const res = parseTranscriptString(content);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.compactionEvents).toEqual([]);
  });

  it('TC-U-17: REQ-2 validation — type:"system" without subtype is not counted', () => {
    const content = [
      userLine('u1', null, 'hi', '2026-04-18T10:00:00.000Z'),
      line({ type: 'system', timestamp: '2026-04-18T10:00:01.000Z' }),
      assistantLine('a1', 'u1', {
        text: 'hi',
        ts: '2026-04-18T10:00:05.000Z',
        inputTokens: 1,
        outputTokens: 1,
      }),
    ].join('\n');
    const res = parseTranscriptString(content);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.compactionEvents).toHaveLength(0);
  });

  it('TC-U-18: REQ-2 validation — type:"system" subtype:"info" is not counted', () => {
    const content = [
      userLine('u1', null, 'hi', '2026-04-18T10:00:00.000Z'),
      line({
        type: 'system',
        subtype: 'info',
        timestamp: '2026-04-18T10:00:01.000Z',
      }),
      assistantLine('a1', 'u1', {
        text: 'hi',
        ts: '2026-04-18T10:00:05.000Z',
        inputTokens: 1,
        outputTokens: 1,
      }),
    ].join('\n');
    const res = parseTranscriptString(content);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.compactionEvents).toHaveLength(0);
  });

  it('TC-U-19: REQ-2 validation — type:"system" subtype:42 (number) is not counted', () => {
    const content = [
      userLine('u1', null, 'hi', '2026-04-18T10:00:00.000Z'),
      line({
        type: 'system',
        subtype: 42,
        timestamp: '2026-04-18T10:00:01.000Z',
      }),
      assistantLine('a1', 'u1', {
        text: 'hi',
        ts: '2026-04-18T10:00:05.000Z',
        inputTokens: 1,
        outputTokens: 1,
      }),
    ].join('\n');
    const res = parseTranscriptString(content);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.compactionEvents).toHaveLength(0);
  });

  it('TC-U-20: REQ-1 edge — malformed JSONL line where compact_boundary should be → warn + counter not incremented', () => {
    const warnings: string[] = [];
    const content = [
      userLine('u1', null, 'hi', '2026-04-18T10:00:00.000Z'),
      compactBoundaryLine('2026-04-18T10:00:01.000Z', {
        trigger: 'auto',
        preTokens: 100,
        postTokens: 10,
      }),
      '{not valid json for compact_boundary',
      compactBoundaryLine('2026-04-18T10:00:03.000Z', {
        trigger: 'auto',
        preTokens: 200,
        postTokens: 20,
      }),
      assistantLine('a1', 'u1', {
        text: 'hi',
        ts: '2026-04-18T10:00:05.000Z',
        inputTokens: 1,
        outputTokens: 1,
      }),
    ].join('\n');
    const res = parseTranscriptString(content, undefined, (m) => warnings.push(m));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Two valid boundary entries; the malformed line in between is skipped
    // and does NOT increment the counter — sequences are 0 and 1, not 0 and 2.
    expect(res.value.compactionEvents).toHaveLength(2);
    expect(res.value.compactionEvents[0].sequence_in_file).toBe(0);
    expect(res.value.compactionEvents[1].sequence_in_file).toBe(1);
    // A warn was emitted for the malformed line
    expect(warnings.some((w) => w.toLowerCase().includes('invalid json'))).toBe(true);
  });
});

describe('detectCorrectionPenalty (TC-U-05)', () => {
  function buildTurns(userPrompts: Array<string | null>): ParsedTurn[] {
    return userPrompts.map((p, i) => ({
      id: `a${i + 1}`,
      parentUuid: i === 0 ? null : `a${i}`,
      sequence: i,
      timestamp: 1000 + i,
      model: 'm',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      serviceTier: 'standard',
      stopReason: null,
      userPrompt: p,
      assistantText: null,
      toolCalls: [],
    }));
  }

  it('strong correction in PT marks previous turn 1.0', () => {
    const turns = buildTurns(['do X', 'não, isso tá errado']);
    const map = detectCorrectionPenalty(turns);
    expect(map.get('a1')).toBe(1.0);
    expect(map.has('a2')).toBe(false);
  });

  it('mild correction "actually" marks previous turn 0.5', () => {
    const turns = buildTurns(['do X', 'actually, can we adjust?']);
    const map = detectCorrectionPenalty(turns);
    expect(map.get('a1')).toBe(0.5);
  });

  it('no correction produces empty map', () => {
    const turns = buildTurns(['do X', 'thanks, now do Y']);
    const map = detectCorrectionPenalty(turns);
    expect(map.size).toBe(0);
  });
});
