import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';
import {
  getOverviewKpis,
  getDailySpend,
  getTopSessions,
} from '@/lib/queries/overview';

const DAY_MS = 86_400_000;

type SeedSession = {
  id: string;
  project?: string;
  startedAt: number;
  endedAt?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  turnCount?: number;
};

function insertSession(db: DB, s: SeedSession): void {
  const stmt = db.prepare(
    `INSERT INTO sessions (
      id, slug, cwd, project, git_branch, cc_version,
      started_at, ended_at,
      total_input_tokens, total_output_tokens, total_cache_read_tokens, total_cache_creation_tokens,
      total_cost_usd, turn_count, tool_call_count,
      source_file, ingested_at
    ) VALUES (?, NULL, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
  );
  stmt.run(
    s.id,
    '/tmp/cwd',
    s.project ?? 'demo',
    s.startedAt,
    s.endedAt ?? s.startedAt + 60_000,
    s.inputTokens ?? 0,
    s.outputTokens ?? 0,
    s.cacheReadTokens ?? 0,
    s.cacheCreationTokens ?? 0,
    s.costUsd ?? 0,
    s.turnCount ?? 1,
    `file-${s.id}.jsonl`,
    Date.now()
  );
}

function freshDb(): DB {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

describe('overview queries', () => {
  let db: DB;
  const now = Date.now();

  beforeEach(() => {
    db = freshDb();
  });

  describe('with seeded sessions', () => {
    beforeEach(() => {
      // Session within last day
      insertSession(db, {
        id: 's1',
        project: 'alpha',
        startedAt: now - 2 * 60 * 60 * 1000, // 2 hours ago
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 2000,
        cacheCreationTokens: 100,
        costUsd: 1.5,
        turnCount: 10,
      });
      // Session within last 7d
      insertSession(db, {
        id: 's2',
        project: 'beta',
        startedAt: now - 3 * DAY_MS,
        inputTokens: 500,
        outputTokens: 300,
        cacheReadTokens: 1500,
        cacheCreationTokens: 50,
        costUsd: 2.25,
        turnCount: 4,
      });
      // Session within last 30d
      insertSession(db, {
        id: 's3',
        project: 'gamma',
        startedAt: now - 20 * DAY_MS,
        inputTokens: 800,
        outputTokens: 400,
        cacheReadTokens: 1000,
        cacheCreationTokens: 200,
        costUsd: 5.0,
        turnCount: 12,
      });
      // Session OUTSIDE 30d window
      insertSession(db, {
        id: 's4',
        project: 'omega',
        startedAt: now - 35 * DAY_MS,
        inputTokens: 10_000,
        outputTokens: 10_000,
        cacheReadTokens: 10_000,
        cacheCreationTokens: 10_000,
        costUsd: 100.0,
        turnCount: 50,
      });
    });

    it('getOverviewKpis: spend30d excludes sessions older than 30 days', () => {
      const kpis = getOverviewKpis(db);
      expect(kpis.spend30d).toBeCloseTo(1.5 + 2.25 + 5.0, 5);
      expect(kpis.sessionCount30d).toBe(3);
    });

    it('getOverviewKpis: tokens30d sums input+output+cacheRead+cacheCreation', () => {
      const kpis = getOverviewKpis(db);
      const expected =
        (1000 + 500 + 2000 + 100) +
        (500 + 300 + 1500 + 50) +
        (800 + 400 + 1000 + 200);
      expect(kpis.tokens30d).toBe(expected);
    });

    it('getOverviewKpis: cacheHitRatio30d computed from cacheRead / (input + cacheRead)', () => {
      const kpis = getOverviewKpis(db);
      const sumCache = 2000 + 1500 + 1000;
      const sumInput = 1000 + 500 + 800;
      const expected = sumCache / (sumInput + sumCache);
      expect(kpis.cacheHitRatio30d).toBeCloseTo(expected, 8);
      expect(kpis.cacheHitRatio30d).toBeGreaterThan(0);
      expect(kpis.cacheHitRatio30d).toBeLessThanOrEqual(1);
    });

    it('getOverviewKpis: spend7d is smaller than spend30d and spendToday <= spend7d', () => {
      const kpis = getOverviewKpis(db);
      expect(kpis.spend7d).toBeCloseTo(1.5 + 2.25, 5);
      expect(kpis.spendToday).toBeCloseTo(1.5, 5);
      expect(kpis.spendToday).toBeLessThanOrEqual(kpis.spend7d);
      expect(kpis.spend7d).toBeLessThanOrEqual(kpis.spend30d);
    });

    it('getTopSessions: returns at most `limit` rows sorted by total_cost_usd DESC', () => {
      const top = getTopSessions(db, 2, 30);
      expect(top.length).toBe(2);
      expect(top[0].id).toBe('s3'); // 5.0
      expect(top[1].id).toBe('s2'); // 2.25
      expect(top[0].totalCostUsd).toBeGreaterThanOrEqual(top[1].totalCostUsd);
    });

    it('getDailySpend: returns exactly `days` zero-filled entries in ascending date order', () => {
      const series = getDailySpend(db, 30);
      expect(series.length).toBe(30);
      for (let i = 1; i < series.length; i++) {
        expect(series[i].date >= series[i - 1].date).toBe(true);
      }
      const totalSpend = series.reduce((acc, pt) => acc + pt.spend, 0);
      expect(totalSpend).toBeCloseTo(1.5 + 2.25 + 5.0, 5);
    });

    // TC-I-01: REQ-8, happy — two sessions on same local day aggregate sessionCount + spend
    it('getDailySpend: TC-I-01 — same-day sessions aggregate sessionCount and sum spend', () => {
      const isolatedDb = freshDb();
      const start = new Date();
      start.setHours(9, 0, 0, 0);
      const at9am = start.getTime();
      const at3pm = at9am + 6 * 60 * 60 * 1000;
      insertSession(isolatedDb, {
        id: 'same-day-1',
        startedAt: at9am,
        costUsd: 1.25,
      });
      insertSession(isolatedDb, {
        id: 'same-day-2',
        startedAt: at3pm,
        costUsd: 2.75,
      });

      const series = getDailySpend(isolatedDb, 30);
      const y = start.getFullYear();
      const m = String(start.getMonth() + 1).padStart(2, '0');
      const d = String(start.getDate()).padStart(2, '0');
      const todayKey = `${y}-${m}-${d}`;
      const todayPoint = series.find((pt) => pt.date === todayKey);
      expect(todayPoint).toBeDefined();
      expect(todayPoint?.sessionCount).toBe(2);
      expect(todayPoint?.spend).toBeCloseTo(1.25 + 2.75, 5);
    });

    // TC-I-02: REQ-8, edge — zero-filled day has sessionCount: 0, spend: 0
    it('getDailySpend: TC-I-02 — days without sessions emit sessionCount:0, spend:0', () => {
      const series = getDailySpend(db, 30);
      // Find a day with no session (15 days ago — no seeded session on this day)
      const fifteenDaysAgo = new Date(now - 15 * DAY_MS);
      const y = fifteenDaysAgo.getFullYear();
      const m = String(fifteenDaysAgo.getMonth() + 1).padStart(2, '0');
      const d = String(fifteenDaysAgo.getDate()).padStart(2, '0');
      const key = `${y}-${m}-${d}`;
      const point = series.find((pt) => pt.date === key);
      expect(point).toBeDefined();
      expect(point?.sessionCount).toBe(0);
      expect(point?.spend).toBe(0);
    });
  });

  describe('with empty database', () => {
    it('getOverviewKpis returns all zeros', () => {
      const kpis = getOverviewKpis(db);
      expect(kpis.spend30d).toBe(0);
      expect(kpis.spendToday).toBe(0);
      expect(kpis.spend7d).toBe(0);
      expect(kpis.tokens30d).toBe(0);
      expect(kpis.cacheHitRatio30d).toBe(0);
      expect(kpis.sessionCount30d).toBe(0);
    });

    it('getTopSessions returns []', () => {
      expect(getTopSessions(db, 5, 30)).toEqual([]);
    });

    it('getDailySpend returns 30 zero entries', () => {
      const series = getDailySpend(db, 30);
      expect(series.length).toBe(30);
      for (const pt of series) {
        expect(pt.spend).toBe(0);
        expect(pt.tokens).toBe(0);
      }
    });
  });
});
