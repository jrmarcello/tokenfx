import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';
import { getSubagentBreakdown } from '@/lib/queries/subagent';

type SeedSession = {
  id: string;
  project?: string;
  startedAt?: number;
  endedAt?: number;
};

function insertSession(db: DB, s: SeedSession): void {
  db.prepare(
    `INSERT INTO sessions (
      id, slug, cwd, project, git_branch, cc_version,
      started_at, ended_at,
      total_input_tokens, total_output_tokens, total_cache_read_tokens, total_cache_creation_tokens,
      total_cost_usd, turn_count, tool_call_count,
      source_file, ingested_at
    ) VALUES (?, NULL, ?, ?, NULL, NULL, ?, ?, 0, 0, 0, 0, 0, 0, 0, ?, ?)`,
  ).run(
    s.id,
    '/tmp/cwd',
    s.project ?? 'demo',
    s.startedAt ?? Date.now() - 60_000,
    s.endedAt ?? Date.now(),
    `file-${s.id}.jsonl`,
    Date.now(),
  );
}

type SeedTurn = {
  id: string;
  sessionId: string;
  sequence: number;
  costUsd?: number;
  outputTokens?: number;
  subagentType?: string | null;
};

function insertTurn(db: DB, t: SeedTurn): void {
  db.prepare(
    `INSERT INTO turns (
      id, session_id, parent_uuid, sequence, timestamp, model,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
      cost_usd, stop_reason, user_prompt, assistant_text, tool_uses_json,
      subagent_type
    ) VALUES (?, ?, NULL, ?, ?, 'claude', 0, ?, 0, 0, ?, NULL, NULL, NULL, '[]', ?)`,
  ).run(
    t.id,
    t.sessionId,
    t.sequence,
    Date.now(),
    t.outputTokens ?? 0,
    t.costUsd ?? 0,
    t.subagentType === undefined ? null : t.subagentType,
  );
}

function ensureSubagentColumn(db: DB): void {
  // Bootstrap for worktrees where Batch 1's schema migration has not yet
  // landed. When Batch 1 merges, this becomes a no-op because the column
  // already exists (detected via PRAGMA).
  const cols = db.prepare(`PRAGMA table_info(turns)`).all() as Array<{
    name: string;
  }>;
  if (!cols.some((c) => c.name === 'subagent_type')) {
    db.exec(`ALTER TABLE turns ADD COLUMN subagent_type TEXT`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_turns_subagent ON turns(session_id, subagent_type)`,
    );
  }
}

function fresh(): DB {
  const db = openDatabase(':memory:');
  migrate(db);
  ensureSubagentColumn(db);
  return db;
}

describe('getSubagentBreakdown', () => {
  let db: DB;

  beforeEach(() => {
    db = fresh();
  });

  it('TC-I-06: 2 main turns + 1 Explore turn — Main first, then Explore', () => {
    insertSession(db, { id: 's1' });
    insertTurn(db, { id: 't1', sessionId: 's1', sequence: 0, costUsd: 3, subagentType: null });
    insertTurn(db, { id: 't2', sessionId: 's1', sequence: 1, costUsd: 2, subagentType: null });
    insertTurn(db, { id: 't3', sessionId: 's1', sequence: 2, costUsd: 5, subagentType: 'Explore' });

    const out = getSubagentBreakdown(db, 's1');
    expect(out).toHaveLength(2);
    expect(out[0].subagentType).toBeNull();
    expect(out[0].turns).toBe(2);
    expect(out[0].costUsd).toBe(5);
    expect(out[0].pct).toBeCloseTo(0.5, 10);
    expect(out[1].subagentType).toBe('Explore');
    expect(out[1].turns).toBe(1);
    expect(out[1].costUsd).toBe(5);
    expect(out[1].pct).toBeCloseTo(0.5, 10);
  });

  it('TC-I-06b: Main + 3 sub-agents sorted by cost desc with stable tiebreak', () => {
    insertSession(db, { id: 's2' });
    insertTurn(db, { id: 't1', sessionId: 's2', sequence: 0, costUsd: 1, subagentType: null });
    insertTurn(db, { id: 't2', sessionId: 's2', sequence: 1, costUsd: 10, subagentType: 'Explore' });
    insertTurn(db, { id: 't3', sessionId: 's2', sequence: 2, costUsd: 5, subagentType: 'Plan' });
    insertTurn(db, { id: 't4', sessionId: 's2', sequence: 3, costUsd: 20, subagentType: 'code-reviewer' });

    const out = getSubagentBreakdown(db, 's2');
    expect(out).toHaveLength(4);
    expect(out.map((r) => r.subagentType)).toEqual([
      null,
      'code-reviewer',
      'Explore',
      'Plan',
    ]);
  });

  it('TC-I-07: percentages sum to ~1.0', () => {
    insertSession(db, { id: 's1' });
    insertTurn(db, { id: 't1', sessionId: 's1', sequence: 0, costUsd: 3, subagentType: null });
    insertTurn(db, { id: 't2', sessionId: 's1', sequence: 1, costUsd: 2, subagentType: null });
    insertTurn(db, { id: 't3', sessionId: 's1', sequence: 2, costUsd: 5, subagentType: 'Explore' });

    const out = getSubagentBreakdown(db, 's1');
    const sum = out.reduce((acc, r) => acc + r.pct, 0);
    expect(sum).toBeCloseTo(1.0, 6);
  });

  it('TC-I-08: all turns NULL subagent_type → single Main row with pct=1.0', () => {
    insertSession(db, { id: 's-main-only' });
    insertTurn(db, { id: 't1', sessionId: 's-main-only', sequence: 0, costUsd: 1, subagentType: null });
    insertTurn(db, { id: 't2', sessionId: 's-main-only', sequence: 1, costUsd: 2, subagentType: null });
    insertTurn(db, { id: 't3', sessionId: 's-main-only', sequence: 2, costUsd: 3, subagentType: null });

    const out = getSubagentBreakdown(db, 's-main-only');
    expect(out).toHaveLength(1);
    expect(out[0].subagentType).toBeNull();
    expect(out[0].turns).toBe(3);
    expect(out[0].costUsd).toBe(6);
    expect(out[0].pct).toBeCloseTo(1.0, 10);
  });

  it('TC-I-09: all cost_usd = 0 → [] (divide-by-zero guard)', () => {
    insertSession(db, { id: 's-zero' });
    insertTurn(db, { id: 't1', sessionId: 's-zero', sequence: 0, costUsd: 0, subagentType: null });
    insertTurn(db, { id: 't2', sessionId: 's-zero', sequence: 1, costUsd: 0, subagentType: 'Explore' });

    expect(getSubagentBreakdown(db, 's-zero')).toEqual([]);
  });

  it('TC-I-10: session not found → []', () => {
    expect(getSubagentBreakdown(db, 'nonexistent-session-id')).toEqual([]);
  });

  it('TC-I-11: session exists but no turns → []', () => {
    insertSession(db, { id: 's-empty' });
    expect(getSubagentBreakdown(db, 's-empty')).toEqual([]);
  });

  it('TC-I-12: output tokens aggregated per subagent group', () => {
    insertSession(db, { id: 's-tokens' });
    insertTurn(db, {
      id: 't1',
      sessionId: 's-tokens',
      sequence: 0,
      costUsd: 1,
      outputTokens: 50,
      subagentType: null,
    });
    insertTurn(db, {
      id: 't2',
      sessionId: 's-tokens',
      sequence: 1,
      costUsd: 2,
      outputTokens: 100,
      subagentType: 'Explore',
    });
    insertTurn(db, {
      id: 't3',
      sessionId: 's-tokens',
      sequence: 2,
      costUsd: 3,
      outputTokens: 200,
      subagentType: 'Explore',
    });

    const out = getSubagentBreakdown(db, 's-tokens');
    expect(out).toHaveLength(2);
    expect(out[0].subagentType).toBeNull();
    expect(out[0].outputTokens).toBe(50);
    expect(out[1].subagentType).toBe('Explore');
    expect(out[1].outputTokens).toBe(300);
  });

  it('TC-I-13: 50 repeated calls produce identical results (prepared-statement cache)', () => {
    insertSession(db, { id: 's-loop' });
    insertTurn(db, { id: 't1', sessionId: 's-loop', sequence: 0, costUsd: 3, subagentType: null });
    insertTurn(db, { id: 't2', sessionId: 's-loop', sequence: 1, costUsd: 5, subagentType: 'Explore' });

    const first = getSubagentBreakdown(db, 's-loop');
    let last = first;
    for (let i = 0; i < 50; i++) {
      last = getSubagentBreakdown(db, 's-loop');
    }
    expect(last).toEqual(first);
  });
});
