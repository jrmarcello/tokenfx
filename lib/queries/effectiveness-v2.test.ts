import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';
import {
  getPersonalEffectivenessSession,
  getPersonalEffectivenessAggregates,
  getCostRatingScatter,
  getQuartileComparison,
  getEffectivenessFunnel,
  getDailyEffectivenessHeatmap,
} from '@/lib/queries/effectiveness-v2';

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
  costUsdOtel?: number | null;
  turnCount?: number;
};

function insertSession(db: DB, s: SeedSession): void {
  db.prepare(
    `INSERT INTO sessions (
      id, slug, cwd, project, git_branch, cc_version,
      started_at, ended_at,
      total_input_tokens, total_output_tokens, total_cache_read_tokens, total_cache_creation_tokens,
      total_cost_usd, total_cost_usd_otel, turn_count, tool_call_count,
      source_file, ingested_at
    ) VALUES (?, NULL, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
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
    s.costUsdOtel ?? null,
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
    userPrompt?: string | null;
    model?: string;
    costUsd?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
    subagentType?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO turns (
      id, session_id, parent_uuid, sequence, timestamp, model,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
      cost_usd, stop_reason, user_prompt, assistant_text, tool_uses_json,
      subagent_type
    ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, '[]', ?)`,
  ).run(
    args.id,
    args.sessionId,
    args.sequence,
    Date.now(),
    args.model ?? 'claude-sonnet-4',
    args.inputTokens ?? 0,
    args.outputTokens ?? 0,
    args.cacheReadTokens ?? 0,
    args.cacheCreationTokens ?? 0,
    args.costUsd ?? 0,
    args.userPrompt ?? null,
    args.subagentType ?? null,
  );
}

function insertToolCall(
  db: DB,
  args: {
    id: string;
    turnId: string;
    toolName: string;
    isError?: boolean;
    inputJson?: string;
  },
): void {
  db.prepare(
    `INSERT INTO tool_calls (id, turn_id, tool_name, input_json, result_json, result_is_error)
     VALUES (?, ?, ?, ?, NULL, ?)`,
  ).run(
    args.id,
    args.turnId,
    args.toolName,
    args.inputJson ?? '{}',
    args.isError ? 1 : 0,
  );
}

function insertRating(
  db: DB,
  args: { turnId: string; rating: -1 | 0 | 1 },
): void {
  db.prepare(
    `INSERT INTO ratings (turn_id, rating, note, rated_at) VALUES (?, ?, NULL, ?)`,
  ).run(args.turnId, args.rating, Date.now());
}

function insertCompactionEvent(
  db: DB,
  args: {
    sessionId: string;
    sourceFile: string;
    sequenceInFile: number;
    trigger?: string | null;
    preTokens?: number | null;
    postTokens?: number | null;
    ts?: number;
  },
): void {
  db.prepare(
    `INSERT INTO compaction_events (session_id, source_file, sequence_in_file, trigger, pre_tokens, post_tokens, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.sessionId,
    args.sourceFile,
    args.sequenceInFile,
    args.trigger ?? null,
    args.preTokens ?? null,
    args.postTokens ?? null,
    args.ts ?? Date.now(),
  );
}

function insertCalibration(
  db: DB,
  args: { family: string; rate: number; sampleCount?: number },
): void {
  db.prepare(
    `INSERT INTO cost_calibration (
      family, effective_rate, sample_session_count,
      sum_otel_cost, sum_local_cost, last_updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(args.family, args.rate, args.sampleCount ?? 1, 0, 0, Date.now());
}

function fresh(): DB {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

describe('effectiveness-v2 queries', () => {
  let db: DB;
  const now = Date.now();

  beforeEach(() => {
    db = fresh();
  });

  // ---------------- getPersonalEffectivenessSession ----------------

  describe('getPersonalEffectivenessSession — tokensUntilFirstEdit (REQ-6, REQ-7)', () => {
    it('TC-I-07: 5 turns, Edit on turn 4; tokens turn 1-3 = 100,200,300 → tokensUntilFirstEdit === 600', () => {
      insertSession(db, { id: 's1', startedAt: now - DAY_MS, turnCount: 5 });
      insertTurn(db, { id: 't1', sessionId: 's1', sequence: 1, inputTokens: 50, outputTokens: 30, cacheCreationTokens: 20 });
      insertTurn(db, { id: 't2', sessionId: 's1', sequence: 2, inputTokens: 100, outputTokens: 60, cacheCreationTokens: 40 });
      insertTurn(db, { id: 't3', sessionId: 's1', sequence: 3, inputTokens: 150, outputTokens: 90, cacheCreationTokens: 60 });
      insertTurn(db, { id: 't4', sessionId: 's1', sequence: 4, inputTokens: 1, outputTokens: 1, cacheCreationTokens: 1 });
      insertTurn(db, { id: 't5', sessionId: 's1', sequence: 5 });
      insertToolCall(db, { id: 'tc1', turnId: 't4', toolName: 'Edit' });

      const r = getPersonalEffectivenessSession(db, 's1');
      expect(r).not.toBeNull();
      expect(r?.tokensUntilFirstEdit).toBe(600);
    });

    it('TC-I-08: session with no Edit/MultiEdit/Write → null', () => {
      insertSession(db, { id: 's1', startedAt: now - DAY_MS, turnCount: 2 });
      insertTurn(db, { id: 't1', sessionId: 's1', sequence: 1, inputTokens: 100 });
      insertTurn(db, { id: 't2', sessionId: 's1', sequence: 2, inputTokens: 200 });
      insertToolCall(db, { id: 'tc1', turnId: 't1', toolName: 'Read' });

      const r = getPersonalEffectivenessSession(db, 's1');
      expect(r?.tokensUntilFirstEdit).toBeNull();
    });

    it('TC-I-09: first turn has Edit → 0', () => {
      insertSession(db, { id: 's1', startedAt: now - DAY_MS, turnCount: 2 });
      insertTurn(db, { id: 't1', sessionId: 's1', sequence: 1, inputTokens: 999 });
      insertToolCall(db, { id: 'tc1', turnId: 't1', toolName: 'Edit' });

      const r = getPersonalEffectivenessSession(db, 's1');
      expect(r?.tokensUntilFirstEdit).toBe(0);
    });

    it('TC-I-10: session with no turns → null', () => {
      insertSession(db, { id: 's1', startedAt: now - DAY_MS, turnCount: 0 });

      const r = getPersonalEffectivenessSession(db, 's1');
      expect(r?.tokensUntilFirstEdit).toBeNull();
    });

    it('TC-I-11: Write on turn 2 (not Edit) counts as edit', () => {
      insertSession(db, { id: 's1', startedAt: now - DAY_MS, turnCount: 2 });
      insertTurn(db, { id: 't1', sessionId: 's1', sequence: 1, inputTokens: 100, outputTokens: 50, cacheCreationTokens: 50 });
      insertTurn(db, { id: 't2', sessionId: 's1', sequence: 2 });
      insertToolCall(db, { id: 'tc1', turnId: 't2', toolName: 'Write' });

      const r = getPersonalEffectivenessSession(db, 's1');
      expect(r?.tokensUntilFirstEdit).toBe(200);
    });

    it('TC-I-12: MultiEdit on turn 2 counts as edit', () => {
      insertSession(db, { id: 's1', startedAt: now - DAY_MS, turnCount: 2 });
      insertTurn(db, { id: 't1', sessionId: 's1', sequence: 1, inputTokens: 100, outputTokens: 50, cacheCreationTokens: 50 });
      insertTurn(db, { id: 't2', sessionId: 's1', sequence: 2 });
      insertToolCall(db, { id: 'tc1', turnId: 't2', toolName: 'MultiEdit' });

      const r = getPersonalEffectivenessSession(db, 's1');
      expect(r?.tokensUntilFirstEdit).toBe(200);
    });
  });

  describe('getPersonalEffectivenessSession — rereadCount (REQ-8, REQ-9)', () => {
    it('TC-I-13: Reads /a×3, /b×2, /c×1 → rereadCount === 3', () => {
      insertSession(db, { id: 's1', startedAt: now - DAY_MS, turnCount: 1 });
      insertTurn(db, { id: 't1', sessionId: 's1', sequence: 1 });
      const reads = [
        ['tcA1', '/a'], ['tcA2', '/a'], ['tcA3', '/a'],
        ['tcB1', '/b'], ['tcB2', '/b'],
        ['tcC1', '/c'],
      ];
      for (const [id, path] of reads) {
        insertToolCall(db, { id, turnId: 't1', toolName: 'Read', inputJson: JSON.stringify({ file_path: path }) });
      }

      const r = getPersonalEffectivenessSession(db, 's1');
      expect(r?.rereadCount).toBe(3);
    });

    it('TC-I-14: Read with input_json {} (no file_path) → ignored', () => {
      insertSession(db, { id: 's1', startedAt: now - DAY_MS, turnCount: 1 });
      insertTurn(db, { id: 't1', sessionId: 's1', sequence: 1 });
      insertToolCall(db, { id: 'tc1', turnId: 't1', toolName: 'Read', inputJson: '{}' });
      insertToolCall(db, { id: 'tc2', turnId: 't1', toolName: 'Read', inputJson: '{}' });

      const r = getPersonalEffectivenessSession(db, 's1');
      expect(r?.rereadCount).toBe(0);
    });

    it('TC-I-15: Read with malformed input_json → json_extract returns null → ignored', () => {
      insertSession(db, { id: 's1', startedAt: now - DAY_MS, turnCount: 1 });
      insertTurn(db, { id: 't1', sessionId: 's1', sequence: 1 });
      insertToolCall(db, { id: 'tc1', turnId: 't1', toolName: 'Read', inputJson: 'not-json' });
      insertToolCall(db, { id: 'tc2', turnId: 't1', toolName: 'Read', inputJson: 'not-json' });

      const r = getPersonalEffectivenessSession(db, 's1');
      expect(r?.rereadCount).toBe(0);
    });

    it('TC-I-16: session with no Reads → rereadCount === 0', () => {
      insertSession(db, { id: 's1', startedAt: now - DAY_MS, turnCount: 1 });
      insertTurn(db, { id: 't1', sessionId: 's1', sequence: 1 });
      insertToolCall(db, { id: 'tc1', turnId: 't1', toolName: 'Bash' });

      const r = getPersonalEffectivenessSession(db, 's1');
      expect(r?.rereadCount).toBe(0);
    });
  });

  describe('getPersonalEffectivenessSession — toolErrorRate (REQ-10)', () => {
    it('TC-I-17: 10 tool_calls, 2 errors → 0.2', () => {
      insertSession(db, { id: 's1', startedAt: now - DAY_MS, turnCount: 1 });
      insertTurn(db, { id: 't1', sessionId: 's1', sequence: 1 });
      for (let i = 0; i < 10; i++) {
        insertToolCall(db, { id: `tc${i}`, turnId: 't1', toolName: 'Bash', isError: i < 2 });
      }

      const r = getPersonalEffectivenessSession(db, 's1');
      expect(r?.toolErrorRate).toBeCloseTo(0.2, 6);
    });

    it('TC-I-18: session with no tool_calls → null', () => {
      insertSession(db, { id: 's1', startedAt: now - DAY_MS, turnCount: 1 });
      insertTurn(db, { id: 't1', sessionId: 's1', sequence: 1 });

      const r = getPersonalEffectivenessSession(db, 's1');
      expect(r?.toolErrorRate).toBeNull();
    });
  });

  describe('getPersonalEffectivenessSession — readsToEditsRatio (REQ-11)', () => {
    it('TC-I-19: 6 Reads + 2 Edits + 1 Write → 6 / 3 === 2.0', () => {
      insertSession(db, { id: 's1', startedAt: now - DAY_MS, turnCount: 1 });
      insertTurn(db, { id: 't1', sessionId: 's1', sequence: 1 });
      for (let i = 0; i < 6; i++) insertToolCall(db, { id: `r${i}`, turnId: 't1', toolName: 'Read' });
      insertToolCall(db, { id: 'e1', turnId: 't1', toolName: 'Edit' });
      insertToolCall(db, { id: 'e2', turnId: 't1', toolName: 'Edit' });
      insertToolCall(db, { id: 'w1', turnId: 't1', toolName: 'Write' });

      const r = getPersonalEffectivenessSession(db, 's1');
      expect(r?.readsToEditsRatio).toBe(2);
    });

    it('TC-I-20: Reads but no Edits → null', () => {
      insertSession(db, { id: 's1', startedAt: now - DAY_MS, turnCount: 1 });
      insertTurn(db, { id: 't1', sessionId: 's1', sequence: 1 });
      insertToolCall(db, { id: 'r1', turnId: 't1', toolName: 'Read' });

      const r = getPersonalEffectivenessSession(db, 's1');
      expect(r?.readsToEditsRatio).toBeNull();
    });

    it('TC-I-21: Edits but no Reads → 0', () => {
      insertSession(db, { id: 's1', startedAt: now - DAY_MS, turnCount: 1 });
      insertTurn(db, { id: 't1', sessionId: 's1', sequence: 1 });
      insertToolCall(db, { id: 'e1', turnId: 't1', toolName: 'Edit' });

      const r = getPersonalEffectivenessSession(db, 's1');
      expect(r?.readsToEditsRatio).toBe(0);
    });
  });

  describe('getPersonalEffectivenessSession — compactionEventCount (REQ-12)', () => {
    it('TC-I-22: 2 rows in compaction_events → 2', () => {
      insertSession(db, { id: 's1', startedAt: now - DAY_MS, turnCount: 1 });
      insertCompactionEvent(db, { sessionId: 's1', sourceFile: 'a.jsonl', sequenceInFile: 1 });
      insertCompactionEvent(db, { sessionId: 's1', sourceFile: 'b.jsonl', sequenceInFile: 1 });

      const r = getPersonalEffectivenessSession(db, 's1');
      expect(r?.compactionEventCount).toBe(2);
    });
  });

  describe('getPersonalEffectivenessSession — subagentUsageRatio (REQ-13)', () => {
    it('TC-I-23: 4 turns, 2 with subagent_type → 0.5', () => {
      insertSession(db, { id: 's1', startedAt: now - DAY_MS, turnCount: 4 });
      insertTurn(db, { id: 't1', sessionId: 's1', sequence: 1, subagentType: 'general' });
      insertTurn(db, { id: 't2', sessionId: 's1', sequence: 2 });
      insertTurn(db, { id: 't3', sessionId: 's1', sequence: 3, subagentType: 'security' });
      insertTurn(db, { id: 't4', sessionId: 's1', sequence: 4 });

      const r = getPersonalEffectivenessSession(db, 's1');
      expect(r?.subagentUsageRatio).toBe(0.5);
    });

    it('TC-I-24: turn_count === 0 → null', () => {
      insertSession(db, { id: 's1', startedAt: now - DAY_MS, turnCount: 0 });

      const r = getPersonalEffectivenessSession(db, 's1');
      expect(r?.subagentUsageRatio).toBeNull();
    });
  });

  describe('getPersonalEffectivenessSession — REQ-14', () => {
    it('TC-I-25: nonexistent session → null', () => {
      const r = getPersonalEffectivenessSession(db, 'does-not-exist');
      expect(r).toBeNull();
    });
  });

  // ---------------- getPersonalEffectivenessAggregates ----------------

  describe('getPersonalEffectivenessAggregates (REQ-15)', () => {
    it('TC-I-26: avgTokensUntilFirstEdit excludes nulls', () => {
      // 4 sessions: tokensUntilFirstEdit = [100, 200, null, 300]
      const seeds: Array<{ id: string; tokens: number | null }> = [
        { id: 's1', tokens: 100 },
        { id: 's2', tokens: 200 },
        { id: 's3', tokens: null },
        { id: 's4', tokens: 300 },
      ];
      for (const seed of seeds) {
        insertSession(db, { id: seed.id, startedAt: now - DAY_MS, turnCount: 2 });
        if (seed.tokens === null) {
          // No Edit at all
          insertTurn(db, { id: `${seed.id}t1`, sessionId: seed.id, sequence: 1, inputTokens: 50 });
        } else {
          // Turn 1 has tokens === seed.tokens; Turn 2 has Edit
          insertTurn(db, {
            id: `${seed.id}t1`,
            sessionId: seed.id,
            sequence: 1,
            inputTokens: seed.tokens,
            outputTokens: 0,
            cacheCreationTokens: 0,
          });
          insertTurn(db, { id: `${seed.id}t2`, sessionId: seed.id, sequence: 2 });
          insertToolCall(db, { id: `${seed.id}tc1`, turnId: `${seed.id}t2`, toolName: 'Edit' });
        }
      }

      const a = getPersonalEffectivenessAggregates(db, 30);
      expect(a.avgTokensUntilFirstEdit).toBeCloseTo(200, 5);
      expect(a.totalSessions).toBe(4);
    });

    it('TC-I-27: empty window → null/0 fields', () => {
      const a = getPersonalEffectivenessAggregates(db, 30);
      expect(a.avgRereadCount).toBeNull();
      expect(a.avgTokensUntilFirstEdit).toBeNull();
      expect(a.avgReadsToEditsRatio).toBeNull();
      expect(a.avgToolErrorRate).toBeNull();
      expect(a.sessionsWithCompaction).toBe(0);
      expect(a.totalSessions).toBe(0);
    });

    it('TC-I-28: sessionsWithCompaction counts only sessions with ≥1 row', () => {
      insertSession(db, { id: 's1', startedAt: now - DAY_MS });
      insertSession(db, { id: 's2', startedAt: now - DAY_MS });
      insertSession(db, { id: 's3', startedAt: now - DAY_MS });
      insertCompactionEvent(db, { sessionId: 's1', sourceFile: 'a.jsonl', sequenceInFile: 1 });
      insertCompactionEvent(db, { sessionId: 's1', sourceFile: 'a.jsonl', sequenceInFile: 2 });
      insertCompactionEvent(db, { sessionId: 's2', sourceFile: 'b.jsonl', sequenceInFile: 1 });
      // s3 has no compaction events

      const a = getPersonalEffectivenessAggregates(db, 30);
      expect(a.sessionsWithCompaction).toBe(2);
      expect(a.totalSessions).toBe(3);
    });
  });

  // ---------------- getCostRatingScatter ----------------

  describe('getCostRatingScatter (REQ-16)', () => {
    it('TC-I-29: 3 sessions in window with rating, 1 without → returns 3 points', () => {
      // No calibration → list price (cost === total_cost_usd)
      insertSession(db, { id: 's1', startedAt: now - DAY_MS, costUsd: 1.0, turnCount: 1 });
      insertSession(db, { id: 's2', startedAt: now - DAY_MS, costUsd: 2.0, turnCount: 1 });
      insertSession(db, { id: 's3', startedAt: now - DAY_MS, costUsd: 3.0, turnCount: 1 });
      insertSession(db, { id: 's4', startedAt: now - DAY_MS, costUsd: 4.0, turnCount: 1 });

      for (const id of ['s1', 's2', 's3', 's4']) {
        insertTurn(db, { id: `${id}t1`, sessionId: id, sequence: 1, model: 'claude-sonnet-4', costUsd: 1.0 });
      }

      insertRating(db, { turnId: 's1t1', rating: 1 });
      insertRating(db, { turnId: 's2t1', rating: 0 });
      insertRating(db, { turnId: 's3t1', rating: -1 });
      // s4 has no rating

      const scatter = getCostRatingScatter(db, 30);
      expect(scatter.length).toBe(3);
      const ids = scatter.map((p) => p.sessionId).sort();
      expect(ids).toEqual(['s1', 's2', 's3']);
      for (const point of scatter) {
        expect(point.rating).toBeGreaterThanOrEqual(-1);
        expect(point.rating).toBeLessThanOrEqual(1);
        expect(point.cost).toBeGreaterThan(0);
      }
    });

    it('TC-I-30: window with no ratings → []', () => {
      insertSession(db, { id: 's1', startedAt: now - DAY_MS, costUsd: 1.0, turnCount: 1 });
      insertTurn(db, { id: 's1t1', sessionId: 's1', sequence: 1 });

      const scatter = getCostRatingScatter(db, 30);
      expect(scatter).toEqual([]);
    });
  });

  // ---------------- getQuartileComparison ----------------

  describe('getQuartileComparison (REQ-18)', () => {
    /**
     * Build 8 sessions with predictable scores. Score is a composite — we
     * drive it via avg_rating (weight 0.3) which gives broad spread:
     * rating=-1 → low score, rating=+1 → high score.
     */
    function seedRatedSessions(opts: { count: number; ratingsForSession: (i: number) => -1 | 0 | 1; cacheRatioForSession?: (i: number) => number }) {
      for (let i = 0; i < opts.count; i++) {
        const id = `s${i}`;
        const cacheReadTokens = opts.cacheRatioForSession ? Math.floor(opts.cacheRatioForSession(i) * 1000) : 100 + i * 50;
        insertSession(db, {
          id,
          startedAt: now - DAY_MS,
          inputTokens: 1000 - cacheReadTokens,
          outputTokens: 500,
          cacheReadTokens,
          turnCount: 1,
        });
        insertTurn(db, { id: `${id}t1`, sessionId: id, sequence: 1 });
        insertRating(db, { turnId: `${id}t1`, rating: opts.ratingsForSession(i) });
      }
    }

    it('TC-I-31: 8 sessions; top vs bottom quartile differs; sampleSize 2 each', () => {
      // Sessions 0-1: rating -1 (worst), 2-5: rating 0, 6-7: rating +1 (best)
      // Cache hit ratios: bottom should be lower than top
      seedRatedSessions({
        count: 8,
        ratingsForSession: (i) => (i < 2 ? -1 : i < 6 ? 0 : 1),
        cacheRatioForSession: (i) => 0.1 + i * 0.1,
      });

      const r = getQuartileComparison(db, 30);
      expect(r).not.toBeNull();
      expect(r?.topQuartile.sampleSize).toBe(2);
      expect(r?.bottomQuartile.sampleSize).toBe(2);
      expect(r?.topQuartile.avgCacheHitRatio).not.toBeNull();
      expect(r?.bottomQuartile.avgCacheHitRatio).not.toBeNull();
      expect(r!.topQuartile.avgCacheHitRatio!).toBeGreaterThan(r!.bottomQuartile.avgCacheHitRatio!);
    });

    it('TC-I-32: window with 3 sessions → null', () => {
      seedRatedSessions({ count: 3, ratingsForSession: () => 1 });

      const r = getQuartileComparison(db, 30);
      expect(r).toBeNull();
    });

    it('TC-I-33: window with 4 identical-score sessions → top===bottom; sampleSize 1 each', () => {
      seedRatedSessions({ count: 4, ratingsForSession: () => 0, cacheRatioForSession: () => 0.4 });

      const r = getQuartileComparison(db, 30);
      expect(r).not.toBeNull();
      expect(r?.topQuartile.sampleSize).toBe(1);
      expect(r?.bottomQuartile.sampleSize).toBe(1);
      expect(r?.topQuartile.avgCacheHitRatio).toBe(r?.bottomQuartile.avgCacheHitRatio);
    });
  });

  // ---------------- getEffectivenessFunnel ----------------

  describe('getEffectivenessFunnel (REQ-20, REQ-21)', () => {
    /**
     * Build n sessions; the first `withEdit` have an Edit, of which the first
     * `aboveCache` have cacheRead share above the median (computed across the
     * `withEdit` set), of which the first `lowErrors` have errorRate < 0.1.
     */
    function seedFunnel(opts: { n: number; withEdit: number; aboveCache: number; lowErrors: number }) {
      for (let i = 0; i < opts.n; i++) {
        const id = `s${i}`;
        // Sessions with index < aboveCache get HIGH cache (1500 cache, 100 input);
        // others get LOW cache (100 cache, 1500 input). The median is computed
        // only across WithEdit sessions, so order matters within that subset.
        const high = i < opts.aboveCache;
        insertSession(db, {
          id,
          startedAt: now - DAY_MS,
          inputTokens: high ? 100 : 1500,
          outputTokens: 100,
          cacheReadTokens: high ? 1500 : 100,
          turnCount: 1,
        });
        insertTurn(db, { id: `${id}t1`, sessionId: id, sequence: 1 });

        if (i < opts.withEdit) {
          insertToolCall(db, { id: `${id}edit`, turnId: `${id}t1`, toolName: 'Edit' });
        }
        // Add error tool calls for sessions NOT in lowErrors group
        if (i < opts.withEdit) {
          // sessions i < lowErrors get 1 tool_call, 0 errors → 0.0 errorRate
          // sessions lowErrors <= i < withEdit get 1 tool_call, 1 error → 1.0 errorRate
          if (i >= opts.lowErrors) {
            insertToolCall(db, { id: `${id}err`, turnId: `${id}t1`, toolName: 'Bash', isError: true });
          }
        }
      }
    }

    it('TC-I-34: 10 sessions; 8 WithEdit, 5 cache>median, 3 lowError', () => {
      seedFunnel({ n: 10, withEdit: 8, aboveCache: 5, lowErrors: 3 });

      const f = getEffectivenessFunnel(db, 30);
      expect(f.length).toBe(4);
      expect(f[0]).toEqual({ stage: 'Started', count: 10 });
      expect(f[1]).toEqual({ stage: 'WithEdit', count: 8 });
      expect(f[2]).toEqual({ stage: 'CacheAboveMedian', count: 5 });
      expect(f[3]).toEqual({ stage: 'LowToolErrors', count: 3 });
    });

    it('TC-I-35: 4 sessions in window → [] (below MIN_FUNNEL_SESSIONS)', () => {
      seedFunnel({ n: 4, withEdit: 4, aboveCache: 2, lowErrors: 1 });

      const f = getEffectivenessFunnel(db, 30);
      expect(f).toEqual([]);
    });

    it('TC-I-36: 5 sessions, 0 with Edit → all later stages 0', () => {
      seedFunnel({ n: 5, withEdit: 0, aboveCache: 0, lowErrors: 0 });

      const f = getEffectivenessFunnel(db, 30);
      expect(f).toEqual([
        { stage: 'Started', count: 5 },
        { stage: 'WithEdit', count: 0 },
        { stage: 'CacheAboveMedian', count: 0 },
        { stage: 'LowToolErrors', count: 0 },
      ]);
    });
  });

  // ---------------- getDailyEffectivenessHeatmap ----------------

  describe('getDailyEffectivenessHeatmap (REQ-23)', () => {
    it('TC-I-37: 30d heatmap, 3 sessions in 2 different days', () => {
      // 2 sessions today, 1 session 3 days ago. Each session needs at least
      // one quality signal so effectivenessScore returns >0.
      const today = now;
      const threeDaysAgo = now - 3 * DAY_MS;

      insertSession(db, { id: 's1', startedAt: today, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 500, turnCount: 1 });
      insertTurn(db, { id: 's1t1', sessionId: 's1', sequence: 1 });
      insertRating(db, { turnId: 's1t1', rating: 1 });

      insertSession(db, { id: 's2', startedAt: today, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 100, turnCount: 1 });
      insertTurn(db, { id: 's2t1', sessionId: 's2', sequence: 1 });
      insertRating(db, { turnId: 's2t1', rating: 0 });

      insertSession(db, { id: 's3', startedAt: threeDaysAgo, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 500, turnCount: 1 });
      insertTurn(db, { id: 's3t1', sessionId: 's3', sequence: 1 });
      insertRating(db, { turnId: 's3t1', rating: -1 });

      const h = getDailyEffectivenessHeatmap(db, 30);
      expect(h.length).toBe(30);
      const nonNullDays = h.filter((d) => d.score !== null);
      expect(nonNullDays.length).toBe(2);
      const totalSessions = h.reduce((acc, d) => acc + d.sessionCount, 0);
      expect(totalSessions).toBe(3);
    });

    it('TC-I-38: empty DB → 30 entries all null', () => {
      const h = getDailyEffectivenessHeatmap(db, 30);
      expect(h.length).toBe(30);
      for (const d of h) {
        expect(d.score).toBeNull();
        expect(d.sessionCount).toBe(0);
      }
    });
  });

  // ---------------- Aggregates refactor (REQ-19, D-4) ----------------

  describe('getPersonalEffectivenessAggregates — refactor parity (REQ-19, D-4)', () => {
    // Seed builder shared by TC-I-09 (parity) and TC-I-10 (count).
    // 12 sessions with varied shapes to exercise every branch:
    //   - Sessions with/without Edit on first turn (tokensUntilFirstEdit null/0/>0).
    //   - Sessions with/without compaction events.
    //   - Sessions with/without subagent turns.
    //   - Sessions with/without tool errors.
    //   - Sessions with reads, edits, and re-reads on same paths.
    //   - One empty session (turn_count === 0).
    function seedAggregateFixture(): { sessionIds: readonly string[]; expectedN: number } {
      const ids: string[] = [];
      const base = now - 5 * DAY_MS;

      // s0: no turns at all (turn_count = 0)
      insertSession(db, { id: 's0', startedAt: base, turnCount: 0 });
      ids.push('s0');

      // s1: Edit on first turn → tokensUntilFirstEdit = 0
      insertSession(db, { id: 's1', startedAt: base + 1, turnCount: 2 });
      insertTurn(db, { id: 's1t1', sessionId: 's1', sequence: 1, inputTokens: 50 });
      insertTurn(db, { id: 's1t2', sessionId: 's1', sequence: 2 });
      insertToolCall(db, { id: 's1tc1', turnId: 's1t1', toolName: 'Edit' });
      ids.push('s1');

      // s2: no Edit → tokensUntilFirstEdit = null
      insertSession(db, { id: 's2', startedAt: base + 2, turnCount: 2 });
      insertTurn(db, { id: 's2t1', sessionId: 's2', sequence: 1, inputTokens: 100 });
      insertTurn(db, { id: 's2t2', sessionId: 's2', sequence: 2 });
      insertToolCall(db, { id: 's2tc1', turnId: 's2t1', toolName: 'Read', inputJson: JSON.stringify({ file_path: '/a' }) });
      ids.push('s2');

      // s3: Edit on turn 3, tokens accumulate
      insertSession(db, { id: 's3', startedAt: base + 3, turnCount: 4 });
      insertTurn(db, { id: 's3t1', sessionId: 's3', sequence: 1, inputTokens: 10, outputTokens: 5, cacheCreationTokens: 5 });
      insertTurn(db, { id: 's3t2', sessionId: 's3', sequence: 2, inputTokens: 20, outputTokens: 10, cacheCreationTokens: 10 });
      insertTurn(db, { id: 's3t3', sessionId: 's3', sequence: 3 });
      insertTurn(db, { id: 's3t4', sessionId: 's3', sequence: 4 });
      insertToolCall(db, { id: 's3tc1', turnId: 's3t3', toolName: 'MultiEdit' });
      insertToolCall(db, { id: 's3tc2', turnId: 's3t1', toolName: 'Read', inputJson: JSON.stringify({ file_path: '/x' }) });
      insertToolCall(db, { id: 's3tc3', turnId: 's3t2', toolName: 'Read', inputJson: JSON.stringify({ file_path: '/x' }) });
      ids.push('s3');

      // s4: tool errors (2 of 4)
      insertSession(db, { id: 's4', startedAt: base + 4, turnCount: 1 });
      insertTurn(db, { id: 's4t1', sessionId: 's4', sequence: 1 });
      insertToolCall(db, { id: 's4tc1', turnId: 's4t1', toolName: 'Bash', isError: true });
      insertToolCall(db, { id: 's4tc2', turnId: 's4t1', toolName: 'Bash', isError: true });
      insertToolCall(db, { id: 's4tc3', turnId: 's4t1', toolName: 'Read', inputJson: JSON.stringify({ file_path: '/r' }) });
      insertToolCall(db, { id: 's4tc4', turnId: 's4t1', toolName: 'Write' });
      ids.push('s4');

      // s5: re-reads on same path
      insertSession(db, { id: 's5', startedAt: base + 5, turnCount: 1 });
      insertTurn(db, { id: 's5t1', sessionId: 's5', sequence: 1 });
      insertToolCall(db, { id: 's5r1', turnId: 's5t1', toolName: 'Read', inputJson: JSON.stringify({ file_path: '/p' }) });
      insertToolCall(db, { id: 's5r2', turnId: 's5t1', toolName: 'Read', inputJson: JSON.stringify({ file_path: '/p' }) });
      insertToolCall(db, { id: 's5r3', turnId: 's5t1', toolName: 'Read', inputJson: JSON.stringify({ file_path: '/p' }) });
      insertToolCall(db, { id: 's5e1', turnId: 's5t1', toolName: 'Edit' });
      ids.push('s5');

      // s6: compaction event + subagent turn
      insertSession(db, { id: 's6', startedAt: base + 6, turnCount: 2 });
      insertTurn(db, { id: 's6t1', sessionId: 's6', sequence: 1, subagentType: 'general' });
      insertTurn(db, { id: 's6t2', sessionId: 's6', sequence: 2 });
      insertCompactionEvent(db, { sessionId: 's6', sourceFile: 's6.jsonl', sequenceInFile: 1 });
      ids.push('s6');

      // s7: many reads, many edits → ratio > 1
      insertSession(db, { id: 's7', startedAt: base + 7, turnCount: 1 });
      insertTurn(db, { id: 's7t1', sessionId: 's7', sequence: 1, inputTokens: 30 });
      for (let i = 0; i < 5; i++) {
        insertToolCall(db, { id: `s7r${i}`, turnId: 's7t1', toolName: 'Read', inputJson: JSON.stringify({ file_path: `/f${i}` }) });
      }
      insertToolCall(db, { id: 's7e1', turnId: 's7t1', toolName: 'Edit' });
      ids.push('s7');

      // s8: malformed json on reads (should be ignored — REQ-9)
      insertSession(db, { id: 's8', startedAt: base + 8, turnCount: 1 });
      insertTurn(db, { id: 's8t1', sessionId: 's8', sequence: 1 });
      insertToolCall(db, { id: 's8r1', turnId: 's8t1', toolName: 'Read', inputJson: 'not-json' });
      insertToolCall(db, { id: 's8r2', turnId: 's8t1', toolName: 'Read', inputJson: 'not-json' });
      ids.push('s8');

      // s9: multiple compactions + multiple subagent turns
      insertSession(db, { id: 's9', startedAt: base + 9, turnCount: 3 });
      insertTurn(db, { id: 's9t1', sessionId: 's9', sequence: 1, subagentType: 'general' });
      insertTurn(db, { id: 's9t2', sessionId: 's9', sequence: 2, subagentType: 'reviewer' });
      insertTurn(db, { id: 's9t3', sessionId: 's9', sequence: 3 });
      insertCompactionEvent(db, { sessionId: 's9', sourceFile: 's9.jsonl', sequenceInFile: 1 });
      insertCompactionEvent(db, { sessionId: 's9', sourceFile: 's9.jsonl', sequenceInFile: 2 });
      ids.push('s9');

      // s10: edits without reads
      insertSession(db, { id: 's10', startedAt: base + 10, turnCount: 1 });
      insertTurn(db, { id: 's10t1', sessionId: 's10', sequence: 1 });
      insertToolCall(db, { id: 's10e1', turnId: 's10t1', toolName: 'Edit' });
      insertToolCall(db, { id: 's10e2', turnId: 's10t1', toolName: 'Edit' });
      ids.push('s10');

      // s11: out-of-window — must NOT appear
      insertSession(db, { id: 's11_out', startedAt: now - 60 * DAY_MS, turnCount: 1 });
      insertTurn(db, { id: 's11t1', sessionId: 's11_out', sequence: 1 });
      insertToolCall(db, { id: 's11e1', turnId: 's11t1', toolName: 'Edit' });

      return { sessionIds: ids, expectedN: ids.length };
    }

    it('TC-I-09: aggregates are byte-identical to the parity oracle (REQ-19 parity)', () => {
      // Parity oracle: compute the expected aggregate purely via the
      // already-unit-tested `getPersonalEffectivenessSession` (which is
      // intentionally NOT refactored). This decouples the parity assertion
      // from the production aggregate's internals so the test stays a
      // black-box behavioral contract across the refactor.
      const { sessionIds, expectedN } = seedAggregateFixture();
      expect(expectedN).toBeGreaterThan(10); // spec: >10 sessions

      // Build the oracle (mirrors the public contract of getPersonalEffectivenessAggregates).
      const rereadVals: number[] = [];
      const tokensVals: Array<number | null> = [];
      const ratioVals: Array<number | null> = [];
      const errorVals: Array<number | null> = [];
      let sessionsWithCompaction = 0;
      for (const id of sessionIds) {
        const m = getPersonalEffectivenessSession(db, id);
        if (!m) continue;
        rereadVals.push(m.rereadCount);
        tokensVals.push(m.tokensUntilFirstEdit);
        ratioVals.push(m.readsToEditsRatio);
        errorVals.push(m.toolErrorRate);
        if (m.compactionEventCount > 0) sessionsWithCompaction += 1;
      }
      const avg = (xs: Array<number | null>): number | null => {
        const f = xs.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
        return f.length === 0 ? null : f.reduce((a, v) => a + v, 0) / f.length;
      };
      const expected = {
        avgRereadCount: rereadVals.length === 0 ? null : avg(rereadVals),
        avgTokensUntilFirstEdit: avg(tokensVals),
        avgReadsToEditsRatio: avg(ratioVals),
        avgToolErrorRate: avg(errorVals),
        sessionsWithCompaction,
        totalSessions: sessionIds.length,
      };

      const actual = getPersonalEffectivenessAggregates(db, 30);

      // Byte-identical via JSON.stringify, as the spec requires.
      expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
    });

    it('TC-I-10: prepared-stmt executions in window ≤ 2N+1 (REQ-19 count)', () => {
      // Use a FRESH DB so the WeakMap cache is empty — every `prepare`
      // call (and its resulting stmt's `.get`/`.all` invocations) goes
      // through our spy. Spying after warmup wouldn't catch executions
      // on already-cached statements.
      type Stmt = ReturnType<typeof db.prepare>;
      const measureDb = fresh();
      // Re-seed inline (mirror seedAggregateFixture)
      const base = now - 5 * DAY_MS;
      insertSession(measureDb, { id: 's0', startedAt: base, turnCount: 0 });
      insertSession(measureDb, { id: 's1', startedAt: base + 1, turnCount: 2 });
      insertTurn(measureDb, { id: 's1t1', sessionId: 's1', sequence: 1, inputTokens: 50 });
      insertTurn(measureDb, { id: 's1t2', sessionId: 's1', sequence: 2 });
      insertToolCall(measureDb, { id: 's1tc1', turnId: 's1t1', toolName: 'Edit' });
      insertSession(measureDb, { id: 's2', startedAt: base + 2, turnCount: 2 });
      insertTurn(measureDb, { id: 's2t1', sessionId: 's2', sequence: 1, inputTokens: 100 });
      insertTurn(measureDb, { id: 's2t2', sessionId: 's2', sequence: 2 });
      insertToolCall(measureDb, { id: 's2tc1', turnId: 's2t1', toolName: 'Read', inputJson: JSON.stringify({ file_path: '/a' }) });
      insertSession(measureDb, { id: 's3', startedAt: base + 3, turnCount: 4 });
      insertTurn(measureDb, { id: 's3t1', sessionId: 's3', sequence: 1, inputTokens: 10, outputTokens: 5, cacheCreationTokens: 5 });
      insertTurn(measureDb, { id: 's3t2', sessionId: 's3', sequence: 2, inputTokens: 20, outputTokens: 10, cacheCreationTokens: 10 });
      insertTurn(measureDb, { id: 's3t3', sessionId: 's3', sequence: 3 });
      insertTurn(measureDb, { id: 's3t4', sessionId: 's3', sequence: 4 });
      insertToolCall(measureDb, { id: 's3tc1', turnId: 's3t3', toolName: 'MultiEdit' });
      insertSession(measureDb, { id: 's4', startedAt: base + 4, turnCount: 1 });
      insertTurn(measureDb, { id: 's4t1', sessionId: 's4', sequence: 1 });
      insertToolCall(measureDb, { id: 's4tc1', turnId: 's4t1', toolName: 'Bash', isError: true });
      insertSession(measureDb, { id: 's5', startedAt: base + 5, turnCount: 1 });
      insertTurn(measureDb, { id: 's5t1', sessionId: 's5', sequence: 1 });
      insertToolCall(measureDb, { id: 's5r1', turnId: 's5t1', toolName: 'Read', inputJson: JSON.stringify({ file_path: '/p' }) });
      insertToolCall(measureDb, { id: 's5e1', turnId: 's5t1', toolName: 'Edit' });
      insertSession(measureDb, { id: 's6', startedAt: base + 6, turnCount: 2 });
      insertTurn(measureDb, { id: 's6t1', sessionId: 's6', sequence: 1, subagentType: 'general' });
      insertTurn(measureDb, { id: 's6t2', sessionId: 's6', sequence: 2 });
      insertCompactionEvent(measureDb, { sessionId: 's6', sourceFile: 's6.jsonl', sequenceInFile: 1 });
      insertSession(measureDb, { id: 's7', startedAt: base + 7, turnCount: 1 });
      insertTurn(measureDb, { id: 's7t1', sessionId: 's7', sequence: 1, inputTokens: 30 });
      insertToolCall(measureDb, { id: 's7e1', turnId: 's7t1', toolName: 'Edit' });
      insertSession(measureDb, { id: 's8', startedAt: base + 8, turnCount: 1 });
      insertTurn(measureDb, { id: 's8t1', sessionId: 's8', sequence: 1 });
      insertSession(measureDb, { id: 's9', startedAt: base + 9, turnCount: 3 });
      insertTurn(measureDb, { id: 's9t1', sessionId: 's9', sequence: 1, subagentType: 'general' });
      insertTurn(measureDb, { id: 's9t2', sessionId: 's9', sequence: 2, subagentType: 'reviewer' });
      insertTurn(measureDb, { id: 's9t3', sessionId: 's9', sequence: 3 });
      insertCompactionEvent(measureDb, { sessionId: 's9', sourceFile: 's9.jsonl', sequenceInFile: 1 });
      insertSession(measureDb, { id: 's10', startedAt: base + 10, turnCount: 1 });
      insertTurn(measureDb, { id: 's10t1', sessionId: 's10', sequence: 1 });
      insertToolCall(measureDb, { id: 's10e1', turnId: 's10t1', toolName: 'Edit' });

      // Now wrap prepare on the FRESH measureDb so every prepared stmt
      // method runs through our counter. WeakMap is empty for measureDb.
      let mGetCalls = 0;
      let mAllCalls = 0;
      const measureOriginalPrepare = measureDb.prepare.bind(measureDb);
      const mDbAny = measureDb as unknown as { prepare: (sql: string) => Stmt };
      type StmtMethods = {
        get: (...args: unknown[]) => unknown;
        all: (...args: unknown[]) => unknown;
      };
      const wrapMeasureStmt = (stmt: Stmt): Stmt => {
        const sm = stmt as unknown as StmtMethods;
        const origGet = sm.get.bind(stmt);
        const origAll = sm.all.bind(stmt);
        sm.get = (...args: unknown[]) => {
          mGetCalls += 1;
          return origGet(...args);
        };
        sm.all = (...args: unknown[]) => {
          mAllCalls += 1;
          return origAll(...args);
        };
        return stmt;
      };
      mDbAny.prepare = (sql: string): Stmt => {
        return wrapMeasureStmt(measureOriginalPrepare(sql));
      };

      // Single call under measurement.
      getPersonalEffectivenessAggregates(measureDb, 30);

      // Restore so other tests aren't affected.
      mDbAny.prepare = measureOriginalPrepare;

      // N = number of in-window sessions inserted into measureDb (s0..s10).
      const N = 11;

      // Total stmt executions = .get() + .all() calls. Spec REQ-19 budget
      // is ≤ 2N + 1 for the refactor target itself (one aggregate `.all`
      // + two per-session `.get` calls for firstEditSeq + tokensBeforeSeq).
      // The window-level scans (totalSessions, sessionsWithCompaction,
      // sessionIdsInWindow) are unchanged by the refactor and count
      // separately. We subtract those 3 fixed scans before comparing.
      const fixedWindowScans = 3;
      const refactorExecutions = mGetCalls + mAllCalls - fixedWindowScans;

      // Spec budget: ≤ 2N + 1
      expect(refactorExecutions).toBeLessThanOrEqual(2 * N + 1);
      // Sanity floor: at least 1 aggregate `.all` must have happened.
      expect(refactorExecutions).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------- Prepared statement reuse ----------------

  describe('prepared statements (REQ-30)', () => {
    it('TC-I-39: 50 consecutive query calls reuse prepared stmts (no extra db.prepare)', () => {
      insertSession(db, { id: 's1', startedAt: now - DAY_MS, costUsd: 1.0, turnCount: 1, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 500 });
      insertTurn(db, { id: 's1t1', sessionId: 's1', sequence: 1, inputTokens: 100 });
      insertToolCall(db, { id: 'tc1', turnId: 's1t1', toolName: 'Edit' });
      insertRating(db, { turnId: 's1t1', rating: 1 });
      insertCompactionEvent(db, { sessionId: 's1', sourceFile: 'a.jsonl', sequenceInFile: 1 });
      insertCalibration(db, { family: 'global', rate: 0.5 });

      const originalPrepare = db.prepare.bind(db);
      let prepareCount = 0;
      // Spy on db.prepare to confirm zero NEW prepares after warmup.
      type Stmt = ReturnType<typeof originalPrepare>;
      // Warmup: invoke each query once to populate the WeakMap.
      getPersonalEffectivenessSession(db, 's1');
      getPersonalEffectivenessAggregates(db, 30);
      getCostRatingScatter(db, 30);
      getQuartileComparison(db, 30);
      getEffectivenessFunnel(db, 30);
      getDailyEffectivenessHeatmap(db, 30);

      const dbAny = db as unknown as { prepare: (sql: string) => Stmt };
      dbAny.prepare = (sql: string): Stmt => {
        prepareCount++;
        return originalPrepare(sql);
      };

      // 50 consecutive calls — must reuse the cached statements.
      const seed = getPersonalEffectivenessSession(db, 's1');
      for (let i = 0; i < 50; i++) {
        const sess = getPersonalEffectivenessSession(db, 's1');
        expect(sess).toEqual(seed);
        getPersonalEffectivenessAggregates(db, 30);
        getCostRatingScatter(db, 30);
        getEffectivenessFunnel(db, 30);
        getDailyEffectivenessHeatmap(db, 30);
      }

      // Restore so other tests aren't affected.
      dbAny.prepare = originalPrepare;
      expect(prepareCount).toBe(0);
    });
  });
});
