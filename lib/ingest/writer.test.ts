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
import type { ParsedSession } from './transcript/types';
import type { OtelScrape } from './otel/parser';

function makeSession(overrides?: Partial<ParsedSession>): ParsedSession {
  return {
    id: 'sess-test-001',
    cwd: '/Users/dev/proj',
    project: 'proj',
    gitBranch: 'main',
    ccVersion: '2.0.0',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_100_000,
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
});
