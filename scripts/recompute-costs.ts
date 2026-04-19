#!/usr/bin/env node
/**
 * Recompute cost data on the local DB.
 *
 * Two modes:
 *
 * 1. **default** (no flag): recompute `turns.cost_usd` using the current
 *    pricing table and reconcile `sessions.total_cost_usd` rollups. Useful
 *    after a pricing fix (new family fallback, new model added) when
 *    historical turns are frozen at wrong costs because re-ingesting isn't
 *    an option (transcripts rotate/vanish). `sessions.total_cost_usd_otel`
 *    is never touched.
 *
 * 2. **`--prefer-otel`**: skip the turn-level recompute. Populate
 *    `sessions.total_cost_usd_otel` from the authoritative
 *    `claude_code_cost_usage_total` scrapes captured in `otel_scrapes`
 *    (via `getOtelCostBySession`). Only writes when the stored value
 *    differs from the new one, so re-runs are zero-update.
 *
 * Both modes are idempotent. The core logic is exported as
 * `recomputeCosts({ preferOtel })` so tests can exercise it without
 * spawning a child process; `main()` only runs when this file is invoked
 * directly as a script.
 */
import { fileURLToPath } from 'node:url';
import { getDb } from '@/lib/db/client';
import { computeCost } from '@/lib/analytics/pricing';
import { reconcileAllSessions } from '@/lib/ingest/reconcile';
import { getOtelCostBySession } from '@/lib/queries/otel';
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

export type RecomputeSummary =
  | {
      mode: 'default';
      total: number;
      updated: number;
      unchanged: number;
      zeroedBefore: number;
      zeroedAfter: number;
    }
  | {
      mode: 'prefer-otel';
      totalOtelSessions: number;
      updatedOtelCosts: number;
      unchangedOtelCosts: number;
    };

const recomputeTurnsDefault = (): RecomputeSummary => {
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

  return {
    mode: 'default',
    total: rows.length,
    updated,
    unchanged,
    zeroedBefore,
    zeroedAfter,
  };
};

const recomputeOtelCosts = (): RecomputeSummary => {
  const db = getDb();
  const otelCosts = getOtelCostBySession(db);

  // Pre-load existing stored values so we can skip no-op writes (keeps
  // the flag idempotent — second run reports 0 updates).
  const storedRows = db
    .prepare('SELECT id, total_cost_usd_otel FROM sessions')
    .all() as Array<{ id: string; total_cost_usd_otel: number | null }>;
  const stored = new Map<string, number | null>();
  for (const r of storedRows) {
    stored.set(r.id, r.total_cost_usd_otel);
  }

  const update = db.prepare(
    'UPDATE sessions SET total_cost_usd_otel = ? WHERE id = ?',
  );

  let updatedOtelCosts = 0;
  let unchangedOtelCosts = 0;

  // Values from OTEL carry float precision artifacts; compare at the
  // same tolerance used by the turn-level path (~0.5µ-USD).
  const EPS = 5e-7;

  const tx = db.transaction(() => {
    for (const [sessionId, cost] of otelCosts) {
      if (!stored.has(sessionId)) {
        // Session row doesn't exist yet — leave for the ingest path.
        continue;
      }
      const current = stored.get(sessionId) ?? null;
      if (current !== null && Math.abs(current - cost) <= EPS) {
        unchangedOtelCosts += 1;
        continue;
      }
      update.run(cost, sessionId);
      updatedOtelCosts += 1;
    }
  });
  tx();

  return {
    mode: 'prefer-otel',
    totalOtelSessions: otelCosts.size,
    updatedOtelCosts,
    unchangedOtelCosts,
  };
};

export function recomputeCosts(opts: {
  preferOtel: boolean;
}): RecomputeSummary {
  return opts.preferOtel ? recomputeOtelCosts() : recomputeTurnsDefault();
}

const parseArgs = (argv: readonly string[]): { preferOtel: boolean } => ({
  preferOtel: argv.includes('--prefer-otel'),
});

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const summary = recomputeCosts(opts);
  log.info('recompute-costs', summary);
}

// Only run `main()` when this file is the process entry point (not when
// imported by tests). `fileURLToPath(import.meta.url)` ≙ argv[1] when
// the script is invoked directly (via `tsx scripts/recompute-costs.ts`).
const invokedAsScript =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (invokedAsScript) {
  main();
}
