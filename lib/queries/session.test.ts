import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';
import {
  getSession,
  getSessionIdForTurn,
  getTurns,
  upsertRating,
  listSessions,
  listSessionsByDate,
} from '@/lib/queries/session';

function freshDb(): DB {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

function seedSession(
  db: DB,
  id: string,
  overrides: Partial<{
    project: string;
    startedAt: number;
    endedAt: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number;
    turnCount: number;
    toolCallCount: number;
  }> = {}
): void {
  db.prepare(
    `INSERT INTO sessions (
      id, slug, cwd, project, git_branch, cc_version,
      started_at, ended_at,
      total_input_tokens, total_output_tokens, total_cache_read_tokens, total_cache_creation_tokens,
      total_cost_usd, turn_count, tool_call_count,
      source_file, ingested_at
    ) VALUES (?, NULL, '/tmp/cwd', ?, 'main', '1.0.0', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    overrides.project ?? 'demo',
    overrides.startedAt ?? Date.now() - 60_000,
    overrides.endedAt ?? Date.now(),
    overrides.inputTokens ?? 1000,
    overrides.outputTokens ?? 500,
    overrides.cacheReadTokens ?? 2000,
    overrides.cacheCreationTokens ?? 100,
    overrides.costUsd ?? 1.5,
    overrides.turnCount ?? 3,
    overrides.toolCallCount ?? 2,
    `file-${id}.jsonl`,
    Date.now()
  );
}

function seedTurn(
  db: DB,
  id: string,
  sessionId: string,
  sequence: number,
  opts: Partial<{
    userPrompt: string | null;
    assistantText: string | null;
    timestamp: number;
  }> = {}
): void {
  db.prepare(
    `INSERT INTO turns (
      id, session_id, parent_uuid, sequence, timestamp, model,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
      cost_usd, stop_reason, user_prompt, assistant_text, tool_uses_json
    ) VALUES (?, ?, NULL, ?, ?, 'claude-opus-4', 100, 50, 200, 10, 0.01, 'end_turn', ?, ?, '[]')`
  ).run(
    id,
    sessionId,
    sequence,
    opts.timestamp ?? Date.now(),
    opts.userPrompt ?? null,
    opts.assistantText ?? null
  );
}

function seedToolCall(
  db: DB,
  id: string,
  turnId: string,
  toolName = 'Read',
  resultIsError = 0
): void {
  db.prepare(
    `INSERT INTO tool_calls (id, turn_id, tool_name, input_json, result_json, result_is_error)
     VALUES (?, ?, ?, '{"path":"/tmp"}', '{"content":"ok"}', ?)`
  ).run(id, turnId, toolName, resultIsError);
}

describe('session queries', () => {
  let db: DB;

  beforeEach(() => {
    db = freshDb();
  });

  describe('with seeded data', () => {
    beforeEach(() => {
      seedSession(db, 'sess-1', {
        inputTokens: 1000,
        cacheReadTokens: 3000,
        outputTokens: 500,
      });
      seedTurn(db, 'turn-1', 'sess-1', 1, {
        userPrompt: 'hello',
        assistantText: 'hi',
      });
      seedTurn(db, 'turn-2', 'sess-1', 2, {
        userPrompt: 'do x',
        assistantText: 'ok',
      });
      seedTurn(db, 'turn-3', 'sess-1', 3, {
        userPrompt: 'and y',
        assistantText: 'done',
      });
      seedToolCall(db, 'tc-1', 'turn-1', 'Read');
      seedToolCall(db, 'tc-2', 'turn-1', 'Grep');
      db.prepare(
        `INSERT INTO ratings (turn_id, rating, note, rated_at) VALUES ('turn-2', 1, 'nice', ?)`
      ).run(Date.now());
    });

    it('getSession returns detail with derived cache/output ratios + avg_rating', () => {
      const s = getSession(db, 'sess-1');
      expect(s).not.toBeNull();
      if (!s) return;
      expect(s.id).toBe('sess-1');
      expect(s.totalInputTokens).toBe(1000);
      expect(s.totalCacheReadTokens).toBe(3000);
      // cache_hit_ratio = cache_read / (input + cache_read + cache_creation)
      // = 3000 / (1000 + 3000 + 100) = 3000/4100
      expect(s.cacheHitRatio).toBeCloseTo(3000 / 4100, 8);
      expect(s.outputInputRatio).toBeCloseTo(500 / 1000, 8);
      expect(s.avgRating).toBeCloseTo(1, 8);
    });

    it('getSession returns null for missing id', () => {
      expect(getSession(db, 'nope')).toBeNull();
    });

    it('getTurns returns 3 turns with correct tool_calls and ratings', () => {
      const turns = getTurns(db, 'sess-1');
      expect(turns).toHaveLength(3);
      expect(turns[0].id).toBe('turn-1');
      expect(turns[0].toolCalls).toHaveLength(2);
      expect(turns[0].toolCalls[0].resultIsError).toBe(false);
      expect(turns[1].rating?.value).toBe(1);
      expect(turns[2].rating).toBeNull();
      expect(turns[1].toolCalls).toHaveLength(0);
    });

    it('upsertRating inserts, then updates keeping one row per turn', () => {
      upsertRating(db, 'turn-3', -1, 'bad');
      let row = db
        .prepare(`SELECT rating, note FROM ratings WHERE turn_id='turn-3'`)
        .get() as { rating: number; note: string | null } | undefined;
      expect(row?.rating).toBe(-1);
      expect(row?.note).toBe('bad');

      upsertRating(db, 'turn-3', 1, null);
      row = db
        .prepare(`SELECT rating, note FROM ratings WHERE turn_id='turn-3'`)
        .get() as { rating: number; note: string | null } | undefined;
      expect(row?.rating).toBe(1);
      expect(row?.note).toBeNull();

      const count = db
        .prepare(
          `SELECT COUNT(*) AS c FROM ratings WHERE turn_id='turn-3'`
        )
        .get() as { c: number };
      expect(count.c).toBe(1);
    });

    it('listSessions returns sessions sorted by startedAt DESC', () => {
      seedSession(db, 'sess-0', { startedAt: Date.now() - 10 * 86_400_000 });
      seedSession(db, 'sess-2', { startedAt: Date.now() + 1000 });
      const items = listSessions(db, 10);
      expect(items.map((x) => x.id)).toEqual(['sess-2', 'sess-1', 'sess-0']);
    });
  });

  describe('with empty database', () => {
    it('listSessions returns []', () => {
      expect(listSessions(db, 10)).toEqual([]);
    });

    it('getSession returns null', () => {
      expect(getSession(db, 'anything')).toBeNull();
    });

    it('getSessionIdForTurn returns null for an unknown turn', () => {
      expect(getSessionIdForTurn(db, 'nope')).toBeNull();
    });
  });

  describe('listSessionsByDate', () => {
    // TZ-safe: compute boundary ms via the same Date constructor the query uses.
    // `dayLastMs` is the exact last millisecond the query's [start, end) window
    // includes (end-1), so the boundary test matches the actual query contract.
    const dayStart = new Date(2026, 3, 18, 0, 0, 0, 0).getTime();
    const nextDayStart = new Date(2026, 3, 19, 0, 0, 0, 0).getTime();
    const dayLastMs = nextDayStart - 1;
    const prevDay = new Date(2026, 3, 17, 12, 0, 0, 0).getTime();

    it('TC-I-03: returns sessions for the given date sorted DESC, excludes other days', () => {
      seedSession(db, 'a', { startedAt: dayStart + 3_600_000 }); // 01:00
      seedSession(db, 'b', { startedAt: dayStart + 7_200_000 }); // 02:00
      seedSession(db, 'c', { startedAt: dayStart + 10_800_000 }); // 03:00
      seedSession(db, 'prev', { startedAt: prevDay });

      const items = listSessionsByDate(db, '2026-04-18');
      expect(items.map((x) => x.id)).toEqual(['c', 'b', 'a']);
    });

    it('TC-I-04: includes sessions at 00:00:00 local and 23:59:59 local same day', () => {
      seedSession(db, 'midnight', { startedAt: dayStart });
      seedSession(db, 'endofday', { startedAt: dayLastMs });

      const items = listSessionsByDate(db, '2026-04-18');
      const ids = items.map((x) => x.id).sort();
      expect(ids).toEqual(['endofday', 'midnight']);
    });

    it('TC-I-05: excludes session at 00:00:00 local of the next day', () => {
      seedSession(db, 'next', { startedAt: nextDayStart });

      const items = listSessionsByDate(db, '2026-04-18');
      expect(items).toEqual([]);
    });

    it('TC-I-06: returns [] when no sessions fall on the day', () => {
      seedSession(db, 'far', { startedAt: prevDay });
      expect(listSessionsByDate(db, '2026-04-18')).toEqual([]);
    });

    it('TC-I-07: returns [] for invalid date format like "2026-13-99" without throwing', () => {
      seedSession(db, 'a', { startedAt: dayStart + 3_600_000 });
      expect(() => listSessionsByDate(db, '2026-13-99')).not.toThrow();
      expect(listSessionsByDate(db, '2026-13-99')).toEqual([]);
    });

    it('TC-I-08: returns [] for empty string without throwing', () => {
      seedSession(db, 'a', { startedAt: dayStart + 3_600_000 });
      expect(() => listSessionsByDate(db, '')).not.toThrow();
      expect(listSessionsByDate(db, '')).toEqual([]);
    });
  });

  describe('getSessionIdForTurn', () => {
    it('resolves the session_id of an existing turn', () => {
      seedSession(db, 'sess-lookup');
      db.prepare(
        `INSERT INTO turns (
          id, session_id, parent_uuid, sequence, timestamp, model,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
          cost_usd, stop_reason, user_prompt, assistant_text, tool_uses_json
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, '[]')`,
      ).run('turn-xyz', 'sess-lookup', 0, 1, 'm', 0, 0, 0, 0, 0);
      expect(getSessionIdForTurn(db, 'turn-xyz')).toBe('sess-lookup');
    });

    it('returns null for a missing turn id', () => {
      expect(getSessionIdForTurn(db, 'ghost')).toBeNull();
    });
  });
});
