import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from './client';
import { migrate } from './migrate';
import { writeSession } from '@/lib/ingest/writer';
import type { ParsedSession } from '@/lib/ingest/transcript/types';

// Hand-written seed helpers (no mocking framework, matches lib/queries/effectiveness.test.ts style).

function insertSession(
  db: DB,
  args: { id: string; project?: string; startedAt?: number },
): void {
  db.prepare(
    `INSERT INTO sessions (
      id, slug, cwd, project, git_branch, cc_version,
      started_at, ended_at,
      total_input_tokens, total_output_tokens, total_cache_read_tokens, total_cache_creation_tokens,
      total_cost_usd, turn_count, tool_call_count,
      source_file, ingested_at
    ) VALUES (?, NULL, ?, ?, NULL, NULL, ?, ?, 0, 0, 0, 0, 0, 0, 0, ?, ?)`,
  ).run(
    args.id,
    '/tmp/cwd',
    args.project ?? 'demo',
    args.startedAt ?? Date.now(),
    (args.startedAt ?? Date.now()) + 60_000,
    `file-${args.id}.jsonl`,
    Date.now(),
  );
}

function insertTurn(
  db: DB,
  args: {
    id: string;
    sessionId: string;
    sequence: number;
    userPrompt: string | null;
    assistantText?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO turns (
      id, session_id, parent_uuid, sequence, timestamp, model,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
      cost_usd, stop_reason, user_prompt, assistant_text, tool_uses_json
    ) VALUES (?, ?, NULL, ?, ?, 'claude', 0, 0, 0, 0, 0, NULL, ?, ?, '[]')`,
  ).run(
    args.id,
    args.sessionId,
    args.sequence,
    Date.now(),
    args.userPrompt,
    args.assistantText ?? null,
  );
}

function freshDb(): DB {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

describe('migrate — FTS5 turns_fts', () => {
  let db: DB;

  beforeEach(() => {
    db = freshDb();
  });

  it('TC-I-01 (REQ-1): creates turns_fts virtual table', () => {
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='turns_fts'",
      )
      .get() as { name: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.name).toBe('turns_fts');
  });

  it('TC-I-02 (REQ-2): backfill repopulates turns_fts when it lags turns; idempotent re-run', () => {
    insertSession(db, { id: 's-bf' });
    // 5 turns with distinctive tokens so MATCH can count indexed documents.
    // Note: external-content FTS5 tables report `SELECT COUNT(*)` from the
    // content table (turns), not from the index itself. To observe the
    // actual indexed-document count we use `MATCH` queries with a token
    // present in every row.
    for (let i = 0; i < 5; i++) {
      insertTurn(db, {
        id: `tbf-${i}`,
        sessionId: 's-bf',
        sequence: i,
        userPrompt: `promptbf${i} sharedtoken`,
        assistantText: `responsebf${i} sharedtoken`,
      });
    }
    const matchBefore = db
      .prepare(
        "SELECT COUNT(*) as c FROM turns_fts WHERE turns_fts MATCH 'sharedtoken'",
      )
      .get() as { c: number };
    expect(matchBefore.c).toBe(5);

    // Simulate a legacy DB where turns_fts was never populated: wipe the
    // FTS index in place (keeps the virtual table + triggers). `delete-all`
    // is FTS5's documented "clear every indexed document" command. After
    // this, MATCH returns 0 even though `turns` still has 5 rows.
    db.exec("INSERT INTO turns_fts(turns_fts) VALUES('delete-all')");
    const matchEmpty = db
      .prepare(
        "SELECT COUNT(*) as c FROM turns_fts WHERE turns_fts MATCH 'sharedtoken'",
      )
      .get() as { c: number };
    expect(matchEmpty.c).toBe(0);

    // Re-run migrate. The backfill `INSERT ... WHERE NOT EXISTS` should
    // repopulate the index from turns.
    migrate(db);
    const matchAfter = db
      .prepare(
        "SELECT COUNT(*) as c FROM turns_fts WHERE turns_fts MATCH 'sharedtoken'",
      )
      .get() as { c: number };
    expect(matchAfter.c).toBe(5);

    // Idempotency: another migrate must NOT duplicate rows in the index.
    migrate(db);
    const matchAgain = db
      .prepare(
        "SELECT COUNT(*) as c FROM turns_fts WHERE turns_fts MATCH 'sharedtoken'",
      )
      .get() as { c: number };
    expect(matchAgain.c).toBe(5);
  });

  it('TC-I-03 (REQ-3): INSERT into turns is reflected in turns_fts', () => {
    insertSession(db, { id: 's-ins' });
    insertTurn(db, {
      id: 't-ins',
      sessionId: 's-ins',
      sequence: 0,
      userPrompt: 'hello foo world',
      assistantText: 'some reply',
    });
    const rows = db
      .prepare("SELECT rowid FROM turns_fts WHERE turns_fts MATCH 'foo'")
      .all() as Array<{ rowid: number }>;
    expect(rows.length).toBe(1);
  });

  it('TC-I-04 (REQ-3): UPDATE on turns updates the FTS index', () => {
    insertSession(db, { id: 's-upd' });
    insertTurn(db, {
      id: 't-upd',
      sessionId: 's-upd',
      sequence: 0,
      userPrompt: 'hello foo world',
      assistantText: 'reply',
    });
    db.prepare(`UPDATE turns SET user_prompt = 'bar world' WHERE id = ?`).run(
      't-upd',
    );
    const foo = db
      .prepare("SELECT COUNT(*) as c FROM turns_fts WHERE turns_fts MATCH 'foo'")
      .get() as { c: number };
    const bar = db
      .prepare("SELECT COUNT(*) as c FROM turns_fts WHERE turns_fts MATCH 'bar'")
      .get() as { c: number };
    expect(foo.c).toBe(0);
    expect(bar.c).toBe(1);
  });

  it('TC-I-05 (REQ-3): DELETE on turns removes the row from turns_fts', () => {
    insertSession(db, { id: 's-del' });
    insertTurn(db, {
      id: 't-del',
      sessionId: 's-del',
      sequence: 0,
      userPrompt: 'uniquedeletetoken',
      assistantText: null,
    });
    // MATCH the distinctive token to observe the index contents (external-
    // content FTS5 tables ignore bare `COUNT(*)` for index counts).
    const before = db
      .prepare(
        "SELECT COUNT(*) as c FROM turns_fts WHERE turns_fts MATCH 'uniquedeletetoken'",
      )
      .get() as { c: number };
    expect(before.c).toBe(1);
    db.prepare('DELETE FROM turns WHERE id = ?').run('t-del');
    const after = db
      .prepare(
        "SELECT COUNT(*) as c FROM turns_fts WHERE turns_fts MATCH 'uniquedeletetoken'",
      )
      .get() as { c: number };
    expect(after.c).toBe(0);
  });

  it('TC-I-17 (REQ-16): writeSession populates turns_fts via triggers (no writer change)', () => {
    const parsed: ParsedSession = {
      id: 's-writer',
      cwd: '/tmp/cwd',
      project: 'demo',
      gitBranch: null,
      ccVersion: null,
      startedAt: Date.now() - 60_000,
      endedAt: Date.now(),
      turns: [
        {
          id: 't-writer',
          parentUuid: null,
          sequence: 0,
          timestamp: Date.now(),
          model: 'claude-opus-4-7',
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          stopReason: null,
          userPrompt: 'ingestion test xylophone',
          assistantText: 'the response text',
          toolCalls: [],
        },
      ],
    };
    writeSession(db, parsed, '/tmp/file.jsonl');
    const hits = db
      .prepare(
        "SELECT rowid FROM turns_fts WHERE turns_fts MATCH 'xylophone'",
      )
      .all() as Array<{ rowid: number }>;
    expect(hits.length).toBe(1);
  });

  it('TC-I-18 (REQ-3): NULL user_prompt with non-null assistant_text is still searchable', () => {
    insertSession(db, { id: 's-null' });
    insertTurn(db, {
      id: 't-null',
      sessionId: 's-null',
      sequence: 0,
      userPrompt: null,
      assistantText: 'xyz',
    });
    const rows = db
      .prepare("SELECT rowid FROM turns_fts WHERE turns_fts MATCH 'xyz'")
      .all() as Array<{ rowid: number }>;
    expect(rows.length).toBe(1);
  });
});
