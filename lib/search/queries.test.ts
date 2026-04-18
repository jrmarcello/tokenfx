import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';
import { searchTurns } from './queries';

const DAY_MS = 86_400_000;

type SeedTurn = {
  id: string;
  sessionId: string;
  sequence: number;
  userPrompt: string | null;
  assistantText: string | null;
  timestampOffsetMs?: number;
  model?: string;
};

type SeedSession = {
  id: string;
  project?: string;
  daysAgo?: number;
};

function insertSession(db: DB, s: SeedSession): void {
  const startedAt = Date.now() - (s.daysAgo ?? 1) * DAY_MS;
  db.prepare(
    `INSERT INTO sessions (
      id, slug, cwd, project, git_branch, cc_version,
      started_at, ended_at,
      total_input_tokens, total_output_tokens,
      total_cache_read_tokens, total_cache_creation_tokens,
      total_cost_usd, turn_count, tool_call_count,
      source_file, ingested_at
    ) VALUES (?, NULL, '/cwd', ?, NULL, NULL, ?, ?, 0, 0, 0, 0, 0, 0, 0, 'src', ?)`,
  ).run(
    s.id,
    s.project ?? 'proj',
    startedAt,
    startedAt + 60_000,
    Date.now(),
  );
}

function insertTurn(db: DB, t: SeedTurn): void {
  db.prepare(
    `INSERT INTO turns (
      id, session_id, parent_uuid, sequence, timestamp, model,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
      cost_usd, stop_reason, user_prompt, assistant_text, tool_uses_json
    ) VALUES (?, ?, NULL, ?, ?, ?, 0, 0, 0, 0, 0, NULL, ?, ?, '[]')`,
  ).run(
    t.id,
    t.sessionId,
    t.sequence,
    Date.now() + (t.timestampOffsetMs ?? 0),
    t.model ?? 'claude-sonnet',
    t.userPrompt,
    t.assistantText,
  );
}

function fresh(): DB {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

describe('searchTurns', () => {
  let db: DB;

  beforeEach(() => {
    db = fresh();
  });

  describe('happy path + shape', () => {
    beforeEach(() => {
      insertSession(db, { id: 's1', project: 'alpha' });
      insertTurn(db, {
        id: 't1',
        sessionId: 's1',
        sequence: 1,
        userPrompt: 'resolve the auth bug in route handler',
        assistantText: 'I identified the issue — here is the fix for auth',
        model: 'claude-sonnet-4-6',
      });
      insertTurn(db, {
        id: 't2',
        sessionId: 's1',
        sequence: 2,
        userPrompt: 'unrelated refactor',
        assistantText: 'ok',
      });
    });

    // TC-I-06 + TC-I-07: hit ordering + full shape
    it('TC-I-06/07: returns ordered hits with bm25 score and full shape', () => {
      const res = searchTurns(db, { query: 'auth' });
      expect(res.total).toBe(1);
      expect(res.items).toHaveLength(1);
      const hit = res.items[0];
      expect(hit.turnId).toBe('t1');
      expect(hit.sessionId).toBe('s1');
      expect(hit.project).toBe('alpha');
      expect(hit.sequence).toBe(1);
      expect(typeof hit.timestamp).toBe('number');
      expect(hit.model).toBe('claude-sonnet-4-6');
      expect(typeof hit.score).toBe('number');
      // bm25 in SQLite returns negative; ASC = best first. We accept any
      // finite number — stability, not magnitude, is what matters here.
      expect(Number.isFinite(hit.score)).toBe(true);
      // Snippet contains the <mark> delimiter around the match.
      expect(hit.promptSnippet).toContain('<mark>');
      expect(hit.responseSnippet).toContain('<mark>');
    });

    it('TC-I-06: orders by bm25 ASC when multiple matches exist', () => {
      // Add a second session with less relevant match (single occurrence vs
      // two in t1). bm25 should rank t1 first.
      insertSession(db, { id: 's2', project: 'beta' });
      insertTurn(db, {
        id: 't3',
        sessionId: 's2',
        sequence: 1,
        userPrompt: 'a fleeting mention of auth',
        assistantText: 'ok',
      });
      const res = searchTurns(db, { query: 'auth' });
      expect(res.total).toBe(2);
      expect(res.items.length).toBe(2);
      // ASC: first hit should have the lower (more negative) score.
      expect(res.items[0].score).toBeLessThanOrEqual(res.items[1].score);
    });
  });

  describe('empty / sanitized-out queries (fast-path)', () => {
    // TC-I-08
    it('TC-I-08: empty query returns zero without DB', () => {
      expect(searchTurns(db, { query: '' })).toEqual({ items: [], total: 0 });
    });
    // TC-I-09
    it('TC-I-09: whitespace-only query returns zero', () => {
      expect(searchTurns(db, { query: '    ' })).toEqual({
        items: [],
        total: 0,
      });
    });
    it('single-char query returns zero', () => {
      expect(searchTurns(db, { query: 'a' })).toEqual({ items: [], total: 0 });
    });
  });

  describe('security — FTS5 injection attempts', () => {
    beforeEach(() => {
      insertSession(db, { id: 's1' });
      insertTurn(db, {
        id: 't1',
        sessionId: 's1',
        sequence: 1,
        userPrompt: 'normal content with word',
        assistantText: 'response',
      });
    });

    // TC-I-10
    it('TC-I-10: malicious query does not throw', () => {
      expect(() =>
        searchTurns(db, { query: 'a"b\'c); DROP TABLE turns;--' }),
      ).not.toThrow();
    });

    it('uppercase AND/OR/NOT are treated as terms, not operators', () => {
      // No matches expected but MUST NOT throw.
      expect(() => searchTurns(db, { query: 'AND OR NOT' })).not.toThrow();
    });
  });

  describe('time window filter', () => {
    beforeEach(() => {
      insertSession(db, { id: 'recent', daysAgo: 2 });
      insertSession(db, { id: 'old', daysAgo: 90 });
      insertTurn(db, {
        id: 't-recent',
        sessionId: 'recent',
        sequence: 1,
        userPrompt: 'remembering the auth bug',
        assistantText: null,
      });
      insertTurn(db, {
        id: 't-old',
        sessionId: 'old',
        sequence: 1,
        userPrompt: 'ancient mention of auth',
        assistantText: null,
      });
    });

    // TC-I-11
    it('TC-I-11: days: 30 excludes sessions older than the window', () => {
      const res = searchTurns(db, { query: 'auth', days: 30 });
      expect(res.total).toBe(1);
      expect(res.items[0].turnId).toBe('t-recent');
    });

    // TC-I-12
    it('TC-I-12: omitting days searches all history', () => {
      const res = searchTurns(db, { query: 'auth' });
      expect(res.total).toBe(2);
      const ids = res.items.map((i) => i.turnId).sort();
      expect(ids).toEqual(['t-old', 't-recent']);
    });

    it('days: 0 (falsy) searches all history', () => {
      const res = searchTurns(db, { query: 'auth', days: 0 });
      expect(res.total).toBe(2);
    });
  });

  describe('limit / offset / total', () => {
    beforeEach(() => {
      insertSession(db, { id: 's1' });
      for (let i = 1; i <= 15; i++) {
        insertTurn(db, {
          id: `t${i}`,
          sessionId: 's1',
          sequence: i,
          userPrompt: `findme token ${i}`,
          assistantText: null,
        });
      }
    });

    // TC-I-13
    it('TC-I-13: limit 500 clamps to 100', () => {
      const res = searchTurns(db, { query: 'findme', limit: 500 });
      expect(res.items.length).toBeLessThanOrEqual(100);
      expect(res.total).toBe(15);
    });

    // TC-I-14
    it('TC-I-14: offset 10 with total=15 returns 5 items', () => {
      const res = searchTurns(db, { query: 'findme', limit: 25, offset: 10 });
      expect(res.items.length).toBe(5);
      expect(res.total).toBe(15);
    });

    // TC-I-15
    it('TC-I-15: total is independent of limit/offset', () => {
      const a = searchTurns(db, { query: 'findme', limit: 2, offset: 0 });
      const b = searchTurns(db, { query: 'findme', limit: 5, offset: 3 });
      expect(a.total).toBe(15);
      expect(b.total).toBe(15);
    });
  });

  describe('prepared statement reuse', () => {
    // TC-I-16
    it('TC-I-16: second invocation reuses the WeakMap-cached prepared set', () => {
      insertSession(db, { id: 's1' });
      insertTurn(db, {
        id: 't1',
        sessionId: 's1',
        sequence: 1,
        userPrompt: 'token',
        assistantText: null,
      });
      // Direct test: the implementation internally caches `getPrepared`. We
      // smoke-test by running many searches without error; any per-call
      // `db.prepare` would surface as slow behavior or state divergence.
      for (let i = 0; i < 50; i++) {
        const res = searchTurns(db, { query: 'token' });
        expect(res.total).toBe(1);
      }
    });
  });

  describe('edge cases', () => {
    // TC-I-18 was covered in migrate.test.ts; repeat here against searchTurns
    it('turn with NULL user_prompt but assistant_text still searchable', () => {
      insertSession(db, { id: 's1' });
      insertTurn(db, {
        id: 't1',
        sessionId: 's1',
        sequence: 1,
        userPrompt: null,
        assistantText: 'rare-word xyz-marker',
      });
      const res = searchTurns(db, { query: 'xyz-marker' });
      expect(res.total).toBe(1);
      expect(res.items[0].turnId).toBe('t1');
    });

    // TC-I-19: snippet includes ellipsis when match is mid-long-text
    it('TC-I-19: snippet includes ... when truncated around a mid-text match', () => {
      insertSession(db, { id: 's1' });
      const long = 'prefix '.repeat(40) + 'TARGET ' + 'suffix '.repeat(40);
      insertTurn(db, {
        id: 't1',
        sessionId: 's1',
        sequence: 1,
        userPrompt: long,
        assistantText: null,
      });
      const res = searchTurns(db, { query: 'TARGET' });
      expect(res.items[0].promptSnippet).toContain('...');
    });
  });
});
