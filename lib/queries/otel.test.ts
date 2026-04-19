import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';
import {
  getAcceptRatesBySession,
  getOtelCostBySession,
  getOtelCostForSession,
  getOtelInsights,
  getSessionOtelStats,
  getWeeklyAcceptRate,
} from '@/lib/queries/otel';

const DAY_MS = 86_400_000;

function freshDb(): DB {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

function seedSession(
  db: DB,
  id: string,
  overrides: { startedAt?: number; totalCostUsd?: number } = {},
): void {
  db.prepare(
    `INSERT INTO sessions (
       id, slug, cwd, project, git_branch, cc_version,
       started_at, ended_at,
       total_input_tokens, total_output_tokens,
       total_cache_read_tokens, total_cache_creation_tokens,
       total_cost_usd, turn_count, tool_call_count,
       source_file, ingested_at
     ) VALUES (?, NULL, '/cwd', 'proj', 'main', 'v1',
       ?, ?, 100, 50, 0, 0, ?, 1, 0, 'src', ?)`,
  ).run(
    id,
    overrides.startedAt ?? Date.now() - DAY_MS,
    overrides.startedAt ?? Date.now() - DAY_MS,
    overrides.totalCostUsd ?? 1.0,
    Date.now(),
  );
}

// Monotonic scraped_at so repeat inserts for the same series don't collide
// with the UNIQUE(metric_name, labels_json, scraped_at) constraint. Each call
// yields a timestamp strictly greater than the previous one.
let nextScrapedAt = Date.now();
const uniqueScrapedAt = (): number => ++nextScrapedAt;

function insertDecision(
  db: DB,
  sessionId: string,
  decision: 'accept' | 'reject',
  value: number,
  scrapedAt: number = uniqueScrapedAt(),
): void {
  db.prepare(
    `INSERT INTO otel_scrapes (scraped_at, metric_name, labels_json, value)
     VALUES (?, 'claude_code_code_edit_tool_decision_total', ?, ?)`,
  ).run(scrapedAt, JSON.stringify({ session_id: sessionId, decision }), value);
}

function insertLines(
  db: DB,
  sessionId: string,
  type: 'added' | 'removed',
  value: number,
): void {
  db.prepare(
    `INSERT INTO otel_scrapes (scraped_at, metric_name, labels_json, value)
     VALUES (?, 'claude_code_lines_of_code_count_total', ?, ?)`,
  ).run(uniqueScrapedAt(), JSON.stringify({ session_id: sessionId, type }), value);
}

function insertScalar(
  db: DB,
  sessionId: string,
  metric: string,
  value: number,
): void {
  db.prepare(
    `INSERT INTO otel_scrapes (scraped_at, metric_name, labels_json, value)
     VALUES (?, ?, ?, ?)`,
  ).run(uniqueScrapedAt(), metric, JSON.stringify({ session_id: sessionId }), value);
}

describe('getOtelInsights', () => {
  let db: DB;
  beforeEach(() => {
    db = freshDb();
  });

  it('returns hasOtelData=false when otel_scrapes is empty', () => {
    seedSession(db, 's1');
    const insights = getOtelInsights(db, 30);
    expect(insights.hasOtelData).toBe(false);
    expect(insights.acceptRate).toBeNull();
    expect(insights.totalAccepts).toBe(0);
    expect(insights.costPerLineOfCode).toBeNull();
  });

  it('aggregates accept/reject decisions across sessions (MAX per series)', () => {
    seedSession(db, 's1');
    seedSession(db, 's2');
    // s1: counter grew 3 → 5 for accept, stayed at 1 for reject
    insertDecision(db, 's1', 'accept', 3);
    insertDecision(db, 's1', 'accept', 5); // later scrape, bigger value
    insertDecision(db, 's1', 'reject', 1);
    // s2: 2 accepts, 2 rejects
    insertDecision(db, 's2', 'accept', 2);
    insertDecision(db, 's2', 'reject', 2);

    const insights = getOtelInsights(db, 30);
    expect(insights.hasOtelData).toBe(true);
    expect(insights.totalAccepts).toBe(7); // 5 + 2
    expect(insights.totalRejects).toBe(3); // 1 + 2
    expect(insights.acceptRate).toBeCloseTo(0.7, 5);
  });

  it('excludes sessions outside the time window', () => {
    seedSession(db, 'recent');
    seedSession(db, 'old', { startedAt: Date.now() - 90 * DAY_MS });
    insertDecision(db, 'recent', 'accept', 3);
    insertDecision(db, 'old', 'accept', 99);

    const insights = getOtelInsights(db, 30);
    expect(insights.totalAccepts).toBe(3);
  });

  it('aggregates lines added/removed correctly', () => {
    seedSession(db, 's1');
    insertLines(db, 's1', 'added', 120);
    insertLines(db, 's1', 'removed', 30);

    const insights = getOtelInsights(db, 30);
    expect(insights.totalLinesAdded).toBe(120);
    expect(insights.totalLinesRemoved).toBe(30);
  });

  it('computes cost per line across all lines touched', () => {
    seedSession(db, 's1', { totalCostUsd: 3.0 });
    insertLines(db, 's1', 'added', 100);
    insertLines(db, 's1', 'removed', 50);

    const insights = getOtelInsights(db, 30);
    // 3.0 USD / (100 + 50) lines = 0.02
    expect(insights.costPerLineOfCode).toBeCloseTo(0.02, 5);
  });

  it('costPerLineOfCode is null when no lines touched', () => {
    seedSession(db, 's1', { totalCostUsd: 5.0 });
    insertDecision(db, 's1', 'accept', 1);
    const insights = getOtelInsights(db, 30);
    expect(insights.costPerLineOfCode).toBeNull();
  });

  it('acceptRate is null when no decisions in window', () => {
    seedSession(db, 's1');
    insertLines(db, 's1', 'added', 10); // only lines, no decisions
    const insights = getOtelInsights(db, 30);
    expect(insights.acceptRate).toBeNull();
    expect(insights.hasOtelData).toBe(true); // still true: lines present
  });

  it('aggregates commits / PRs / active_time (scalar metrics)', () => {
    seedSession(db, 's1');
    insertScalar(db, 's1', 'claude_code_commit_count_total', 4);
    insertScalar(db, 's1', 'claude_code_pull_request_count_total', 1);
    insertScalar(db, 's1', 'claude_code_active_time_total', 1800);
    const insights = getOtelInsights(db, 30);
    expect(insights.totalCommits).toBe(4);
    expect(insights.totalPullRequests).toBe(1);
    expect(insights.totalActiveSeconds).toBe(1800);
  });
});

describe('getSessionOtelStats', () => {
  let db: DB;
  beforeEach(() => {
    db = freshDb();
  });

  it('returns hasData=false when session has no OTEL events', () => {
    seedSession(db, 's1');
    const stats = getSessionOtelStats(db, 's1');
    expect(stats.hasData).toBe(false);
    expect(stats.acceptRate).toBeNull();
  });

  it('computes per-session accept/reject + acceptRate', () => {
    seedSession(db, 's1');
    insertDecision(db, 's1', 'accept', 8);
    insertDecision(db, 's1', 'reject', 2);
    const stats = getSessionOtelStats(db, 's1');
    expect(stats.hasData).toBe(true);
    expect(stats.accepts).toBe(8);
    expect(stats.rejects).toBe(2);
    expect(stats.acceptRate).toBeCloseTo(0.8, 5);
  });

  it('reports lines added/removed + active seconds + commits', () => {
    seedSession(db, 's1');
    insertLines(db, 's1', 'added', 50);
    insertLines(db, 's1', 'removed', 15);
    insertScalar(db, 's1', 'claude_code_active_time_total', 900);
    insertScalar(db, 's1', 'claude_code_commit_count_total', 2);

    const stats = getSessionOtelStats(db, 's1');
    expect(stats.linesAdded).toBe(50);
    expect(stats.linesRemoved).toBe(15);
    expect(stats.activeSeconds).toBe(900);
    expect(stats.commits).toBe(2);
    expect(stats.hasData).toBe(true);
  });

  it('scopes to the requested session only', () => {
    seedSession(db, 's1');
    seedSession(db, 's2');
    insertDecision(db, 's1', 'accept', 5);
    insertDecision(db, 's2', 'accept', 99);

    const stats = getSessionOtelStats(db, 's1');
    expect(stats.accepts).toBe(5);
  });
});

describe('getWeeklyAcceptRate', () => {
  let db: DB;
  beforeEach(() => {
    db = freshDb();
  });

  it('returns [] when no OTEL data', () => {
    seedSession(db, 's1');
    expect(getWeeklyAcceptRate(db, 12)).toEqual([]);
  });

  it('groups decisions by week of session start', () => {
    const now = Date.now();
    seedSession(db, 'thisWeek', { startedAt: now - 2 * DAY_MS });
    seedSession(db, 'twoWeeksAgo', { startedAt: now - 14 * DAY_MS });
    insertDecision(db, 'thisWeek', 'accept', 8);
    insertDecision(db, 'thisWeek', 'reject', 2);
    insertDecision(db, 'twoWeeksAgo', 'accept', 4);
    insertDecision(db, 'twoWeeksAgo', 'reject', 6);

    const points = getWeeklyAcceptRate(db, 12);
    expect(points.length).toBe(2);
    // Sorted by week ascending; oldest first
    const [older, newer] = points;
    expect(older.acceptRate).toBeCloseTo(0.4, 5);
    expect(newer.acceptRate).toBeCloseTo(0.8, 5);
  });

  it('excludes weeks with zero decisions', () => {
    seedSession(db, 's1');
    insertLines(db, 's1', 'added', 10);
    // no decisions inserted
    const points = getWeeklyAcceptRate(db, 12);
    expect(points).toEqual([]);
  });
});

describe('getAcceptRatesBySession', () => {
  let db: DB;
  beforeEach(() => {
    db = freshDb();
  });

  it('returns empty map when no OTEL data', () => {
    seedSession(db, 's1');
    expect(getAcceptRatesBySession(db, 30).size).toBe(0);
  });

  it('maps sessionId → acceptRate', () => {
    seedSession(db, 's1');
    seedSession(db, 's2');
    insertDecision(db, 's1', 'accept', 9);
    insertDecision(db, 's1', 'reject', 1);
    insertDecision(db, 's2', 'accept', 3);
    insertDecision(db, 's2', 'reject', 7);

    const map = getAcceptRatesBySession(db, 30);
    expect(map.get('s1')).toBeCloseTo(0.9, 5);
    expect(map.get('s2')).toBeCloseTo(0.3, 5);
  });

  it('skips sessions with zero decisions', () => {
    seedSession(db, 's1');
    insertLines(db, 's1', 'added', 10);
    expect(getAcceptRatesBySession(db, 30).size).toBe(0);
  });
});

describe('TC-I-15: canonical decision metric name is picked up (regression lock)', () => {
  // Locks in the fix from the audit: METRIC_DECISION used to be
  // `claude_code_code_edit_tool_decision_count_total` (wrong) so the query
  // silently returned 0 forever. This test inserts scrapes under the CORRECT
  // name `claude_code_code_edit_tool_decision_total` and asserts the
  // aggregator picks them up — a regression to the wrong constant would
  // break this test.
  let db: DB;
  beforeEach(() => {
    db = freshDb();
  });

  it('getOtelInsights reflects non-zero acceptRate under canonical metric name', () => {
    seedSession(db, 's1');
    const scrapedAt = Date.now() - 1000;
    // Raw insert bypassing insertDecision to guarantee the exact metric name.
    const stmt = db.prepare(
      `INSERT INTO otel_scrapes (scraped_at, metric_name, labels_json, value)
       VALUES (?, 'claude_code_code_edit_tool_decision_total', ?, ?)`,
    );
    stmt.run(scrapedAt, JSON.stringify({ session_id: 's1', decision: 'accept' }), 7);
    stmt.run(scrapedAt, JSON.stringify({ session_id: 's1', decision: 'reject' }), 3);
    const insights = getOtelInsights(db, 30);
    expect(insights.totalAccepts).toBe(7);
    expect(insights.totalRejects).toBe(3);
    expect(insights.acceptRate).toBeCloseTo(0.7, 5);
    expect(insights.hasOtelData).toBe(true);
  });
});

describe('getOtelCostBySession / getOtelCostForSession', () => {
  let db: DB;
  let nextScrapedAt = Date.now() - 100_000;
  const insertCost = (
    sessionId: string,
    model: string,
    value: number,
    metricName = 'claude_code_cost_usage_total',
  ): void => {
    nextScrapedAt += 1;
    db.prepare(
      `INSERT INTO otel_scrapes (scraped_at, metric_name, labels_json, value)
       VALUES (?, ?, ?, ?)`,
    ).run(
      nextScrapedAt,
      metricName,
      JSON.stringify({ session_id: sessionId, model }),
      value,
    );
  };
  beforeEach(() => {
    db = freshDb();
    nextScrapedAt = Date.now() - 100_000;
  });

  it('TC-I-01: MAX per series picks the last observed cumulative value', () => {
    seedSession(db, 's1');
    insertCost('s1', 'claude-opus-4-7', 0.1);
    insertCost('s1', 'claude-opus-4-7', 0.5);
    insertCost('s1', 'claude-opus-4-7', 1.2);
    const map = getOtelCostBySession(db);
    expect(map.get('s1')).toBeCloseTo(1.2, 5);
  });

  it('TC-I-02: SUM across (session_id, model) series for the same session', () => {
    seedSession(db, 's1');
    insertCost('s1', 'claude-opus-4-7', 1.0);
    insertCost('s1', 'claude-sonnet-4-6', 0.5);
    const map = getOtelCostBySession(db);
    expect(map.get('s1')).toBeCloseTo(1.5, 5);
  });

  it('TC-I-03: case-insensitive metric name + _usd_total alias (both variants work)', () => {
    // Variant A: canonical name, mixed case
    seedSession(db, 'sA');
    insertCost('sA', 'claude-opus-4-7', 2.0, 'CLAUDE_CODE_COST_USAGE_TOTAL');
    // Variant B: _usd_total alias, lower case
    seedSession(db, 'sB');
    insertCost('sB', 'claude-opus-4-7', 3.0, 'claude_code_cost_usage_usd_total');
    const map = getOtelCostBySession(db);
    expect(map.get('sA')).toBeCloseTo(2.0, 5);
    expect(map.get('sB')).toBeCloseTo(3.0, 5);
  });

  it('TC-I-04: scrapes without session_id label are ignored', () => {
    seedSession(db, 's1');
    db.prepare(
      `INSERT INTO otel_scrapes (scraped_at, metric_name, labels_json, value)
       VALUES (?, 'claude_code_cost_usage_total', ?, ?)`,
    ).run(Date.now() - 1000, JSON.stringify({ model: 'claude-opus-4-7' }), 99);
    const map = getOtelCostBySession(db);
    expect(map.size).toBe(0);
  });

  it('TC-I-05: returns empty Map when no cost scrapes exist', () => {
    seedSession(db, 's1');
    const map = getOtelCostBySession(db);
    expect(map.size).toBe(0);
    expect(getOtelCostForSession(db, 's1')).toBeNull();
  });

  it('getOtelCostForSession returns null for unknown session', () => {
    seedSession(db, 's1');
    insertCost('s1', 'claude-opus-4-7', 2.5);
    expect(getOtelCostForSession(db, 'does-not-exist')).toBeNull();
    expect(getOtelCostForSession(db, 's1')).toBeCloseTo(2.5, 5);
  });
});
