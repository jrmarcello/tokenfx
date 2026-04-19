#!/usr/bin/env node
/**
 * Recompute `turns.cost_usd` using the current pricing table and reconcile
 * `sessions.total_cost_usd` rollups. Useful after a pricing fix (new family
 * fallback, new model added) when historical turns are frozen at wrong costs
 * because re-ingesting isn't an option (transcripts rotate/vanish).
 *
 * Idempotent. Safe to run repeatedly — only writes when the rounded new
 * cost differs from the stored value.
 */
import { getDb } from '@/lib/db/client';
import { computeCost } from '@/lib/analytics/pricing';
import { reconcileAllSessions } from '@/lib/ingest/reconcile';
import { log } from '@/lib/logger';

type TurnRow = {
  id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
};

function main(): void {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, model, input_tokens, output_tokens,
              cache_read_tokens, cache_creation_tokens, cost_usd
       FROM turns`,
    )
    .all() as TurnRow[];

  const update = db.prepare('UPDATE turns SET cost_usd = ? WHERE id = ?');

  let updated = 0;
  let unchanged = 0;
  let zeroedBefore = 0;
  let zeroedAfter = 0;

  const tx = db.transaction(() => {
    for (const r of rows) {
      const newCost = computeCost({
        model: r.model,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        cacheReadTokens: r.cache_read_tokens,
        cacheCreationTokens: r.cache_creation_tokens,
      });
      const rounded = Math.round(newCost * 1e6) / 1e6;
      if (r.cost_usd === 0) zeroedBefore += 1;
      if (rounded === 0) zeroedAfter += 1;
      if (Math.abs(rounded - r.cost_usd) > 5e-7) {
        update.run(rounded, r.id);
        updated += 1;
      } else {
        unchanged += 1;
      }
    }
  });
  tx();

  reconcileAllSessions(db);

  log.info('recompute-costs', {
    total: rows.length,
    updated,
    unchanged,
    zeroedBefore,
    zeroedAfter,
  });
}

main();
