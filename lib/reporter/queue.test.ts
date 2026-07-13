import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openQueue, type Queue } from './queue';
import type { SanitizedSessionPayload } from '@tokenfx/shared/reporter/types';
import { log } from '@tokenfx/shared/logger';

// ---------- Helpers ----------

const basePayload = (sessionId = 'sess-1'): SanitizedSessionPayload => ({
  session_id: sessionId,
  started_at: 1_700_000_000_000,
  ended_at: 1_700_000_001_000,
  project_slug: 'slug:0123456789abcdef',
  git_branch: 'main',
  cc_version: '1.2.3',
  total_input_tokens: 1000,
  total_output_tokens: 500,
  total_cache_read_tokens: 200,
  total_cache_creation_tokens: 100,
  total_cost_usd: 0.05,
  total_cost_usd_otel: 0.045,
  turn_count: 10,
  tool_call_count: 25,
  model_breakdown: [
    {
      model: 'claude-sonnet-4',
      input_tokens: 800,
      output_tokens: 400,
      cache_read_tokens: 100,
      cache_creation_tokens: 50,
      cost_usd: 0.04,
    },
  ],
  tool_counts: { Edit: 12, Read: 30 },
  avg_rating: 0.5,
  cache_hit_ratio: 0.2,
  output_input_ratio: 0.5,
  subagent_usage_ratio: 0.1,
});

const fakeHash = (s: string): string => `hash:${s}`;

// ---------- Suite ----------

describe('reporter queue', () => {
  let queue: Queue;

  beforeEach(() => {
    queue = openQueue(':memory:');
  });

  afterEach(() => {
    queue.close();
  });

  describe('enqueue + size', () => {
    it('starts empty', () => {
      expect(queue.size()).toBe(0);
    });

    it('size grows by 1 per enqueue', () => {
      queue.enqueue(basePayload('s-1'), fakeHash('s-1'));
      queue.enqueue(basePayload('s-2'), fakeHash('s-2'));
      expect(queue.size()).toBe(2);
    });

    it('persists payload as JSON-serialised blob and round-trips through dequeue', () => {
      const p = basePayload('s-roundtrip');
      queue.enqueue(p, fakeHash('s-roundtrip'));
      const [entry] = queue.dequeueOldest(1);
      expect(entry).toBeDefined();
      expect(entry.payload).toEqual(p);
      expect(entry.sessionId).toBe('s-roundtrip');
      expect(entry.payloadHash).toBe(fakeHash('s-roundtrip'));
      expect(entry.attemptCount).toBe(0);
      expect(entry.lastError).toBeNull();
      expect(typeof entry.createdAt).toBe('number');
    });
  });

  describe('TC-I-06 (REQ-9, happy): server unreachable for 3 push cycles', () => {
    it('queue grows to 3 entries; on connectivity, all drained oldest-first', () => {
      // Simulate 3 failed push cycles by enqueueing 3 entries.
      queue.enqueue(basePayload('cycle-1'), fakeHash('cycle-1'));
      queue.enqueue(basePayload('cycle-2'), fakeHash('cycle-2'));
      queue.enqueue(basePayload('cycle-3'), fakeHash('cycle-3'));

      expect(queue.size()).toBe(3);

      // Drain — oldest first (insertion order).
      const drained = queue.dequeueOldest(3);
      expect(drained.map((e) => e.sessionId)).toEqual([
        'cycle-1',
        'cycle-2',
        'cycle-3',
      ]);
      // Lowest id first (AUTOINCREMENT preserves insertion order).
      expect(drained[0].id).toBeLessThan(drained[1].id);
      expect(drained[1].id).toBeLessThan(drained[2].id);
    });
  });

  describe('TC-I-07 (REQ-9, edge): cap at 10,000 entries', () => {
    it('enqueueing the 10,001st entry drops the oldest, logs warn, keeps size at 10,000', () => {
      const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});

      // Fill to capacity.
      for (let i = 0; i < 10_000; i++) {
        queue.enqueue(basePayload(`s-${i}`), fakeHash(`s-${i}`));
      }
      expect(queue.size()).toBe(10_000);
      expect(warnSpy).not.toHaveBeenCalled();

      const firstBefore = queue.dequeueOldest(1)[0];
      // Put it back to keep capacity at 10,000 for the cap test.
      queue.remove([firstBefore.id]);
      queue.enqueue(basePayload('s-0-replay'), fakeHash('s-0-replay'));
      expect(queue.size()).toBe(10_000);

      // Push the overflow entry.
      queue.enqueue(basePayload('overflow'), fakeHash('overflow'));

      expect(queue.size()).toBe(10_000);
      expect(warnSpy).toHaveBeenCalledWith(
        '[reporter-queue] dropped oldest entry (max 10000)',
      );
      expect(warnSpy).toHaveBeenCalledTimes(1);

      // The original first-inserted id is gone.
      const firstAfter = queue.dequeueOldest(1)[0];
      expect(firstAfter.id).toBeGreaterThan(firstBefore.id);

      warnSpy.mockRestore();
    });

    it('respects custom maxEntries option', () => {
      const small = openQueue(':memory:', { maxEntries: 3 });
      const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});

      small.enqueue(basePayload('a'), fakeHash('a'));
      small.enqueue(basePayload('b'), fakeHash('b'));
      small.enqueue(basePayload('c'), fakeHash('c'));
      small.enqueue(basePayload('d'), fakeHash('d')); // triggers drop of 'a'

      expect(small.size()).toBe(3);
      expect(warnSpy).toHaveBeenCalledWith(
        '[reporter-queue] dropped oldest entry (max 3)',
      );

      const drained = small.dequeueOldest(10);
      expect(drained.map((e) => e.sessionId)).toEqual(['b', 'c', 'd']);

      warnSpy.mockRestore();
      small.close();
    });
  });

  describe('dequeueOldest', () => {
    it('returns empty array when queue is empty', () => {
      expect(queue.dequeueOldest(10)).toEqual([]);
    });

    it('returns up to `limit` rows', () => {
      for (let i = 0; i < 5; i++) {
        queue.enqueue(basePayload(`s-${i}`), fakeHash(`s-${i}`));
      }
      const rows = queue.dequeueOldest(3);
      expect(rows.length).toBe(3);
      expect(rows.map((r) => r.sessionId)).toEqual(['s-0', 's-1', 's-2']);
    });

    it('does not delete rows (peek semantics — caller must call remove)', () => {
      queue.enqueue(basePayload('a'), fakeHash('a'));
      queue.dequeueOldest(10);
      expect(queue.size()).toBe(1);
    });
  });

  describe('remove', () => {
    it('deletes specified ids', () => {
      queue.enqueue(basePayload('a'), fakeHash('a'));
      queue.enqueue(basePayload('b'), fakeHash('b'));
      const rows = queue.dequeueOldest(10);
      queue.remove([rows[0].id]);
      expect(queue.size()).toBe(1);
      const remaining = queue.dequeueOldest(10);
      expect(remaining[0].sessionId).toBe('b');
    });

    it('is a no-op for empty id list', () => {
      queue.enqueue(basePayload('a'), fakeHash('a'));
      queue.remove([]);
      expect(queue.size()).toBe(1);
    });

    it('silently skips ids that do not exist', () => {
      queue.enqueue(basePayload('a'), fakeHash('a'));
      queue.remove([99999]);
      expect(queue.size()).toBe(1);
    });
  });

  describe('recordFailure', () => {
    it('increments attempt_count and stores last_error', () => {
      queue.enqueue(basePayload('a'), fakeHash('a'));
      const [entry] = queue.dequeueOldest(1);
      queue.recordFailure(entry.id, 'ECONNREFUSED');
      const [updated] = queue.dequeueOldest(1);
      expect(updated.attemptCount).toBe(1);
      expect(updated.lastError).toBe('ECONNREFUSED');
    });

    it('increments on repeated failures', () => {
      queue.enqueue(basePayload('a'), fakeHash('a'));
      const [entry] = queue.dequeueOldest(1);
      queue.recordFailure(entry.id, 'err1');
      queue.recordFailure(entry.id, 'err2');
      const [updated] = queue.dequeueOldest(1);
      expect(updated.attemptCount).toBe(2);
      expect(updated.lastError).toBe('err2');
    });
  });

  describe('reset', () => {
    it('drops all rows', () => {
      queue.enqueue(basePayload('a'), fakeHash('a'));
      queue.enqueue(basePayload('b'), fakeHash('b'));
      queue.reset();
      expect(queue.size()).toBe(0);
    });

    it('preserves table after reset (re-creates schema)', () => {
      queue.enqueue(basePayload('a'), fakeHash('a'));
      queue.reset();
      // Should still be usable.
      queue.enqueue(basePayload('b'), fakeHash('b'));
      expect(queue.size()).toBe(1);
    });
  });
});
