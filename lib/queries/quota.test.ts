import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';
import {
  getUserSettings,
  upsertUserSettings,
  getQuotaUsage,
  getQuotaHeatmap,
} from '@/lib/queries/quota';

function freshDb(): DB {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

function seedSession(
  db: DB,
  id: string,
  startedAt: number
): void {
  db.prepare(
    `INSERT INTO sessions (
      id, slug, cwd, project, git_branch, cc_version,
      started_at, ended_at,
      total_input_tokens, total_output_tokens, total_cache_read_tokens, total_cache_creation_tokens,
      total_cost_usd, turn_count, tool_call_count,
      source_file, ingested_at
    ) VALUES (?, NULL, '/tmp/cwd', 'demo', 'main', '1.0.0', ?, ?, 0, 0, 0, 0, 0, 0, 0, ?, ?)`
  ).run(id, startedAt, startedAt + 60_000, `file-${id}.jsonl`, Date.now());
}

function seedTurn(
  db: DB,
  id: string,
  sessionId: string,
  timestamp: number,
  inputTokens: number,
  outputTokens: number,
  opts: Partial<{
    cacheReadTokens: number;
    cacheCreationTokens: number;
  }> = {}
): void {
  db.prepare(
    `INSERT INTO turns (
      id, session_id, parent_uuid, sequence, timestamp, model,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
      cost_usd, stop_reason, user_prompt, assistant_text, tool_uses_json
    ) VALUES (?, ?, NULL, 1, ?, 'claude-opus-4', ?, ?, ?, ?, 0.01, 'end_turn', NULL, NULL, '[]')`
  ).run(
    id,
    sessionId,
    timestamp,
    inputTokens,
    outputTokens,
    opts.cacheReadTokens ?? 0,
    opts.cacheCreationTokens ?? 0
  );
}

describe('quota queries', () => {
  let db: DB;

  beforeEach(() => {
    db = freshDb();
  });

  describe('getUserSettings / upsertUserSettings', () => {
    it('TC-I-04: returns all-null + updatedAt=null when no row exists', () => {
      const s = getUserSettings(db);
      expect(s).toEqual({
        quotaTokens5h: null,
        quotaTokens7d: null,
        quotaSessions5h: null,
        quotaSessions7d: null,
        updatedAt: null,
      });
    });

    it('TC-I-05: upsert then get returns exact values with updatedAt', () => {
      upsertUserSettings(
        db,
        {
          quotaTokens5h: 50_000,
          quotaTokens7d: 500_000,
          quotaSessions5h: null,
          quotaSessions7d: null,
          updatedAt: null,
        },
        123_456
      );
      const s = getUserSettings(db);
      expect(s).toEqual({
        quotaTokens5h: 50_000,
        quotaTokens7d: 500_000,
        quotaSessions5h: null,
        quotaSessions7d: null,
        updatedAt: 123_456,
      });
    });

    it('TC-I-06: second upsert overwrites, updatedAt updates, row count = 1', () => {
      upsertUserSettings(
        db,
        {
          quotaTokens5h: 10,
          quotaTokens7d: 20,
          quotaSessions5h: 30,
          quotaSessions7d: 40,
          updatedAt: null,
        },
        1000
      );
      upsertUserSettings(
        db,
        {
          quotaTokens5h: 99,
          quotaTokens7d: null,
          quotaSessions5h: null,
          quotaSessions7d: 77,
          updatedAt: null,
        },
        2000
      );
      const s = getUserSettings(db);
      expect(s).toEqual({
        quotaTokens5h: 99,
        quotaTokens7d: null,
        quotaSessions5h: null,
        quotaSessions7d: 77,
        updatedAt: 2000,
      });
      const count = db
        .prepare(`SELECT COUNT(*) AS c FROM user_settings`)
        .get() as { c: number };
      expect(count.c).toBe(1);
    });
  });

  describe('getQuotaUsage', () => {
    it('TC-I-07: sums turns in 5h and 7d windows; counts sessions correctly', () => {
      const now = Date.now();
      const h = 3_600_000;
      // 3 sessions started in last 5h.
      seedSession(db, 'sess-a', now - 1 * h);
      seedSession(db, 'sess-b', now - 2 * h);
      seedSession(db, 'sess-c', now - 3 * h);
      // 1 turn 2 days old.
      seedSession(db, 'sess-old', now - 2 * 24 * h);

      seedTurn(db, 't1', 'sess-a', now - 1 * h, 100, 50);
      seedTurn(db, 't2', 'sess-b', now - 2 * h, 200, 100);
      seedTurn(db, 't3', 'sess-c', now - 3 * h, 300, 150);
      seedTurn(db, 't4', 'sess-old', now - 2 * 24 * h, 1000, 500);

      const u = getQuotaUsage(db, now);
      expect(u.tokens5h).toBe(150 + 300 + 450);
      expect(u.tokens7d).toBe(150 + 300 + 450 + 1500);
      expect(u.sessions5h).toBe(3);
      expect(u.sessions7d).toBe(4);
    });

    it('TC-I-08: turn exactly at now - 5h is INCLUDED in tokens5h', () => {
      const now = Date.now();
      const boundary = now - 5 * 3_600_000;
      seedSession(db, 's1', boundary);
      seedTurn(db, 't1', 's1', boundary, 10, 20);

      const u = getQuotaUsage(db, now);
      expect(u.tokens5h).toBe(30);
      expect(u.sessions5h).toBe(1);
    });

    it('TC-I-09: turn at now - 5h - 1 is EXCLUDED from tokens5h', () => {
      const now = Date.now();
      const justBefore = now - 5 * 3_600_000 - 1;
      seedSession(db, 's1', justBefore);
      seedTurn(db, 't1', 's1', justBefore, 10, 20);

      const u = getQuotaUsage(db, now);
      expect(u.tokens5h).toBe(0);
      expect(u.sessions5h).toBe(0);
      expect(u.tokens7d).toBe(30);
      expect(u.sessions7d).toBe(1);
    });

    it('TC-I-10: cache tokens are excluded from the sum', () => {
      const now = Date.now();
      seedSession(db, 's1', now - 1000);
      seedTurn(db, 't1', 's1', now - 1000, 10, 20, {
        cacheReadTokens: 1000,
        cacheCreationTokens: 500,
      });
      const u = getQuotaUsage(db, now);
      expect(u.tokens5h).toBe(30);
      expect(u.tokens7d).toBe(30);
    });

    it('TC-I-11: session counts: 2 in 5h window, 5 in 7d window', () => {
      const now = Date.now();
      const h = 3_600_000;
      seedSession(db, 's5h-1', now - 1 * h);
      seedSession(db, 's5h-2', now - 2 * h);
      seedSession(db, 's7d-1', now - 24 * h);
      seedSession(db, 's7d-2', now - 2 * 24 * h);
      seedSession(db, 's7d-3', now - 3 * 24 * h);
      // Outside 7d window.
      seedSession(db, 's-old', now - 10 * 24 * h);

      const u = getQuotaUsage(db, now);
      expect(u.sessions5h).toBe(2);
      expect(u.sessions7d).toBe(5);
    });

    it('TC-I-12: empty DB returns all zero, never null', () => {
      const u = getQuotaUsage(db, Date.now());
      expect(u).toEqual({
        tokens5h: 0,
        tokens7d: 0,
        sessions5h: 0,
        sessions7d: 0,
      });
    });
  });

  describe('getQuotaHeatmap', () => {
    it('TC-I-15: returns cells for distinct (dow, hour) with correct token sums', () => {
      const now = Date.now();
      const h = 3_600_000;
      seedSession(db, 's1', now);

      // Spread 15 turns across distinct (dow, hour) cells by stepping 13h
      // apart (gcd(13, 168) = 1, so the first 168 iterations never repeat a
      // cell). 15 * 13h ≈ 8.1 days — safely inside the 28-day window.
      const inserted: Array<{ ts: number; tokens: number; id: string }> = [];
      const seen = new Set<string>();
      for (let i = 0; i < 15; i++) {
        const ts = now - i * 13 * h - 1000;
        const tokens = 10 + i;
        seedTurn(db, `t-${i}`, 's1', ts, tokens, 0);
        inserted.push({ ts, tokens, id: `t-${i}` });
        const d = new Date(ts);
        seen.add(`${d.getDay()}-${d.getHours()}`);
      }
      // Sanity: all 15 cells distinct in local time.
      expect(seen.size).toBe(15);

      const cells = getQuotaHeatmap(db, now);
      expect(cells.length).toBeGreaterThanOrEqual(15);

      // Each inserted turn's cell must exist with at least its token count.
      for (const { ts, tokens } of inserted) {
        const d = new Date(ts);
        const dow = d.getDay();
        const hour = d.getHours();
        const cell = cells.find((c) => c.dow === dow && c.hour === hour);
        expect(cell, `cell for dow=${dow} hour=${hour} missing`).toBeDefined();
        if (cell) {
          expect(cell.tokens).toBeGreaterThanOrEqual(tokens);
        }
      }
    });

    it('TC-I-16: empty DB returns empty array (not 168 zero cells)', () => {
      const cells = getQuotaHeatmap(db, Date.now());
      expect(cells).toEqual([]);
    });

    it('TC-I-17: dow/hour respect local timezone (matches JS Date local getters)', () => {
      const now = Date.now();
      // Pick a timestamp ~24h ago — comfortably inside the 28-day window.
      const ts = now - 24 * 3_600_000;
      seedSession(db, 's1', ts);
      seedTurn(db, 't1', 's1', ts, 42, 0);

      const cells = getQuotaHeatmap(db, now);
      const d = new Date(ts);
      const expectedDow = d.getDay();
      const expectedHour = d.getHours();
      const cell = cells.find(
        (c) => c.dow === expectedDow && c.hour === expectedHour
      );
      expect(cell).toBeDefined();
      expect(cell?.tokens).toBe(42);
      // And no ghost cell for the UTC-only interpretation (unless the system
      // is already in UTC, in which case local == UTC and there's nothing to
      // check).
      const utcDow = d.getUTCDay();
      const utcHour = d.getUTCHours();
      if (utcDow !== expectedDow || utcHour !== expectedHour) {
        const ghost = cells.find(
          (c) => c.dow === utcDow && c.hour === utcHour
        );
        // A ghost in the UTC cell would indicate we forgot 'localtime'.
        expect(ghost).toBeUndefined();
      }
    });

    it('TC-I-16b (edge): turn older than 28d is excluded', () => {
      const now = Date.now();
      const old = now - 29 * 24 * 3_600_000;
      seedSession(db, 's1', old);
      seedTurn(db, 't1', 's1', old, 100, 100);
      const cells = getQuotaHeatmap(db, now);
      expect(cells).toEqual([]);
    });
  });
});
