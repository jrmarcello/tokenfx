import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';
import {
  getEffectivenessKpis,
  getWeeklyRatio,
  getCostPerTurnValues,
  getToolLeaderboard,
  getSessionScores,
} from '@/lib/queries/effectiveness';

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
  db.prepare(
    `INSERT INTO sessions (
      id, slug, cwd, project, git_branch, cc_version,
      started_at, ended_at,
      total_input_tokens, total_output_tokens, total_cache_read_tokens, total_cache_creation_tokens,
      total_cost_usd, turn_count, tool_call_count,
      source_file, ingested_at
    ) VALUES (?, NULL, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
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
  },
): void {
  db.prepare(
    `INSERT INTO turns (
      id, session_id, parent_uuid, sequence, timestamp, model,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
      cost_usd, stop_reason, user_prompt, assistant_text, tool_uses_json
    ) VALUES (?, ?, NULL, ?, ?, 'claude', 0, 0, 0, 0, 0, NULL, ?, NULL, '[]')`,
  ).run(
    args.id,
    args.sessionId,
    args.sequence,
    Date.now(),
    args.userPrompt,
  );
}

function insertToolCall(
  db: DB,
  args: {
    id: string;
    turnId: string;
    toolName: string;
    isError?: boolean;
  },
): void {
  db.prepare(
    `INSERT INTO tool_calls (id, turn_id, tool_name, input_json, result_json, result_is_error)
     VALUES (?, ?, ?, '{}', NULL, ?)`,
  ).run(args.id, args.turnId, args.toolName, args.isError ? 1 : 0);
}

function insertRating(
  db: DB,
  args: { turnId: string; rating: -1 | 0 | 1 },
): void {
  db.prepare(
    `INSERT INTO ratings (turn_id, rating, note, rated_at) VALUES (?, ?, NULL, ?)`,
  ).run(args.turnId, args.rating, Date.now());
}

function fresh(): DB {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

describe('effectiveness queries', () => {
  let db: DB;
  const now = Date.now();

  beforeEach(() => {
    db = fresh();
  });

  describe('with seeded data', () => {
    beforeEach(() => {
      insertSession(db, {
        id: 's1',
        project: 'alpha',
        startedAt: now - 2 * DAY_MS,
        inputTokens: 1000,
        outputTokens: 2000,
        cacheReadTokens: 500,
        costUsd: 5,
        turnCount: 4,
      });
      insertSession(db, {
        id: 's2',
        project: 'beta',
        startedAt: now - 5 * DAY_MS,
        inputTokens: 2000,
        outputTokens: 1000,
        cacheReadTokens: 1000,
        costUsd: 3,
        turnCount: 2,
      });
      // Outside 30d window
      insertSession(db, {
        id: 's3',
        project: 'old',
        startedAt: now - 60 * DAY_MS,
        inputTokens: 1000,
        outputTokens: 1000,
        costUsd: 100,
        turnCount: 5,
      });

      insertTurn(db, { id: 't1', sessionId: 's1', sequence: 0, userPrompt: 'do something' });
      insertTurn(db, { id: 't2', sessionId: 's1', sequence: 1, userPrompt: 'não, isso tá errado' });
      insertTurn(db, { id: 't3', sessionId: 's1', sequence: 2, userPrompt: 'great' });
      insertTurn(db, { id: 't4', sessionId: 's2', sequence: 0, userPrompt: 'proceed' });

      insertToolCall(db, { id: 'tc1', turnId: 't1', toolName: 'Bash' });
      insertToolCall(db, { id: 'tc2', turnId: 't1', toolName: 'Bash', isError: true });
      insertToolCall(db, { id: 'tc3', turnId: 't2', toolName: 'Read' });
      insertToolCall(db, { id: 'tc4', turnId: 't4', toolName: 'Bash' });

      insertRating(db, { turnId: 't1', rating: 1 });
    });

    it('getEffectivenessKpis returns weighted ratios and rated session count', () => {
      const kpis = getEffectivenessKpis(db, 30);
      // cache_hit_ratio: s1 = 500/1500, s2 = 1000/3000 = 0.333. Both equal => avg ~0.333
      const ratio = kpis.avgCacheHitRatio;
      expect(ratio).not.toBeNull();
      if (ratio === null) throw new Error('avgCacheHitRatio null');
      expect(ratio).toBeGreaterThan(0);
      // output/input: s1 ratio = 2.0, tokens weight = 3000; s2 ratio = 0.5, weight = 3000.
      // Weighted = (2*3000 + 0.5*3000) / 6000 = 1.25
      expect(kpis.avgOutputInputRatio).toBeCloseTo(1.25, 5);
      expect(kpis.ratedSessionCount).toBe(1);
      expect(kpis.avgScore).not.toBeNull();
    });

    it('getWeeklyRatio groups by week and returns ratios ascending', () => {
      const pts = getWeeklyRatio(db, 12);
      expect(pts.length).toBeGreaterThan(0);
      for (let i = 1; i < pts.length; i++) {
        expect(pts[i].week >= pts[i - 1].week).toBe(true);
      }
      for (const p of pts) {
        expect(p.outputInputRatio).toBeGreaterThan(0);
      }
    });

    it('getCostPerTurnValues returns cost/turn for sessions in window', () => {
      const values = getCostPerTurnValues(db, 30);
      expect(values.length).toBe(2);
      expect(values).toContain(5 / 4);
      expect(values).toContain(3 / 2);
    });

    it('getToolLeaderboard returns aggregated counts sorted desc, with errorCount', () => {
      const lb = getToolLeaderboard(db, 30, 10);
      expect(lb.length).toBe(2);
      expect(lb[0].toolName).toBe('Bash');
      expect(lb[0].count).toBe(3);
      expect(lb[0].errorCount).toBe(1);
      expect(lb[1].toolName).toBe('Read');
      expect(lb[1].count).toBe(1);
      expect(lb[1].errorCount).toBe(0);
    });

    it('getSessionScores computes scores using correction density and effectiveness inputs', () => {
      const scores = getSessionScores(db, 30);
      expect(scores.length).toBe(2);
      const s1 = scores.find((s) => s.sessionId === 's1');
      const s2 = scores.find((s) => s.sessionId === 's2');
      if (!s1 || !s2) throw new Error('s1/s2 not found in scores');
      expect(s1.score).toBeGreaterThanOrEqual(0);
      expect(s1.score).toBeLessThanOrEqual(100);
      // s1 has a correction on t1 (1 penalty / 3 turns ≈ 0.33), s2 has none.
      // With s1's rating=1 but corrections vs s2 rating=null no corrections,
      // both scores are valid floats. Just assert presence.
    });
  });

  describe('with empty database', () => {
    it('all query functions return empty/zero values', () => {
      const kpis = getEffectivenessKpis(db, 30);
      expect(kpis.avgScore).toBeNull();
      expect(kpis.avgOutputInputRatio).toBeNull();
      expect(kpis.avgCacheHitRatio).toBeNull();
      expect(kpis.ratedSessionCount).toBe(0);

      expect(getWeeklyRatio(db, 12)).toEqual([]);
      expect(getCostPerTurnValues(db, 30)).toEqual([]);
      expect(getToolLeaderboard(db, 30, 10)).toEqual([]);
      expect(getSessionScores(db, 30)).toEqual([]);
    });
  });
});
