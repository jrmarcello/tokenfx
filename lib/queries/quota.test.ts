import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';
import {
  getUserSettings,
  upsertUserSettings,
  getQuotaUsage,
  getQuotaHeatmap,
  getQuotaResetEstimates,
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
        quota5hResetAt: null,
        quota7dResetAt: null,
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
          quota5hResetAt: null,
          quota7dResetAt: null,
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
        quota5hResetAt: null,
        quota7dResetAt: null,
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
          quota5hResetAt: null,
          quota7dResetAt: null,
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
          quota5hResetAt: null,
          quota7dResetAt: null,
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
        quota5hResetAt: null,
        quota7dResetAt: null,
        updatedAt: 2000,
      });
      const count = db
        .prepare(`SELECT COUNT(*) AS c FROM user_settings`)
        .get() as { c: number };
      expect(count.c).toBe(1);
    });

    it('TC-I-06b: calibration round-trip — both 5h and 7d persist + read back', () => {
      const cal5h = 1_700_000_000_000;
      const cal7d = 1_800_000_000_000;
      upsertUserSettings(
        db,
        {
          quotaTokens5h: null,
          quotaTokens7d: null,
          quotaSessions5h: null,
          quotaSessions7d: null,
          quota5hResetAt: cal5h,
          quota7dResetAt: cal7d,
          updatedAt: null,
        },
        3000
      );
      const s = getUserSettings(db);
      expect(s.quota5hResetAt).toBe(cal5h);
      expect(s.quota7dResetAt).toBe(cal7d);
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

    it('TC-I-12b: cycleStart5hMs override excludes turns before the current block', () => {
      const now = Date.now();
      const h = 3_600_000;
      // Previous block: heavy turns 4h-3h ago (inside rolling 5h window).
      seedSession(db, 'prev', now - 4 * h);
      seedTurn(db, 'p1', 'prev', now - 4 * h, 1_000_000, 0);
      // Current block: just started 1min ago.
      seedSession(db, 'curr', now - 1 * 60_000);
      seedTurn(db, 'c1', 'curr', now - 30 * 1000, 100, 0);

      // Rolling behaviour (legacy) — includes previous block's 1M tokens.
      const rolling = getQuotaUsage(db, now);
      expect(rolling.tokens5h).toBeGreaterThan(500_000);

      // Block-aware — cycleStart5hMs = now - 1min → only current block counted.
      const blockAware = getQuotaUsage(db, now, {
        cycleStart5hMs: now - 2 * 60_000,
      });
      expect(blockAware.tokens5h).toBe(100);
    });

    it('TC-I-12c: cycleStart7dMs override excludes turns before the current cycle', () => {
      const now = Date.now();
      const D = 86_400_000;
      // Previous weekly cycle: turns from 8-6d ago (outside 7d, but previous
      // cycle might extend into the rolling window if the user calibrated
      // recently after a big idle).
      seedSession(db, 'prev', now - 6 * D);
      seedTurn(db, 'p1', 'prev', now - 6 * D, 500_000, 0);
      // Current cycle: turns from 3d ago.
      seedSession(db, 'curr', now - 3 * D);
      seedTurn(db, 'c1', 'curr', now - 3 * D, 200, 0);

      // User calibrated "reset in 2d" → cycle started 5d ago → only c1 counts.
      const blockAware = getQuotaUsage(db, now, {
        cycleStart7dMs: now - 5 * D,
      });
      expect(blockAware.tokens7d).toBe(200);
    });

    it('TC-I-12d: null overrides fall back to rolling (legacy)', () => {
      const now = Date.now();
      const h = 3_600_000;
      seedSession(db, 's', now - 2 * h);
      seedTurn(db, 't', 's', now - 2 * h, 999, 0);

      // Both null → rolling (identical to no-arg call).
      const withNulls = getQuotaUsage(db, now, {
        cycleStart5hMs: null,
        cycleStart7dMs: null,
      });
      const noArg = getQuotaUsage(db, now);
      expect(withNulls).toEqual(noArg);
      expect(withNulls.tokens5h).toBe(999);
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

  describe('getQuotaResetEstimates', () => {
    const H = 3_600_000;
    const D = 86_400_000;

    it('TC-I-03: turns within last 3h → reset5hMs ≈ oldest + 5h; reset7dMs ≈ oldest + 7d', () => {
      const now = 10_000_000_000;
      const oldest = now - 3 * H;
      seedSession(db, 's1', oldest);
      seedTurn(db, 't1', 's1', oldest, 10, 10);
      seedTurn(db, 't2', 's1', now - 2 * H, 10, 10);
      seedTurn(db, 't3', 's1', now - 1 * H, 10, 10);
      seedTurn(db, 't4', 's1', now - 30 * 60_000, 10, 10);
      seedTurn(db, 't5', 's1', now - 10 * 60_000, 10, 10);

      const r = getQuotaResetEstimates(db, now);
      expect(r.reset5hMs).toBe(oldest + 5 * H);
      expect(r.reset7dMs).toBe(oldest + 7 * D);
    });

    it('TC-I-04: empty DB returns both nulls', () => {
      const now = 10_000_000_000;
      const r = getQuotaResetEstimates(db, now);
      expect(r).toEqual({ reset5hMs: null, reset7dMs: null });
    });

    it('TC-I-05: most recent turn at -6h → reset5hMs null; reset7dMs set', () => {
      const now = 10_000_000_000;
      const ts = now - 6 * H;
      seedSession(db, 's1', ts);
      seedTurn(db, 't1', 's1', ts, 10, 10);

      const r = getQuotaResetEstimates(db, now);
      expect(r.reset5hMs).toBeNull();
      expect(r.reset7dMs).toBe(ts + 7 * D);
    });

    it('TC-I-06: 2 turns at -6h and -2h (gap 4h) → modular block 2 → reset ≈ +4h', () => {
      const now = 10_000_000_000;
      const t1 = now - 6 * H;
      const t2 = now - 2 * H;
      seedSession(db, 's1', t1);
      seedTurn(db, 't1', 's1', t1, 10, 10);
      seedTurn(db, 't2', 's1', t2, 10, 10);

      const r = getQuotaResetEstimates(db, now);
      // Anchor = t1 (prev_ts null). Elapsed = 6h. blocksPassed = 1 (floor(6/5)).
      // currentBlockStart = t1 + 5h = -1h. reset = -1h + 5h = +4h.
      expect(r.reset5hMs).toBe(t1 + 2 * 5 * H);
      expect(r.reset7dMs).toBe(t1 + 7 * D);
    });

    it('TC-I-07: gap > 5h detected → anchor = newer turn; reset = newer + 5h', () => {
      const now = 10_000_000_000;
      const t1 = now - 8 * H;
      const t2 = now - 2 * H;
      const t3 = now - 30 * 60_000;
      seedSession(db, 's1', t1);
      seedTurn(db, 't1', 's1', t1, 10, 10);
      seedTurn(db, 't2', 's1', t2, 10, 10);
      seedTurn(db, 't3', 's1', t3, 10, 10);

      const r = getQuotaResetEstimates(db, now);
      // SessionAnchor SQL: t2 is the MAX timestamp where (t2 - t1) = 6h > 5h.
      // Elapsed since t2 = 2h. blocksPassed = 0. reset = t2 + 5h.
      expect(r.reset5hMs).toBe(t2 + 5 * H);
      expect(r.reset7dMs).toBe(t1 + 7 * D);
    });

    it('TC-I-08: single turn → anchor = that turn; reset5hMs = turn + 5h', () => {
      const now = 10_000_000_000;
      const ts = now - 1 * H;
      seedSession(db, 's1', ts);
      seedTurn(db, 't1', 's1', ts, 10, 10);

      const r = getQuotaResetEstimates(db, now);
      expect(r.reset5hMs).toBe(ts + 5 * H);
      expect(r.reset7dMs).toBe(ts + 7 * D);
    });

    it('TC-I-09: 3 turns no gap > 5h → modular block 2 → reset ≈ +1h', () => {
      const now = 10_000_000_000;
      const t1 = now - 9 * H;
      const t2 = now - Math.round(5.5 * H);
      const t3 = now - 30 * 60_000;
      seedSession(db, 's1', t1);
      seedTurn(db, 't1', 's1', t1, 10, 10);
      seedTurn(db, 't2', 's1', t2, 10, 10);
      seedTurn(db, 't3', 's1', t3, 10, 10);

      const r = getQuotaResetEstimates(db, now);
      // Gaps: (t2, t1) = 3.5h, (t3, t2) = 5h exactly (not > 5h).
      // SessionAnchor = t1 (prev_ts null). Elapsed = 9h. blocksPassed = 1.
      // currentBlockStart = t1 + 5h = -4h. reset = -4h + 5h = +1h.
      expect(r.reset5hMs).toBe(t1 + 2 * 5 * H);
      expect(r.reset7dMs).toBe(t1 + 7 * D);
    });

    it('TC-I-10: overnight idle scenario — anchor pinned to first-of-day msg', () => {
      // Reproduces the real-world case: user had big idle, then started
      // active work at -8.26h, has been continuously active since. Claude.ai
      // shows "Resets in 1h". Block cycle anchored at the post-idle message.
      const now = 10_000_000_000;
      const prevDay = now - 22 * H; // yesterday
      const anchor = now - Math.round(8.26 * H); // first msg today (post-idle)
      const last = now - 3 * 60_000; // active now
      seedSession(db, 's1', prevDay);
      seedTurn(db, 't-prev', 's1', prevDay, 10, 10);
      seedSession(db, 's2', anchor);
      seedTurn(db, 't-anchor', 's2', anchor, 10, 10);
      seedTurn(db, 't-mid', 's2', now - 4 * H, 10, 10);
      seedTurn(db, 't-last', 's2', last, 10, 10);

      const r = getQuotaResetEstimates(db, now);
      // Elapsed since anchor ≈ 8.26h → blocksPassed = 1.
      // currentBlockStart = anchor + 5h. reset = anchor + 10h ≈ now + 1.74h.
      expect(r.reset5hMs).toBe(anchor + 2 * 5 * H);
      if (r.reset5hMs !== null) {
        const minutesUntilReset = (r.reset5hMs - now) / 60_000;
        expect(minutesUntilReset).toBeGreaterThan(30);
        expect(minutesUntilReset).toBeLessThan(180);
      }
    });

    it('TC-I-11: calibrated 7d reset overrides heuristic when future', () => {
      const now = 10_000_000_000;
      const turn = now - 6 * D; // heuristic would say reset = turn + 7d = +1d
      const calibrated = now + 2 * D; // user entered "2d from now"
      seedSession(db, 's1', turn);
      seedTurn(db, 't1', 's1', turn, 10, 10);

      const r = getQuotaResetEstimates(db, now, {
        calibratedReset7dAt: calibrated,
      });
      // Calibration wins — heuristic's +1d ignored.
      expect(r.reset7dMs).toBe(calibrated);
    });

    it('TC-I-12: calibrated 7d reset in the past auto-advances by +7d', () => {
      const now = 10_000_000_000;
      const staleCalibration = now - 3 * D; // was valid a week ago
      const r = getQuotaResetEstimates(db, now, {
        calibratedReset7dAt: staleCalibration,
      });
      // Auto-advance: stale + 7d = +4d from now.
      expect(r.reset7dMs).toBe(staleCalibration + 7 * D);
      // Must be in the future.
      if (r.reset7dMs !== null) expect(r.reset7dMs).toBeGreaterThan(now);
    });

    it('TC-I-13: calibrated 7d reset multiple cycles in the past auto-advances correctly', () => {
      const now = 10_000_000_000;
      const veryStale = now - 20 * D; // ~3 cycles in the past
      const r = getQuotaResetEstimates(db, now, {
        calibratedReset7dAt: veryStale,
      });
      // 20d = 2 full 7d cycles + 6d remainder. Advances 3× (until future).
      expect(r.reset7dMs).toBe(veryStale + 3 * 7 * D);
      if (r.reset7dMs !== null) expect(r.reset7dMs).toBeGreaterThan(now);
    });

    it('TC-I-14: calibrated null falls back to heuristic', () => {
      const now = 10_000_000_000;
      const turn = now - 3 * D;
      seedSession(db, 's1', turn);
      seedTurn(db, 't1', 's1', turn, 10, 10);

      const r = getQuotaResetEstimates(db, now, {
        calibratedReset7dAt: null,
      });
      expect(r.reset7dMs).toBe(turn + 7 * D);
    });

    it('TC-I-15: calibrated 5h reset overrides heuristic when future', () => {
      const now = 10_000_000_000;
      const turn = now - 2 * H;
      const calibrated = now + 41 * 60_000; // "Resets in 41m"
      seedSession(db, 's1', turn);
      seedTurn(db, 't1', 's1', turn, 10, 10);

      const r = getQuotaResetEstimates(db, now, {
        calibratedReset5hAt: calibrated,
      });
      // Calibration wins — heuristic's "+3h" ignored.
      expect(r.reset5hMs).toBe(calibrated);
    });

    it('TC-I-16: calibrated 5h reset in the past auto-advances by +5h', () => {
      const now = 10_000_000_000;
      const staleCal5h = now - 2 * H; // last block ended 2h ago
      const r = getQuotaResetEstimates(db, now, {
        calibratedReset5hAt: staleCal5h,
      });
      // Auto-advance: stale + 5h = +3h from now.
      expect(r.reset5hMs).toBe(staleCal5h + 5 * H);
      if (r.reset5hMs !== null) expect(r.reset5hMs).toBeGreaterThan(now);
    });

    it('TC-I-17: 5h calibrated null falls back to heuristic', () => {
      const now = 10_000_000_000;
      const turn = now - 1 * H;
      seedSession(db, 's1', turn);
      seedTurn(db, 't1', 's1', turn, 10, 10);

      const r = getQuotaResetEstimates(db, now, {
        calibratedReset5hAt: null,
      });
      expect(r.reset5hMs).toBe(turn + 5 * H);
    });
  });
});
