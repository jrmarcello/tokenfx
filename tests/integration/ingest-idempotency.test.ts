import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, type DB } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';
import { ingestAll } from '@/lib/ingest/writer';

/**
 * REQ-8 / TC-I-12 — `pnpm ingest` (via direct `ingestAll`) executed twice
 * consecutively against the same JSONL fixture must produce byte-identical
 * counts for sessions, turns, and tool_calls. Exercises the JSONL parser
 * boundary end-to-end (not the seed shortcut used elsewhere in the suite),
 * proving the `INSERT ... ON CONFLICT DO UPDATE` upsert path is naturally
 * idempotent on re-ingest.
 *
 * Fixture: `tests/fixtures/ingest-idempotency/sample.jsonl` — a small
 * deterministic transcript with three turns and one tool_use that
 * exercises all three target tables on the first pass.
 *
 * The test covers two re-ingest modes:
 *   1. mtime unchanged — the per-file gate short-circuits the second pass
 *      (the cheap-and-common case).
 *   2. mtime bumped — the gate is bypassed and the parser + writer run
 *      a second time, exercising the actual ON CONFLICT path.
 * Both modes must yield identical row counts.
 */

const FIXTURE_DIR_REL = 'tests/fixtures/ingest-idempotency';
const FIXTURE_FILE = 'sample.jsonl';

type RowCounts = {
  readonly sessions: number;
  readonly turns: number;
  readonly toolCalls: number;
};

const countRows = (db: DB): RowCounts => {
  const sessions = (
    db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }
  ).c;
  const turns = (
    db.prepare('SELECT COUNT(*) AS c FROM turns').get() as { c: number }
  ).c;
  const toolCalls = (
    db.prepare('SELECT COUNT(*) AS c FROM tool_calls').get() as { c: number }
  ).c;
  return { sessions, turns, toolCalls };
};

const stageFixture = (destDir: string): string => {
  const src = path.resolve(process.cwd(), FIXTURE_DIR_REL, FIXTURE_FILE);
  const dest = path.join(destDir, FIXTURE_FILE);
  fs.copyFileSync(src, dest);
  return dest;
};

const bumpMtime = (filePath: string): void => {
  // Advance both atime and mtime by one second so `ingestSingleFile`'s
  // mtime-gate (`mtimeMs <= prev.mtime_ms`) lets the second pass through.
  const now = Date.now();
  const future = new Date(now + 1000);
  fs.utimesSync(filePath, future, future);
};

describe('ingest — re-ingest idempotency (REQ-8 / TC-I-12)', () => {
  let db: DB;
  let tempDir: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    migrate(db);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-idempotency-'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('TC-I-12: ingestAll() twice with unchanged fixture yields byte-identical session/turn/tool_call counts', async () => {
    stageFixture(tempDir);

    const run1 = await ingestAll({ db, transcriptsRoot: tempDir });
    expect(run1.errors).toEqual([]);
    expect(run1.filesProcessed).toBe(1);

    const after1 = countRows(db);
    // Sanity: the fixture must actually exercise all three tables on the
    // first pass — otherwise the idempotency assertion would be vacuous.
    expect(after1.sessions).toBeGreaterThan(0);
    expect(after1.turns).toBeGreaterThan(0);
    expect(after1.toolCalls).toBeGreaterThan(0);

    const run2 = await ingestAll({ db, transcriptsRoot: tempDir });
    expect(run2.errors).toEqual([]);
    // mtime-gate short-circuits run 2 — file is reported as unchanged,
    // never reprocessed.
    expect(run2.filesProcessed).toBe(0);

    const after2 = countRows(db);
    expect(after2).toEqual(after1);
  });

  it('TC-I-12: ingestAll() twice with bumped mtime (bypasses the mtime-gate) still yields byte-identical counts', async () => {
    const staged = stageFixture(tempDir);

    const run1 = await ingestAll({ db, transcriptsRoot: tempDir });
    expect(run1.errors).toEqual([]);
    expect(run1.filesProcessed).toBe(1);
    const after1 = countRows(db);

    // Force the parser + writer to actually re-execute against the same
    // fixture — this is the real test of ON CONFLICT DO UPDATE on
    // sessions/turns/tool_calls (the mtime-gated variant above only
    // proves the short-circuit works).
    bumpMtime(staged);

    const run2 = await ingestAll({ db, transcriptsRoot: tempDir });
    expect(run2.errors).toEqual([]);
    expect(run2.filesProcessed).toBe(1);

    const after2 = countRows(db);
    expect(after2).toEqual(after1);
  });
});
