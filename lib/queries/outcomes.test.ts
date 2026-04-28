import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';
import {
  getSessionOutcome,
  getCostPerLoc,
  getCostPerCommit,
  getRevertRate,
  getHighCostNoOutputSessions,
} from '@/lib/queries/outcomes';

const DAY_MS = 86_400_000;

type SeedSession = {
  id: string;
  project?: string;
  startedAt: number;
  endedAt?: number;
  costUsd?: number;
  costUsdOtel?: number | null;
  turnCount?: number;
};

type SeedOutcome = {
  sessionId: string;
  commitCount?: number;
  locAdded?: number;
  locRemoved?: number;
  filesChanged?: number;
  revertsWithin7d?: number;
  mergedPrCount?: number | null;
  status?: 'evaluated' | 'cwd-missing' | 'not-a-git-repo' | 'no-user-email';
  lastEvaluatedAt?: number;
};

function insertSession(db: DB, s: SeedSession): void {
  db.prepare(
    `INSERT INTO sessions (
      id, slug, cwd, project, git_branch, cc_version,
      started_at, ended_at,
      total_input_tokens, total_output_tokens, total_cache_read_tokens, total_cache_creation_tokens,
      total_cost_usd, total_cost_usd_otel, turn_count, tool_call_count,
      source_file, ingested_at
    ) VALUES (?, NULL, ?, ?, NULL, NULL, ?, ?, 0, 0, 0, 0, ?, ?, ?, 0, ?, ?)`,
  ).run(
    s.id,
    '/tmp/cwd',
    s.project ?? 'demo',
    s.startedAt,
    s.endedAt ?? s.startedAt + 60_000,
    s.costUsd ?? 0,
    s.costUsdOtel ?? null,
    s.turnCount ?? 1,
    `file-${s.id}.jsonl`,
    Date.now(),
  );
}

function insertTurn(
  db: DB,
  args: { id: string; sessionId: string; sequence: number; model: string; costUsd: number },
): void {
  db.prepare(
    `INSERT INTO turns (
      id, session_id, parent_uuid, sequence, timestamp, model,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
      cost_usd, stop_reason, user_prompt, assistant_text, tool_uses_json
    ) VALUES (?, ?, NULL, ?, ?, ?, 0, 0, 0, 0, ?, NULL, NULL, NULL, '[]')`,
  ).run(
    args.id,
    args.sessionId,
    args.sequence,
    Date.now(),
    args.model,
    args.costUsd,
  );
}

function insertOutcome(db: DB, o: SeedOutcome): void {
  db.prepare(
    `INSERT INTO session_outcomes (
      session_id, commit_count, loc_added, loc_removed, files_changed,
      reverts_within_7d, merged_pr_count, status, last_evaluated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    o.sessionId,
    o.commitCount ?? 0,
    o.locAdded ?? 0,
    o.locRemoved ?? 0,
    o.filesChanged ?? 0,
    o.revertsWithin7d ?? 0,
    o.mergedPrCount === undefined ? null : o.mergedPrCount,
    o.status ?? 'evaluated',
    o.lastEvaluatedAt ?? Date.now(),
  );
}

function fresh(): DB {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

describe('outcomes queries', () => {
  let db: DB;
  const now = Date.now();

  beforeEach(() => {
    db = fresh();
  });

  describe('getSessionOutcome', () => {
    it('TC-I-13: returns null for unknown session id', () => {
      expect(getSessionOutcome(db, 'does-not-exist')).toBeNull();
    });

    it('TC-I-14: round-trips merged_pr_count = NULL (not 0)', () => {
      insertSession(db, { id: 's1', startedAt: now - DAY_MS });
      insertOutcome(db, {
        sessionId: 's1',
        commitCount: 2,
        locAdded: 50,
        mergedPrCount: null,
        status: 'evaluated',
      });
      const out = getSessionOutcome(db, 's1');
      expect(out).not.toBeNull();
      expect(out?.mergedPrCount).toBeNull();
      expect(out?.commitCount).toBe(2);
      expect(out?.locAdded).toBe(50);
      expect(out?.status).toBe('evaluated');
    });

    it('returns mapped fields when row exists with all fields populated', () => {
      insertSession(db, { id: 's2', startedAt: now - DAY_MS });
      insertOutcome(db, {
        sessionId: 's2',
        commitCount: 3,
        locAdded: 120,
        locRemoved: 15,
        filesChanged: 7,
        revertsWithin7d: 1,
        mergedPrCount: 2,
        status: 'evaluated',
        lastEvaluatedAt: 1234567890,
      });
      const out = getSessionOutcome(db, 's2');
      expect(out).toEqual({
        sessionId: 's2',
        commitCount: 3,
        locAdded: 120,
        locRemoved: 15,
        filesChanged: 7,
        revertsWithin7d: 1,
        mergedPrCount: 2,
        status: 'evaluated',
        lastEvaluatedAt: 1234567890,
      });
    });
  });

  describe('getCostPerLoc', () => {
    it('TC-I-08: 3 sessions in window — totalCost is effective cost via calibration', () => {
      // No OTEL, no calibration row → falls through to list price (rate = 1.0).
      // A: $10 list, 100 LOC; B: $5, 50 LOC; C: $20, 0 commits / 0 LOC.
      insertSession(db, { id: 'A', startedAt: now - DAY_MS, costUsd: 10 });
      insertSession(db, { id: 'B', startedAt: now - 2 * DAY_MS, costUsd: 5 });
      insertSession(db, { id: 'C', startedAt: now - 3 * DAY_MS, costUsd: 20 });
      insertTurn(db, { id: 'tA', sessionId: 'A', sequence: 0, model: 'claude-opus-4-7', costUsd: 10 });
      insertTurn(db, { id: 'tB', sessionId: 'B', sequence: 0, model: 'claude-opus-4-7', costUsd: 5 });
      insertTurn(db, { id: 'tC', sessionId: 'C', sequence: 0, model: 'claude-opus-4-7', costUsd: 20 });

      insertOutcome(db, { sessionId: 'A', commitCount: 1, locAdded: 100 });
      insertOutcome(db, { sessionId: 'B', commitCount: 1, locAdded: 50 });
      insertOutcome(db, { sessionId: 'C', commitCount: 0, locAdded: 0 });

      const result = getCostPerLoc(db, { days: 30 });
      expect(result.totalCost).toBeCloseTo(35, 5);
      expect(result.totalLoc).toBe(150);
      expect(result.ratio).toBeCloseTo(35 / 150, 5);
    });

    it('TC-I-09: zero sessions in window → ratio is null, no division by zero', () => {
      const result = getCostPerLoc(db, { days: 30 });
      expect(result.totalCost).toBe(0);
      expect(result.totalLoc).toBe(0);
      expect(result.ratio).toBeNull();
    });

    it('cost flows through effectiveCostForSession — OTEL preferred over local', () => {
      insertSession(db, {
        id: 'otel',
        startedAt: now - DAY_MS,
        costUsd: 100,
        costUsdOtel: 5,
      });
      insertTurn(db, { id: 't-otel', sessionId: 'otel', sequence: 0, model: 'claude-opus-4-7', costUsd: 100 });
      insertOutcome(db, { sessionId: 'otel', commitCount: 1, locAdded: 50 });

      const result = getCostPerLoc(db, { days: 30 });
      expect(result.totalCost).toBeCloseTo(5, 5); // OTEL wins, not 100
      expect(result.totalLoc).toBe(50);
      expect(result.ratio).toBeCloseTo(5 / 50, 5);
    });

    it('excludes sessions outside the window', () => {
      insertSession(db, { id: 'recent', startedAt: now - DAY_MS, costUsd: 10 });
      insertSession(db, { id: 'old', startedAt: now - 60 * DAY_MS, costUsd: 999 });
      insertTurn(db, { id: 'tr', sessionId: 'recent', sequence: 0, model: 'claude-opus-4-7', costUsd: 10 });
      insertTurn(db, { id: 'to', sessionId: 'old', sequence: 0, model: 'claude-opus-4-7', costUsd: 999 });

      insertOutcome(db, { sessionId: 'recent', commitCount: 1, locAdded: 20 });
      insertOutcome(db, { sessionId: 'old', commitCount: 1, locAdded: 999 });

      const result = getCostPerLoc(db, { days: 30 });
      expect(result.totalLoc).toBe(20);
      expect(result.totalCost).toBeCloseTo(10, 5);
    });
  });

  describe('getCostPerCommit', () => {
    it('aggregates effective cost and commit count over the window', () => {
      insertSession(db, { id: 'A', startedAt: now - DAY_MS, costUsd: 10 });
      insertSession(db, { id: 'B', startedAt: now - 2 * DAY_MS, costUsd: 5 });
      insertTurn(db, { id: 'tA', sessionId: 'A', sequence: 0, model: 'claude-opus-4-7', costUsd: 10 });
      insertTurn(db, { id: 'tB', sessionId: 'B', sequence: 0, model: 'claude-opus-4-7', costUsd: 5 });

      insertOutcome(db, { sessionId: 'A', commitCount: 3, locAdded: 100 });
      insertOutcome(db, { sessionId: 'B', commitCount: 2, locAdded: 50 });

      const result = getCostPerCommit(db, { days: 30 });
      expect(result.totalCost).toBeCloseTo(15, 5);
      expect(result.totalCommits).toBe(5);
      expect(result.ratio).toBeCloseTo(15 / 5, 5);
    });

    it('ratio is null when totalCommits is 0', () => {
      insertSession(db, { id: 'A', startedAt: now - DAY_MS, costUsd: 10 });
      insertTurn(db, { id: 'tA', sessionId: 'A', sequence: 0, model: 'claude-opus-4-7', costUsd: 10 });
      insertOutcome(db, { sessionId: 'A', commitCount: 0, locAdded: 0 });

      const result = getCostPerCommit(db, { days: 30 });
      expect(result.totalCommits).toBe(0);
      expect(result.ratio).toBeNull();
    });
  });

  describe('getRevertRate', () => {
    it('TC-I-10: 4 sessions, 2 with reverts > 0, 1 with commit_count = 0 → ratio 2/3', () => {
      // 3 sessions with commits (denominator), 2 of them with reverts (numerator)
      insertSession(db, { id: 'a', startedAt: now - DAY_MS });
      insertSession(db, { id: 'b', startedAt: now - 2 * DAY_MS });
      insertSession(db, { id: 'c', startedAt: now - 3 * DAY_MS });
      insertSession(db, { id: 'd', startedAt: now - 4 * DAY_MS });

      insertOutcome(db, { sessionId: 'a', commitCount: 1, revertsWithin7d: 1 });
      insertOutcome(db, { sessionId: 'b', commitCount: 2, revertsWithin7d: 3 });
      insertOutcome(db, { sessionId: 'c', commitCount: 5, revertsWithin7d: 0 });
      // d has no commits → excluded from denominator
      insertOutcome(db, { sessionId: 'd', commitCount: 0, revertsWithin7d: 0 });

      const result = getRevertRate(db, { days: 30 });
      expect(result.sessionsWithCommits).toBe(3);
      expect(result.sessionsWithReverts).toBe(2);
      expect(result.ratio).toBeCloseTo(2 / 3, 5);
    });

    it('TC-I-11: denominator is 0 → ratio is null', () => {
      insertSession(db, { id: 'a', startedAt: now - DAY_MS });
      insertOutcome(db, { sessionId: 'a', commitCount: 0, revertsWithin7d: 0 });

      const result = getRevertRate(db, { days: 30 });
      expect(result.sessionsWithCommits).toBe(0);
      expect(result.sessionsWithReverts).toBe(0);
      expect(result.ratio).toBeNull();
    });

    it('returns zeros and null ratio when no sessions exist', () => {
      const result = getRevertRate(db, { days: 30 });
      expect(result).toEqual({
        sessionsWithCommits: 0,
        sessionsWithReverts: 0,
        ratio: null,
      });
    });

    it('only counts sessions inside the window', () => {
      insertSession(db, { id: 'recent', startedAt: now - DAY_MS });
      insertSession(db, { id: 'old', startedAt: now - 60 * DAY_MS });
      insertOutcome(db, { sessionId: 'recent', commitCount: 1, revertsWithin7d: 1 });
      insertOutcome(db, { sessionId: 'old', commitCount: 1, revertsWithin7d: 1 });

      const result = getRevertRate(db, { days: 30 });
      expect(result.sessionsWithCommits).toBe(1);
      expect(result.sessionsWithReverts).toBe(1);
    });
  });

  describe('getHighCostNoOutputSessions', () => {
    it('TC-I-12: returns sessions with commit_count = 0 ordered by effective cost DESC, length <= limit', () => {
      // Three sessions with no commits at increasing list cost.
      insertSession(db, {
        id: 's-low',
        project: 'p1',
        startedAt: now - DAY_MS,
        costUsd: 5,
      });
      insertSession(db, {
        id: 's-high',
        project: 'p2',
        startedAt: now - 2 * DAY_MS,
        costUsd: 50,
      });
      insertSession(db, {
        id: 's-mid',
        project: 'p3',
        startedAt: now - 3 * DAY_MS,
        costUsd: 20,
      });
      // Session with commits — must be excluded
      insertSession(db, {
        id: 's-with-commits',
        project: 'p4',
        startedAt: now - DAY_MS,
        costUsd: 100,
      });

      insertTurn(db, { id: 't-low', sessionId: 's-low', sequence: 0, model: 'claude-opus-4-7', costUsd: 5 });
      insertTurn(db, { id: 't-high', sessionId: 's-high', sequence: 0, model: 'claude-opus-4-7', costUsd: 50 });
      insertTurn(db, { id: 't-mid', sessionId: 's-mid', sequence: 0, model: 'claude-opus-4-7', costUsd: 20 });
      insertTurn(db, { id: 't-wc', sessionId: 's-with-commits', sequence: 0, model: 'claude-opus-4-7', costUsd: 100 });

      insertOutcome(db, { sessionId: 's-low', commitCount: 0 });
      insertOutcome(db, { sessionId: 's-high', commitCount: 0 });
      insertOutcome(db, { sessionId: 's-mid', commitCount: 0 });
      insertOutcome(db, { sessionId: 's-with-commits', commitCount: 5 });

      const result = getHighCostNoOutputSessions(db, { days: 30, limit: 3 });
      expect(result).toHaveLength(3);
      expect(result.map((r) => r.sessionId)).toEqual(['s-high', 's-mid', 's-low']);
      // Excludes session with commits.
      expect(result.find((r) => r.sessionId === 's-with-commits')).toBeUndefined();
      expect(result[0].project).toBe('p2');
      expect(result[0].totalCostUsd).toBeCloseTo(50, 5);
      expect(result[0].commitCount).toBe(0);
    });

    it('honours limit (length <= limit)', () => {
      for (let i = 0; i < 5; i++) {
        insertSession(db, {
          id: `s${i}`,
          startedAt: now - DAY_MS,
          costUsd: i + 1,
        });
        insertTurn(db, {
          id: `t${i}`,
          sessionId: `s${i}`,
          sequence: 0,
          model: 'claude-opus-4-7',
          costUsd: i + 1,
        });
        insertOutcome(db, { sessionId: `s${i}`, commitCount: 0 });
      }
      const result = getHighCostNoOutputSessions(db, { days: 30, limit: 2 });
      expect(result).toHaveLength(2);
    });

    it('orders by effective cost (OTEL wins over list)', () => {
      // Session A: list=100, OTEL=null → effective 100
      // Session B: list=10, OTEL=200 → effective 200 (should rank first)
      insertSession(db, {
        id: 'A',
        project: 'pa',
        startedAt: now - DAY_MS,
        costUsd: 100,
      });
      insertSession(db, {
        id: 'B',
        project: 'pb',
        startedAt: now - 2 * DAY_MS,
        costUsd: 10,
        costUsdOtel: 200,
      });
      insertTurn(db, { id: 'tA', sessionId: 'A', sequence: 0, model: 'claude-opus-4-7', costUsd: 100 });
      insertTurn(db, { id: 'tB', sessionId: 'B', sequence: 0, model: 'claude-opus-4-7', costUsd: 10 });

      insertOutcome(db, { sessionId: 'A', commitCount: 0 });
      insertOutcome(db, { sessionId: 'B', commitCount: 0 });

      const result = getHighCostNoOutputSessions(db, { days: 30, limit: 5 });
      expect(result.map((r) => r.sessionId)).toEqual(['B', 'A']);
    });

    it('returns empty array when no eligible sessions', () => {
      const result = getHighCostNoOutputSessions(db, { days: 30, limit: 5 });
      expect(result).toEqual([]);
    });
  });
});
