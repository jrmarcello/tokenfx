import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { openDatabase, type DB } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';

import {
  cleanupSubagentInflation,
  TABLES_IN_DEPENDENCY_ORDER,
} from './cleanup-subagent-inflation';

/**
 * Minimal seed helper for cleanup tests. Inserts rows into all 8 target
 * tables with mutual FK consistency so DELETE-with-FK-on doesn't choke.
 */
type SeedResult = {
  sessions: number;
  turns: number;
  toolCalls: number;
  ratings: number;
  ingestedFiles: number;
  sessionOutcomes: number;
  compactionEvents: number;
  reporterPushed: number;
};

const seedDb = (db: DB): SeedResult => {
  const sessionCount = 5;
  const turnsPerSession = 20; // 5 * 20 = 100 turns
  const toolsPerTurn = 1; // 100 turns -> some 50 tool_calls (every other turn)
  const now = Date.now();

  const insertSession = db.prepare(
    `INSERT INTO sessions (
       id, slug, cwd, project, started_at, ended_at,
       total_input_tokens, total_output_tokens,
       total_cache_read_tokens, total_cache_creation_tokens,
       total_cost_usd, turn_count, tool_call_count,
       source_file, ingested_at
     ) VALUES (
       @id, NULL, '/tmp', 'p', @started, @ended,
       0, 0, 0, 0, 0, @turn_count, @tool_count,
       @source_file, @ingested_at
     )`,
  );
  const insertTurn = db.prepare(
    `INSERT INTO turns (
       id, session_id, sequence, timestamp, model,
       input_tokens, output_tokens, cache_read_tokens,
       cache_creation_tokens, cost_usd
     ) VALUES (
       @id, @session_id, @sequence, @timestamp, 'm',
       0, 0, 0, 0, 0
     )`,
  );
  const insertToolCall = db.prepare(
    `INSERT INTO tool_calls (id, turn_id, tool_name, input_json)
     VALUES (@id, @turn_id, 'Bash', '{}')`,
  );
  const insertRating = db.prepare(
    `INSERT INTO ratings (turn_id, rating, rated_at)
     VALUES (@turn_id, 1, @rated_at)`,
  );
  const insertIngested = db.prepare(
    `INSERT INTO ingested_files (path, mtime_ms, ingested_at)
     VALUES (@path, @mtime_ms, @ingested_at)`,
  );
  const insertOutcome = db.prepare(
    `INSERT INTO session_outcomes (session_id, last_evaluated_at)
     VALUES (@session_id, @last_evaluated_at)`,
  );
  const insertCompaction = db.prepare(
    `INSERT INTO compaction_events (session_id, source_file, sequence_in_file, ts)
     VALUES (@session_id, @source_file, @sequence_in_file, @ts)`,
  );
  const insertReporter = db.prepare(
    `INSERT INTO reporter_pushed_sessions (session_id, payload_hash, pushed_at)
     VALUES (@session_id, 'h', @pushed_at)`,
  );

  let toolCallCount = 0;
  let ratingsCount = 0;

  const tx = db.transaction(() => {
    for (let s = 0; s < sessionCount; s++) {
      const sid = `sess-${s}`;
      insertSession.run({
        id: sid,
        started: now,
        ended: now + 60_000,
        turn_count: turnsPerSession,
        tool_count: 0,
        source_file: `/tmp/${sid}.jsonl`,
        ingested_at: now,
      });

      for (let t = 0; t < turnsPerSession; t++) {
        const tid = `${sid}-t-${t}`;
        insertTurn.run({
          id: tid,
          session_id: sid,
          sequence: t,
          timestamp: now + t * 1000,
        });
        // 50 tool_calls total: alternate turns get a tool_call.
        if (t % 2 === 0) {
          for (let k = 0; k < toolsPerTurn; k++) {
            insertToolCall.run({ id: `${tid}-tc-${k}`, turn_id: tid });
            toolCallCount += 1;
          }
        }
      }

      // 3 ratings only on first 3 sessions.
      if (s < 3) {
        insertRating.run({ turn_id: `${sid}-t-0`, rated_at: now });
        ratingsCount += 1;
      }

      // 2 reporter_pushed_sessions only on first 2 sessions.
      if (s < 2) {
        insertReporter.run({ session_id: sid, pushed_at: now });
      }

      // 1 outcome per session (5 total).
      insertOutcome.run({ session_id: sid, last_evaluated_at: now });

      // 1 compaction per session (5 total).
      insertCompaction.run({
        session_id: sid,
        source_file: `/tmp/${sid}.jsonl`,
        sequence_in_file: 0,
        ts: now,
      });
    }

    // ingested_files: 4 unrelated entries.
    for (let i = 0; i < 4; i++) {
      insertIngested.run({
        path: `/tmp/ingested-${i}.jsonl`,
        mtime_ms: now,
        ingested_at: now,
      });
    }
  });
  tx();

  return {
    sessions: sessionCount,
    turns: sessionCount * turnsPerSession,
    toolCalls: toolCallCount,
    ratings: ratingsCount,
    ingestedFiles: 4,
    sessionOutcomes: sessionCount,
    compactionEvents: sessionCount,
    reporterPushed: 2,
  };
};

const counts = (db: DB): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const t of TABLES_IN_DEPENDENCY_ORDER) {
    const row = db
      .prepare(`SELECT COUNT(*) AS c FROM ${t}`)
      .get() as { c: number };
    out[t] = row.c;
  }
  return out;
};

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d && fs.existsSync(d)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  }
});

describe('cleanupSubagentInflation', () => {
  // TC-I-03 (REQ-5)
  it('real-run wipes all dependency-ordered tables on a seeded DB and reports counts', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const seeded = seedDb(db);

    // Sanity pre-conditions match the spec's TC-I-03 fixture.
    expect(seeded.sessions).toBe(5);
    expect(seeded.ratings).toBe(3);
    expect(seeded.reporterPushed).toBe(2);
    expect(seeded.turns).toBe(100);
    expect(seeded.toolCalls).toBe(50);

    const result = cleanupSubagentInflation(db, { dryRun: false });

    const after = counts(db);
    for (const t of TABLES_IN_DEPENDENCY_ORDER) {
      expect(after[t]).toBe(0);
    }

    // Reported counts match what was actually deleted.
    expect(result.dryRun).toBe(false);
    expect(result.counts.sessions).toBe(5);
    expect(result.counts.turns).toBe(100);
    expect(result.counts.tool_calls).toBe(50);
    expect(result.counts.ratings).toBe(3);
    expect(result.counts.reporter_pushed_sessions).toBe(2);
    expect(result.counts.session_outcomes).toBe(5);
    expect(result.counts.compaction_events).toBe(5);
    expect(result.counts.ingested_files).toBe(4);

    db.close();
  });

  // TC-I-04 (REQ-6)
  it('dry-run reports counts but performs no DELETE', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const seeded = seedDb(db);

    const before = counts(db);
    const result = cleanupSubagentInflation(db, { dryRun: true });
    const after = counts(db);

    expect(result.dryRun).toBe(true);
    // Counts unchanged.
    for (const t of TABLES_IN_DEPENDENCY_ORDER) {
      expect(after[t]).toBe(before[t]);
    }
    // Returned counts match observed pre-state.
    expect(result.counts.sessions).toBe(seeded.sessions);
    expect(result.counts.turns).toBe(seeded.turns);
    expect(result.counts.tool_calls).toBe(seeded.toolCalls);
    expect(result.counts.ratings).toBe(seeded.ratings);
    expect(result.counts.reporter_pushed_sessions).toBe(seeded.reporterPushed);
    expect(result.counts.session_outcomes).toBe(seeded.sessionOutcomes);
    expect(result.counts.compaction_events).toBe(seeded.compactionEvents);
    expect(result.counts.ingested_files).toBe(seeded.ingestedFiles);

    db.close();
  });

  // TC-I-05 (REQ-7): idempotency on empty state
  it('reports zeros and never throws when invoked against an empty DB', () => {
    const db = openDatabase(':memory:');
    migrate(db);

    expect(() => cleanupSubagentInflation(db, { dryRun: false })).not.toThrow();
    expect(() => cleanupSubagentInflation(db, { dryRun: true })).not.toThrow();

    const result = cleanupSubagentInflation(db, { dryRun: false });
    for (const t of TABLES_IN_DEPENDENCY_ORDER) {
      expect(result.counts[t]).toBe(0);
    }
    db.close();
  });

  // TC-I-06 (REQ-8)
  it('creates a fresh DB when DASHBOARD_DB_PATH points to a non-existent file', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-test-'));
    tmpDirs.push(tmp);
    const dbPath = path.join(tmp, 'nonexistent-cleanup-test.db');

    expect(fs.existsSync(dbPath)).toBe(false);
    const db = openDatabase(dbPath);
    migrate(db);
    expect(fs.existsSync(dbPath)).toBe(true);

    const result = cleanupSubagentInflation(db, { dryRun: false });
    for (const t of TABLES_IN_DEPENDENCY_ORDER) {
      expect(result.counts[t]).toBe(0);
    }

    db.close();
  });

  // TC-I-08 (REQ-9): output goes through `lib/logger`, never raw `console.*`.
  // `log.info` routes to `console.info` and `log.error` to `console.error`,
  // so the assertion is: `console.info` IS called (proving the logger
  // pathway is used), `console.log` / `console.warn` / `console.debug` /
  // `console.error` are NOT called on the happy path. Uses a hand-written
  // stub (no `vi.mock` / `vi.spyOn` per project rule).
  it('cleanup output flows through lib/logger; no raw console.* writes', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    seedDb(db);

    type ConsoleKey = 'log' | 'info' | 'warn' | 'error' | 'debug';
    const calls: Record<ConsoleKey, number> = {
      log: 0,
      info: 0,
      warn: 0,
      error: 0,
      debug: 0,
    };
    const originals = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
    };
    for (const key of Object.keys(originals) as ConsoleKey[]) {
      console[key] = (): void => {
        calls[key] += 1;
      };
    }

    try {
      cleanupSubagentInflation(db, { dryRun: false });
      // log.info → console.info MUST have been hit (one per table + nothing
      // else on the happy path); proves the logger pathway was exercised.
      expect(calls.info).toBeGreaterThan(0);
      // Direct console writes MUST be zero. Catches any future drift to
      // `console.log` / `console.error` / etc.
      expect(calls.log).toBe(0);
      expect(calls.warn).toBe(0);
      expect(calls.error).toBe(0);
      expect(calls.debug).toBe(0);
    } finally {
      for (const key of Object.keys(originals) as ConsoleKey[]) {
        console[key] = originals[key];
      }
      db.close();
    }
  });
});
