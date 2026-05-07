import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';
import type { DB } from '@/lib/db/client';
import {
  writeSession,
  writeOtelScrapes,
  ingestAll,
  ingestSingleFile,
} from './writer';
import type {
  CompactionEvent,
  ParsedSession,
} from './transcript/types';
import type { OtelScrape } from './otel/parser';

// ---- subagent-inflation fixture helpers (TASK-2 of fix-ingest-skip-subagent-jsonls) ----
//
// Used by the subagent-inflation regression TCs at the bottom of the
// `ingestAll` describe block. Build a minimal but valid two-turn JSONL
// transcript whose MIN(timestamp) is `startedAt` and MAX(timestamp) is
// `endedAt` — the writer's reconcileSession rollup recomputes the session
// window from MIN/MAX(turns.timestamp), and only assistant events become
// `turns` rows (user events fold into turns.user_prompt). So two assistant
// turns at the boundary timestamps are needed to pin started_at/ended_at
// to exact epoch-ms values. See .specs/fix-ingest-skip-subagent-jsonls.md.

type SubagentInflationJsonlEntry = {
  type: 'user' | 'assistant';
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: number;
  cwd: string;
  assistantText?: string;
};

const buildUserEvent = (e: SubagentInflationJsonlEntry): string =>
  JSON.stringify({
    type: 'user',
    parentUuid: e.parentUuid,
    uuid: e.uuid,
    sessionId: e.sessionId,
    timestamp: new Date(e.timestamp).toISOString(),
    cwd: e.cwd,
    version: '2.0.0',
    gitBranch: 'main',
    message: { role: 'user', content: 'hello' },
  });

const buildAssistantEvent = (e: SubagentInflationJsonlEntry): string =>
  JSON.stringify({
    type: 'assistant',
    parentUuid: e.parentUuid,
    uuid: e.uuid,
    sessionId: e.sessionId,
    timestamp: new Date(e.timestamp).toISOString(),
    cwd: e.cwd,
    version: '2.0.0',
    message: {
      id: `msg_${e.uuid}`,
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: e.assistantText ?? 'ok' }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        service_tier: 'standard',
      },
      stop_reason: 'end_turn',
    },
  });

const buildSubagentInflationJsonl = (params: {
  sessionId: string;
  cwd: string;
  startedAt: number;
  endedAt: number;
  uuidPrefix: string;
}): string => {
  const { sessionId, cwd, startedAt, endedAt, uuidPrefix } = params;
  const u1 = `${uuidPrefix}-u1`;
  const a1 = `${uuidPrefix}-a1`;
  const u2 = `${uuidPrefix}-u2`;
  const a2 = `${uuidPrefix}-a2`;
  const lines = [
    buildUserEvent({
      type: 'user',
      uuid: u1,
      parentUuid: null,
      sessionId,
      timestamp: startedAt,
      cwd,
    }),
    buildAssistantEvent({
      type: 'assistant',
      uuid: a1,
      parentUuid: u1,
      sessionId,
      timestamp: startedAt,
      cwd,
      assistantText: 'first response',
    }),
    buildUserEvent({
      type: 'user',
      uuid: u2,
      parentUuid: a1,
      sessionId,
      timestamp: endedAt,
      cwd,
    }),
    buildAssistantEvent({
      type: 'assistant',
      uuid: a2,
      parentUuid: u2,
      sessionId,
      timestamp: endedAt,
      cwd,
      assistantText: 'second response',
    }),
  ];
  return lines.join('\n') + '\n';
};

function makeSession(overrides?: Partial<ParsedSession>): ParsedSession {
  return {
    id: 'sess-test-001',
    cwd: '/Users/dev/proj',
    project: 'proj',
    gitBranch: 'main',
    ccVersion: '2.0.0',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_100_000,
    compactionEvents: [],
    turns: [
      {
        id: 'a1',
        parentUuid: 'u1',
        sequence: 0,
        timestamp: 1_700_000_010_000,
        model: 'claude-sonnet-4-5',
        inputTokens: 120,
        outputTokens: 25,
        cacheReadTokens: 50,
        cacheCreationTokens: 0,
        cacheCreation5mTokens: 0,
        cacheCreation1hTokens: 0,
        serviceTier: 'standard',
        stopReason: 'tool_use',
        userPrompt: 'list files',
        assistantText: "I'll list the files.",
        toolCalls: [
          {
            id: 'toolu_01',
            toolName: 'Bash',
            inputJson: JSON.stringify({ command: 'ls' }),
            resultJson: JSON.stringify({ text: 'README.md\npackage.json\nsrc' }),
            resultIsError: false,
          },
        ],
      },
      {
        id: 'a2',
        parentUuid: 'u2',
        sequence: 1,
        timestamp: 1_700_000_050_000,
        model: 'claude-sonnet-4-5',
        inputTokens: 80,
        outputTokens: 30,
        cacheReadTokens: 150,
        cacheCreationTokens: 0,
        cacheCreation5mTokens: 0,
        cacheCreation1hTokens: 0,
        serviceTier: 'standard',
        stopReason: 'end_turn',
        userPrompt: null,
        assistantText: 'Found three entries.',
        toolCalls: [],
      },
      {
        id: 'a3',
        parentUuid: 'u3',
        sequence: 2,
        timestamp: 1_700_000_060_000,
        model: 'claude-sonnet-4-5',
        inputTokens: 60,
        outputTokens: 8,
        cacheReadTokens: 220,
        cacheCreationTokens: 0,
        cacheCreation5mTokens: 0,
        cacheCreation1hTokens: 0,
        serviceTier: 'standard',
        stopReason: 'end_turn',
        userPrompt: 'thanks',
        assistantText: "You're welcome!",
        toolCalls: [],
      },
    ],
    ...overrides,
  };
}

describe('writer', () => {
  let db: DB;

  beforeEach(() => {
    db = openDatabase(':memory:');
    migrate(db);
  });

  afterEach(() => {
    db.close();
  });

  it('TC-I-WRITER-01: writes a session with turns and tool calls', () => {
    const parsed = makeSession();
    writeSession(db, parsed, '/tmp/source.jsonl');

    const sessions = db.prepare('SELECT * FROM sessions').all() as Array<{
      id: string;
      total_cost_usd: number;
      turn_count: number;
      tool_call_count: number;
      total_input_tokens: number;
      source_file: string;
    }>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('sess-test-001');
    expect(sessions[0].turn_count).toBe(3);
    expect(sessions[0].tool_call_count).toBe(1);
    expect(sessions[0].total_input_tokens).toBe(260);
    expect(sessions[0].total_cost_usd).toBeGreaterThan(0);
    expect(sessions[0].source_file).toBe('/tmp/source.jsonl');

    const turns = db.prepare('SELECT * FROM turns').all();
    expect(turns).toHaveLength(3);

    const toolCalls = db.prepare('SELECT * FROM tool_calls').all() as Array<{
      id: string;
      tool_name: string;
    }>;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].tool_name).toBe('Bash');
  });

  it('TC-I-WRITER-02: idempotent on repeat writes', () => {
    const parsed = makeSession();
    writeSession(db, parsed, '/tmp/source.jsonl');
    writeSession(db, parsed, '/tmp/source.jsonl');

    const sessionCount = (
      db.prepare('SELECT COUNT(*) as c FROM sessions').get() as { c: number }
    ).c;
    const turnCount = (
      db.prepare('SELECT COUNT(*) as c FROM turns').get() as { c: number }
    ).c;
    const toolCount = (
      db.prepare('SELECT COUNT(*) as c FROM tool_calls').get() as { c: number }
    ).c;
    expect(sessionCount).toBe(1);
    expect(turnCount).toBe(3);
    expect(toolCount).toBe(1);
  });

  it('TC-I-WRITER-03: merge updates source_file on re-ingest', () => {
    const parsed = makeSession();
    writeSession(db, parsed, '/tmp/old.jsonl');
    writeSession(db, parsed, '/tmp/new.jsonl');

    const row = db
      .prepare('SELECT source_file FROM sessions WHERE id = ?')
      .get('sess-test-001') as { source_file: string };
    expect(row.source_file).toBe('/tmp/new.jsonl');

    const turnCount = (
      db.prepare('SELECT COUNT(*) as c FROM turns').get() as { c: number }
    ).c;
    expect(turnCount).toBe(3);
  });

  it('TC-I-WRITER-04: otel scrapes dedup on (metric, labels, scraped_at)', () => {
    const rows: OtelScrape[] = [
      {
        metricName: 'claude_tokens_total',
        labels: { type: 'input' },
        value: 100,
        scrapedAt: 1_700_000_000_000,
      },
      {
        metricName: 'claude_tokens_total',
        labels: { type: 'output' },
        value: 50,
        scrapedAt: 1_700_000_000_000,
      },
      {
        metricName: 'claude_cost_usd',
        labels: {},
        value: 0.01,
        scrapedAt: 1_700_000_000_000,
      },
    ];
    writeOtelScrapes(db, rows);
    // Re-ingesting the same scrape is a no-op — the UNIQUE constraint on
    // (metric_name, labels_json, scraped_at) + ON CONFLICT DO NOTHING keeps
    // the table from growing unboundedly when the cron runs repeatedly.
    writeOtelScrapes(db, rows);
    const count = (
      db.prepare('SELECT COUNT(*) as c FROM otel_scrapes').get() as { c: number }
    ).c;
    expect(count).toBe(3);

    // A new scrape at a later timestamp IS appended.
    const later: OtelScrape[] = rows.map((r) => ({
      ...r,
      scrapedAt: r.scrapedAt + 1,
      value: r.value + 1,
    }));
    writeOtelScrapes(db, later);
    const count2 = (
      db.prepare('SELECT COUNT(*) as c FROM otel_scrapes').get() as { c: number }
    ).c;
    expect(count2).toBe(6);
  });

  // ---- compaction_events (TASK-5) -----------------------------------------

  function compactionEvent(
    overrides: Partial<CompactionEvent> & { sequence_in_file: number },
  ): CompactionEvent {
    return {
      sequence_in_file: overrides.sequence_in_file,
      trigger: 'trigger' in overrides ? overrides.trigger ?? null : 'auto',
      pre_tokens:
        'pre_tokens' in overrides ? overrides.pre_tokens ?? null : 950_000,
      post_tokens:
        'post_tokens' in overrides ? overrides.post_tokens ?? null : 18_000,
      ts: 'ts' in overrides ? overrides.ts ?? 1_700_000_080_000 : 1_700_000_080_000,
    };
  }

  it('TC-I-03: writes compaction_events rows from parsed.compactionEvents', () => {
    const parsed = makeSession({
      compactionEvents: [
        compactionEvent({
          sequence_in_file: 0,
          trigger: 'auto',
          pre_tokens: 900_000,
          post_tokens: 16_000,
          ts: 1_700_000_020_000,
        }),
        compactionEvent({
          sequence_in_file: 1,
          trigger: 'manual',
          pre_tokens: 750_000,
          post_tokens: 18_000,
          ts: 1_700_000_050_000,
        }),
        compactionEvent({
          sequence_in_file: 2,
          trigger: null,
          pre_tokens: null,
          post_tokens: null,
          ts: 1_700_000_080_000,
        }),
      ],
    });
    writeSession(db, parsed, '/tmp/source.jsonl');

    const rows = db
      .prepare(
        `SELECT sequence_in_file, trigger, pre_tokens, post_tokens, ts, source_file
         FROM compaction_events WHERE session_id = ? ORDER BY sequence_in_file`,
      )
      .all('sess-test-001') as Array<{
      sequence_in_file: number;
      trigger: string | null;
      pre_tokens: number | null;
      post_tokens: number | null;
      ts: number;
      source_file: string;
    }>;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      sequence_in_file: 0,
      trigger: 'auto',
      pre_tokens: 900_000,
      post_tokens: 16_000,
      ts: 1_700_000_020_000,
      source_file: '/tmp/source.jsonl',
    });
    expect(rows[1].trigger).toBe('manual');
    expect(rows[1].pre_tokens).toBe(750_000);
    expect(rows[1].post_tokens).toBe(18_000);
    expect(rows[2]).toEqual({
      sequence_in_file: 2,
      trigger: null,
      pre_tokens: null,
      post_tokens: null,
      ts: 1_700_000_080_000,
      source_file: '/tmp/source.jsonl',
    });
  });

  it('TC-I-04: re-ingest of same source_file is idempotent and updates non-pk fields', () => {
    const first = makeSession({
      compactionEvents: [
        compactionEvent({
          sequence_in_file: 0,
          trigger: 'auto',
          pre_tokens: 900_000,
          post_tokens: 16_000,
        }),
        compactionEvent({
          sequence_in_file: 1,
          trigger: 'auto',
          pre_tokens: 800_000,
          post_tokens: 17_000,
        }),
      ],
    });
    writeSession(db, first, '/tmp/source.jsonl');

    // Same path, same PKs, but trigger flipped + token counts revised.
    const second = makeSession({
      compactionEvents: [
        compactionEvent({
          sequence_in_file: 0,
          trigger: 'manual',
          pre_tokens: 910_000,
          post_tokens: 16_500,
        }),
        compactionEvent({
          sequence_in_file: 1,
          trigger: 'manual',
          pre_tokens: 810_000,
          post_tokens: 17_500,
        }),
      ],
    });
    writeSession(db, second, '/tmp/source.jsonl');

    const count = (
      db
        .prepare(
          'SELECT COUNT(*) AS c FROM compaction_events WHERE session_id = ?',
        )
        .get('sess-test-001') as { c: number }
    ).c;
    expect(count).toBe(2);

    const rows = db
      .prepare(
        `SELECT sequence_in_file, trigger, pre_tokens, post_tokens
         FROM compaction_events WHERE session_id = ? ORDER BY sequence_in_file`,
      )
      .all('sess-test-001') as Array<{
      sequence_in_file: number;
      trigger: string | null;
      pre_tokens: number | null;
      post_tokens: number | null;
    }>;
    expect(rows[0].trigger).toBe('manual');
    expect(rows[0].pre_tokens).toBe(910_000);
    expect(rows[0].post_tokens).toBe(16_500);
    expect(rows[1].trigger).toBe('manual');
    expect(rows[1].pre_tokens).toBe(810_000);
    expect(rows[1].post_tokens).toBe(17_500);
  });

  it('TC-I-05: two source_files for same session keep separate rows (multi-file)', () => {
    const a = makeSession({
      compactionEvents: [
        compactionEvent({ sequence_in_file: 0, trigger: 'auto' }),
        compactionEvent({ sequence_in_file: 1, trigger: 'auto' }),
      ],
    });
    writeSession(db, a, '/tmp/file-A.jsonl');

    const b = makeSession({
      compactionEvents: [compactionEvent({ sequence_in_file: 0, trigger: 'manual' })],
    });
    writeSession(db, b, '/tmp/file-B.jsonl');

    const total = (
      db
        .prepare(
          'SELECT COUNT(*) AS c FROM compaction_events WHERE session_id = ?',
        )
        .get('sess-test-001') as { c: number }
    ).c;
    expect(total).toBe(3);

    const perFile = db
      .prepare(
        `SELECT source_file, COUNT(*) AS c
         FROM compaction_events WHERE session_id = ?
         GROUP BY source_file ORDER BY source_file`,
      )
      .all('sess-test-001') as Array<{ source_file: string; c: number }>;
    expect(perFile).toEqual([
      { source_file: '/tmp/file-A.jsonl', c: 2 },
      { source_file: '/tmp/file-B.jsonl', c: 1 },
    ]);
  });

  it('TC-I-06: regression — re-ingest of A after B does not duplicate or affect B rows', () => {
    // This is THE regression test that motivated the compaction_events table:
    // a per-session counter would double-count when an older source_file was
    // re-ingested; the composite-PK table must stay stable.
    const a = makeSession({
      compactionEvents: [
        compactionEvent({ sequence_in_file: 0, trigger: 'auto' }),
        compactionEvent({ sequence_in_file: 1, trigger: 'auto' }),
      ],
    });
    writeSession(db, a, '/tmp/file-A.jsonl');

    const b = makeSession({
      compactionEvents: [compactionEvent({ sequence_in_file: 0, trigger: 'manual' })],
    });
    writeSession(db, b, '/tmp/file-B.jsonl');

    // Re-ingest A — same content. Total must remain 3.
    writeSession(db, a, '/tmp/file-A.jsonl');

    const total = (
      db
        .prepare(
          'SELECT COUNT(*) AS c FROM compaction_events WHERE session_id = ?',
        )
        .get('sess-test-001') as { c: number }
    ).c;
    expect(total).toBe(3);

    // B's row is untouched (trigger still 'manual').
    const bRow = db
      .prepare(
        `SELECT trigger FROM compaction_events
         WHERE session_id = ? AND source_file = ? AND sequence_in_file = ?`,
      )
      .get('sess-test-001', '/tmp/file-B.jsonl', 0) as { trigger: string };
    expect(bRow.trigger).toBe('manual');
  });

  it('TC-I-07a: end-to-end ingest of sample-with-compaction.jsonl populates rows', () => {
    const filePath = path.resolve(
      process.cwd(),
      'tests/fixtures/sample-with-compaction.jsonl',
    );
    const outcome = ingestSingleFile(db, filePath);
    expect(outcome.kind).toBe('processed');

    const rows = db
      .prepare(
        `SELECT sequence_in_file, trigger, pre_tokens, post_tokens
         FROM compaction_events ORDER BY sequence_in_file`,
      )
      .all() as Array<{
      sequence_in_file: number;
      trigger: string | null;
      pre_tokens: number | null;
      post_tokens: number | null;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      sequence_in_file: 0,
      trigger: 'auto',
      pre_tokens: 968_559,
      post_tokens: 16_672,
    });
    expect(rows[1]).toEqual({
      sequence_in_file: 1,
      trigger: 'manual',
      pre_tokens: 712_044,
      post_tokens: 18_120,
    });
  });

  it('TC-I-07b: session with compactionEvents=[] writes zero rows', () => {
    writeSession(db, makeSession(), '/tmp/source.jsonl');
    const count = (
      db
        .prepare(
          'SELECT COUNT(*) AS c FROM compaction_events WHERE session_id = ?',
        )
        .get('sess-test-001') as { c: number }
    ).c;
    expect(count).toBe(0);
  });

  it('TC-I-07c: ON DELETE CASCADE — deleting the session removes its compaction_events rows', () => {
    const parsed = makeSession({
      compactionEvents: [
        compactionEvent({ sequence_in_file: 0 }),
        compactionEvent({ sequence_in_file: 1 }),
      ],
    });
    writeSession(db, parsed, '/tmp/source.jsonl');

    db.prepare('DELETE FROM sessions WHERE id = ?').run('sess-test-001');

    const count = (
      db
        .prepare(
          'SELECT COUNT(*) AS c FROM compaction_events WHERE session_id = ?',
        )
        .get('sess-test-001') as { c: number }
    ).c;
    expect(count).toBe(0);
  });
});

describe('ingestAll', () => {
  let db: DB;
  let tempDir: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    migrate(db);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-test-'));
    const fixture = fs.readFileSync(
      path.resolve(process.cwd(), 'tests/fixtures/sample.jsonl'),
      'utf8',
    );
    fs.writeFileSync(path.join(tempDir, 'sample.jsonl'), fixture);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('TC-I-INGEST-01: ingests fixture directory', async () => {
    const summary = await ingestAll({
      db,
      transcriptsRoot: tempDir,
      otelUrl: undefined,
    });
    expect(summary.filesProcessed).toBe(1);
    expect(summary.sessionsUpserted).toBe(1);
    expect(summary.turnsUpserted).toBe(3);
    expect(summary.errors).toEqual([]);

    const sessCount = (
      db.prepare('SELECT COUNT(*) as c FROM sessions').get() as { c: number }
    ).c;
    expect(sessCount).toBe(1);
  });

  it('TC-I-INGEST-02: idempotent re-ingest skips unchanged files', async () => {
    await ingestAll({ db, transcriptsRoot: tempDir });
    // Second pass: nothing changed on disk → per-file mtime gate skips parse.
    const summary2 = await ingestAll({ db, transcriptsRoot: tempDir });
    expect(summary2.sessionsUpserted).toBe(0);
    expect(summary2.filesProcessed).toBe(0);
    // But the session from the first pass is still present — no data loss.
    const sessCount = (
      db.prepare('SELECT COUNT(*) as c FROM sessions').get() as { c: number }
    ).c;
    expect(sessCount).toBe(1);
    // Bookkeeping table tracks the file.
    const tracked = (
      db
        .prepare('SELECT COUNT(*) as c FROM ingested_files')
        .get() as { c: number }
    ).c;
    expect(tracked).toBe(1);
  });

  it('TC-I-INGEST-04: re-ingests when the file mtime advances', async () => {
    await ingestAll({ db, transcriptsRoot: tempDir });
    // Bump mtime forward so the gate considers the file changed.
    const filePath = path.join(tempDir, 'sample.jsonl');
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(filePath, future, future);
    const summary2 = await ingestAll({ db, transcriptsRoot: tempDir });
    expect(summary2.sessionsUpserted).toBe(1);
    expect(summary2.filesProcessed).toBe(1);
  });

  it('TC-I-INGEST-05: picks up new files introduced after first pass', async () => {
    await ingestAll({ db, transcriptsRoot: tempDir });
    // Clone the fixture into a new file with a distinct session id.
    const fixture = fs.readFileSync(
      path.resolve(process.cwd(), 'tests/fixtures/sample.jsonl'),
      'utf8',
    );
    const rotated = fixture.replace(
      /"sessionId":"([^"]+)"/g,
      '"sessionId":"sess-rotated"',
    );
    fs.writeFileSync(path.join(tempDir, 'rotated.jsonl'), rotated);
    const summary2 = await ingestAll({ db, transcriptsRoot: tempDir });
    expect(summary2.filesProcessed).toBe(1);
    expect(summary2.sessionsUpserted).toBe(1);
    const sessCount = (
      db.prepare('SELECT COUNT(*) as c FROM sessions').get() as { c: number }
    ).c;
    expect(sessCount).toBe(2);
  });

  // TC-I-12d — verifies `ingestSingleFile` produces the same DB rows as the
  // single-file path through `ingestAll`. Guards the TASK-2.5 refactor so the
  // watcher (TASK-3) can reuse the helper without duplicating parse+write.
  it('TC-I-12d: ingestSingleFile matches ingestAll for one file', async () => {
    const filePath = path.join(tempDir, 'sample.jsonl');

    // Path A: ingestAll over a directory containing just this file.
    const outcome = ingestSingleFile(db, filePath);
    expect(outcome.kind).toBe('processed');

    const sessionCount = (
      db.prepare('SELECT COUNT(*) as c FROM sessions').get() as { c: number }
    ).c;
    expect(sessionCount).toBe(1);

    // Second call returns skipped-unchanged (mtime gate).
    const rerun = ingestSingleFile(db, filePath);
    expect(rerun.kind).toBe('skipped-unchanged');
  });

  it('TC-I-INGEST-03: captures OTEL errors without failing transcripts', async () => {
    const fetchFn = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;
    const summary = await ingestAll({
      db,
      transcriptsRoot: tempDir,
      otelUrl: 'http://localhost:9464/metrics',
      fetchFn,
    });
    expect(summary.filesProcessed).toBe(1);
    expect(summary.errors.length).toBeGreaterThanOrEqual(1);
    expect(summary.errors.some((e) => e.error.includes('connection refused'))).toBe(
      true,
    );
  });

  // TC-I-01 (subagent-inflation REQ-1, happy): parent JSONL window must NOT
  // be inflated by subagent JSONLs that share the parent sessionId. Pre-fix,
  // the writer would UPSERT the sessions row with each subagent's events,
  // collapsing started_at to T3 (way before parent). Post-fix,
  // listTranscriptFiles filters subagents/ entirely so the row reflects
  // ONLY the parent's [T1, T2] window.
  it('parent window reflects parent JSONL only, never subagents', async () => {
    const treeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-tc01-'));
    try {
      const sessionId = 'sess-subagent-parent';
      const cwd = '/Users/dev/proj-A';
      const T1 = 1_700_000_000_000; // parent started_at
      const T2 = 1_700_000_600_000; // parent ended_at (T1 + 10 min)
      const T3 = 1_690_000_000_000; // subagent timestamps — way before parent

      fs.writeFileSync(
        path.join(treeRoot, `${sessionId}.jsonl`),
        buildSubagentInflationJsonl({
          sessionId,
          cwd,
          startedAt: T1,
          endedAt: T2,
          uuidPrefix: 'parent',
        }),
      );

      const subagentDir = path.join(treeRoot, sessionId, 'subagents');
      fs.mkdirSync(subagentDir, { recursive: true });
      for (const tag of ['a', 'b', 'c']) {
        fs.writeFileSync(
          path.join(subagentDir, `agent-${tag}.jsonl`),
          buildSubagentInflationJsonl({
            sessionId, // shares parent's sessionId — that's the inflation footgun
            cwd,
            startedAt: T3,
            endedAt: T3 + 1_000,
            uuidPrefix: `sub-${tag}`,
          }),
        );
      }

      const summary = await ingestAll({
        db,
        transcriptsRoot: treeRoot,
        otelUrl: undefined,
      });
      expect(summary.filesProcessed).toBe(1);
      expect(summary.sessionsUpserted).toBe(1);

      const row = db
        .prepare('SELECT id, started_at, ended_at FROM sessions WHERE id = ?')
        .get(sessionId) as
        | { id: string; started_at: number; ended_at: number }
        | undefined;
      expect(row).toBeDefined();
      // Hard equality on epoch-ms: pre-fix this would be `started_at === T3`.
      expect(row?.started_at).toBe(T1);
      expect(row?.ended_at).toBe(T2);
    } finally {
      fs.rmSync(treeRoot, { recursive: true, force: true });
    }
  });

  // TC-I-02 (subagent-inflation REQ-1 + REQ-2, business): two distinct parent
  // sessions in the same tree, only S1 has subagents. Both parents' windows
  // must reflect their OWN events, never the union. Guards against any
  // global "skip subagents but keep their events somewhere" regression.
  it('multi-session tree: each session window reflects its own parent only', async () => {
    const treeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-tc02-'));
    try {
      const S1 = 'sess-multi-A';
      const S2 = 'sess-multi-B';

      const S1_T1 = 1_700_000_000_000;
      const S1_T2 = 1_700_000_600_000;
      const S1_OUT = 1_690_000_000_000; // S1 subagent: outside S1 window

      const S2_T1 = 1_710_000_000_000;
      const S2_T2 = 1_710_000_300_000;

      fs.writeFileSync(
        path.join(treeRoot, `${S1}.jsonl`),
        buildSubagentInflationJsonl({
          sessionId: S1,
          cwd: '/Users/dev/proj-A',
          startedAt: S1_T1,
          endedAt: S1_T2,
          uuidPrefix: 's1-parent',
        }),
      );
      fs.writeFileSync(
        path.join(treeRoot, `${S2}.jsonl`),
        buildSubagentInflationJsonl({
          sessionId: S2,
          cwd: '/Users/dev/proj-B',
          startedAt: S2_T1,
          endedAt: S2_T2,
          uuidPrefix: 's2-parent',
        }),
      );

      const s1SubDir = path.join(treeRoot, S1, 'subagents');
      fs.mkdirSync(s1SubDir, { recursive: true });
      fs.writeFileSync(
        path.join(s1SubDir, 'agent-a.jsonl'),
        buildSubagentInflationJsonl({
          sessionId: S1,
          cwd: '/Users/dev/proj-A',
          startedAt: S1_OUT,
          endedAt: S1_OUT + 1_000,
          uuidPrefix: 's1-sub-a',
        }),
      );
      fs.writeFileSync(
        path.join(s1SubDir, 'agent-b.jsonl'),
        buildSubagentInflationJsonl({
          sessionId: S1,
          cwd: '/Users/dev/proj-A',
          startedAt: S1_OUT + 2_000,
          endedAt: S1_OUT + 3_000,
          uuidPrefix: 's1-sub-b',
        }),
      );

      const summary = await ingestAll({
        db,
        transcriptsRoot: treeRoot,
        otelUrl: undefined,
      });
      expect(summary.filesProcessed).toBe(2);
      expect(summary.sessionsUpserted).toBe(2);

      const rows = db
        .prepare('SELECT id, started_at, ended_at FROM sessions ORDER BY id')
        .all() as Array<{ id: string; started_at: number; ended_at: number }>;
      expect(rows).toHaveLength(2);

      const byId = new Map(rows.map((r) => [r.id, r]));
      const s1 = byId.get(S1);
      const s2 = byId.get(S2);
      expect(s1?.started_at).toBe(S1_T1);
      expect(s1?.ended_at).toBe(S1_T2);
      expect(s2?.started_at).toBe(S2_T1);
      expect(s2?.ended_at).toBe(S2_T2);
    } finally {
      fs.rmSync(treeRoot, { recursive: true, force: true });
    }
  });

  // TC-I-07 (subagent-inflation REQ-5, regression): after cleanup, re-ingest
  // from the same fixture tree (in-process via ingestAll, NOT pnpm subprocess)
  // produces a clean DB with windows reflecting parents only and no orphans
  // in any child table. Composes TASK-1 (filter) + TASK-3 (cleanup script).
  it('post-cleanup-then-reingest: end-to-end loop yields clean state', async () => {
    const treeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-tc07-'));
    try {
      const sessionId = 'sess-tc07-parent';
      const cwd = '/Users/dev/proj-tc07';
      const T1 = 1_700_000_000_000;
      const T2 = 1_700_000_600_000;
      const T3 = 1_690_000_000_000;

      // Initial fixture: parent + subagent JSONLs (subagent files exist on
      // disk but TASK-1's filter excludes them from listTranscriptFiles).
      fs.writeFileSync(
        path.join(treeRoot, `${sessionId}.jsonl`),
        buildSubagentInflationJsonl({
          sessionId,
          cwd,
          startedAt: T1,
          endedAt: T2,
          uuidPrefix: 'tc07-parent',
        }),
      );
      const subagentDir = path.join(treeRoot, sessionId, 'subagents');
      fs.mkdirSync(subagentDir, { recursive: true });
      fs.writeFileSync(
        path.join(subagentDir, 'agent-x.jsonl'),
        buildSubagentInflationJsonl({
          sessionId,
          cwd,
          startedAt: T3,
          endedAt: T3 + 1_000,
          uuidPrefix: 'tc07-sub',
        }),
      );

      // First ingest pass — populates sessions/turns/ingested_files.
      await ingestAll({ db, transcriptsRoot: treeRoot, otelUrl: undefined });
      const ingestedBefore = (
        db.prepare('SELECT COUNT(*) AS c FROM ingested_files').get() as {
          c: number;
        }
      ).c;
      // Tight equality: only the parent JSONL should be tracked. If the
      // subagent filter regresses, this would be 2 (parent + subagent).
      expect(ingestedBefore).toBe(1);

      // Run cleanup (real run) — wipes 8 tables in dependency order.
      const { cleanupSubagentInflation } = await import(
        '@/scripts/cleanup-subagent-inflation'
      );
      cleanupSubagentInflation(db, { dryRun: false });

      // Confirm DB is wiped before re-ingest.
      for (const t of [
        'sessions',
        'turns',
        'tool_calls',
        'session_outcomes',
        'compaction_events',
        'ratings',
        'reporter_pushed_sessions',
        'ingested_files',
      ] as const) {
        const c = (
          db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }
        ).c;
        expect(c).toBe(0);
      }

      // Re-ingest from the same JSONL tree (in-process, NOT subprocess).
      const summary = await ingestAll({
        db,
        transcriptsRoot: treeRoot,
        otelUrl: undefined,
      });
      expect(summary.filesProcessed).toBe(1);
      expect(summary.sessionsUpserted).toBe(1);

      // Window reflects parent only — same contract as TC-I-01.
      const row = db
        .prepare('SELECT id, started_at, ended_at FROM sessions WHERE id = ?')
        .get(sessionId) as
        | { id: string; started_at: number; ended_at: number }
        | undefined;
      expect(row?.started_at).toBe(T1);
      expect(row?.ended_at).toBe(T2);

      // ingested_files repopulated (post-cleanup state recovered).
      const ingestedAfter = (
        db.prepare('SELECT COUNT(*) AS c FROM ingested_files').get() as {
          c: number;
        }
      ).c;
      expect(ingestedAfter).toBeGreaterThan(0);

      // No orphan turns: every turn references the one session.
      const orphanTurns = (
        db
          .prepare(
            'SELECT COUNT(*) AS c FROM turns WHERE session_id NOT IN (SELECT id FROM sessions)',
          )
          .get() as { c: number }
      ).c;
      expect(orphanTurns).toBe(0);
    } finally {
      fs.rmSync(treeRoot, { recursive: true, force: true });
    }
  });
});
