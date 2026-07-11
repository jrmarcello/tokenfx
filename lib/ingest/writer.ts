import { statSync } from 'node:fs';
import type { Database, Statement } from 'better-sqlite3';
import { getDb } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';
import {
  parseTranscriptFile,
} from '@/lib/ingest/transcript/parser';
import type { ParsedSession } from '@/lib/ingest/transcript/types';
import { fetchAndParse, type OtelScrape } from '@/lib/ingest/otel/parser';
import { reconcileSession } from '@/lib/ingest/reconcile';
import { computeCost, warnIfUnknownModel } from '@/lib/analytics/pricing';
import {
  getOtelCostBySession,
  getOtelCostForSession,
} from '@/lib/queries/otel';
import { recomputeCostCalibration } from '@/lib/queries/calibration';
import { deriveProjectName, listTranscriptFiles } from '@/lib/fs-paths';
import {
  evaluateSessionOutcome,
  type EvaluatorSession,
} from '@/lib/ingest/git/evaluator';
import { log } from '@/lib/logger';

export type IngestSummary = {
  filesProcessed: number;
  filesSkipped: number;
  sessionsUpserted: number;
  turnsUpserted: number;
  toolCallsUpserted: number;
  otelScrapes: number;
  /** Sessions whose `total_cost_usd_otel` was set/updated from OTEL scrapes. */
  otelCostsUpgraded: number;
  /** Families (incl. 'global') written to `cost_calibration`. */
  calibrationFamiliesWritten: number;
  /** Family aggregates rejected (rate out of bounds or zero samples). */
  calibrationSkipped: number;
  errors: Array<{ file: string; error: string }>;
};

type Prepared = {
  insertSession: Statement;
  insertTurn: Statement;
  insertToolCall: Statement;
  insertCompactionEvent: Statement;
  insertOtel: Statement;
  lookupIngestedFile: Statement<[string]>;
  upsertIngestedFile: Statement<[string, number, number]>;
  updateSessionOtelCost: Statement<[number, string]>;
  readSessionOtelCost: Statement<[string]>;
};

const preparedCache = new WeakMap<Database, Prepared>();

function getStatements(db: Database): Prepared {
  let cached = preparedCache.get(db);
  if (cached) return cached;

  const insertSession = db.prepare(`
    INSERT INTO sessions (
      id, slug, cwd, project, git_branch, cc_version,
      started_at, ended_at,
      total_input_tokens, total_output_tokens,
      total_cache_read_tokens, total_cache_creation_tokens,
      total_cost_usd, turn_count, tool_call_count,
      source_file, ingested_at
    ) VALUES (
      @id, @slug, @cwd, @project, @git_branch, @cc_version,
      @started_at, @ended_at,
      @total_input_tokens, @total_output_tokens,
      @total_cache_read_tokens, @total_cache_creation_tokens,
      @total_cost_usd, @turn_count, @tool_call_count,
      @source_file, @ingested_at
    )
    ON CONFLICT(id) DO UPDATE SET
      slug = excluded.slug,
      cwd = excluded.cwd,
      project = excluded.project,
      git_branch = excluded.git_branch,
      cc_version = excluded.cc_version,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      total_input_tokens = excluded.total_input_tokens,
      total_output_tokens = excluded.total_output_tokens,
      total_cache_read_tokens = excluded.total_cache_read_tokens,
      total_cache_creation_tokens = excluded.total_cache_creation_tokens,
      total_cost_usd = excluded.total_cost_usd,
      turn_count = excluded.turn_count,
      tool_call_count = excluded.tool_call_count,
      source_file = excluded.source_file,
      ingested_at = excluded.ingested_at
  `);

  const insertTurn = db.prepare(`
    INSERT INTO turns (
      id, session_id, parent_uuid, sequence, timestamp, model,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
      cache_creation_5m_tokens, cache_creation_1h_tokens, service_tier,
      cost_usd, stop_reason, user_prompt, assistant_text, tool_uses_json
    ) VALUES (
      @id, @session_id, @parent_uuid, @sequence, @timestamp, @model,
      @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens,
      @cache_creation_5m_tokens, @cache_creation_1h_tokens, @service_tier,
      @cost_usd, @stop_reason, @user_prompt, @assistant_text, @tool_uses_json
    )
    ON CONFLICT(id) DO UPDATE SET
      session_id = excluded.session_id,
      parent_uuid = excluded.parent_uuid,
      sequence = excluded.sequence,
      timestamp = excluded.timestamp,
      model = excluded.model,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cache_creation_tokens = excluded.cache_creation_tokens,
      cache_creation_5m_tokens = excluded.cache_creation_5m_tokens,
      cache_creation_1h_tokens = excluded.cache_creation_1h_tokens,
      service_tier = excluded.service_tier,
      cost_usd = excluded.cost_usd,
      stop_reason = excluded.stop_reason,
      user_prompt = excluded.user_prompt,
      assistant_text = excluded.assistant_text,
      tool_uses_json = excluded.tool_uses_json
  `);

  const insertToolCall = db.prepare(`
    INSERT INTO tool_calls (
      id, turn_id, tool_name, input_json, result_json, result_is_error
    ) VALUES (
      @id, @turn_id, @tool_name, @input_json, @result_json, @result_is_error
    )
    ON CONFLICT(id) DO UPDATE SET
      turn_id = excluded.turn_id,
      tool_name = excluded.tool_name,
      input_json = excluded.input_json,
      result_json = excluded.result_json,
      result_is_error = excluded.result_is_error
  `);

  // Compaction events are stored as ROWS (not as a counter on `sessions`) so
  // re-ingest of any single source_file is naturally idempotent via the PK
  // (session_id, source_file, sequence_in_file). Multi-file sessions sum
  // correctly; re-ingest of an older rotated file does NOT double-count or
  // touch other files' rows. ON CONFLICT refreshes the mutable fields only.
  const insertCompactionEvent = db.prepare(`
    INSERT INTO compaction_events (
      session_id, source_file, sequence_in_file, trigger, pre_tokens, post_tokens, ts
    ) VALUES (
      @session_id, @source_file, @sequence_in_file, @trigger, @pre_tokens, @post_tokens, @ts
    )
    ON CONFLICT(session_id, source_file, sequence_in_file) DO UPDATE SET
      trigger = excluded.trigger,
      pre_tokens = excluded.pre_tokens,
      post_tokens = excluded.post_tokens,
      ts = excluded.ts
  `);

  // Dedup natural key is (metric_name, labels_json, scraped_at). Repeated
  // ingests of the same Prometheus scrape otherwise accumulate duplicate
  // rows — the MAX aggregation in queries masks them, but the table grows.
  const insertOtel = db.prepare(`
    INSERT INTO otel_scrapes (scraped_at, metric_name, labels_json, value)
    VALUES (@scraped_at, @metric_name, @labels_json, @value)
    ON CONFLICT(metric_name, labels_json, scraped_at) DO NOTHING
  `);

  const lookupIngestedFile = db.prepare(
    'SELECT mtime_ms FROM ingested_files WHERE path = ?',
  );

  const upsertIngestedFile = db.prepare(
    `INSERT INTO ingested_files (path, mtime_ms, ingested_at)
     VALUES (?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       mtime_ms = excluded.mtime_ms,
       ingested_at = excluded.ingested_at`,
  );

  const updateSessionOtelCost = db.prepare(
    'UPDATE sessions SET total_cost_usd_otel = ? WHERE id = ?',
  );

  const readSessionOtelCost = db.prepare(
    'SELECT total_cost_usd_otel AS v FROM sessions WHERE id = ?',
  );

  cached = {
    insertSession,
    insertTurn,
    insertToolCall,
    insertCompactionEvent,
    insertOtel,
    lookupIngestedFile,
    upsertIngestedFile,
    updateSessionOtelCost,
    readSessionOtelCost,
  };
  preparedCache.set(db, cached);
  return cached;
}

export function writeSession(
  db: Database,
  parsed: ParsedSession,
  sourceFile: string,
): void {
  const stmts = getStatements(db);

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;
  let totalCost = 0;
  let toolCallCount = 0;

  const turnRows = parsed.turns.map((t, idx) => {
    // Unknown model family → computeCost records $0. Surface it (once per
    // model per process) instead of letting zero-cost turns pile up silently.
    warnIfUnknownModel(t.model, { sessionId: parsed.id, turnId: t.id });
    const cost = computeCost({
      model: t.model,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      cacheReadTokens: t.cacheReadTokens,
      cacheCreation5mTokens: t.cacheCreation5mTokens,
      cacheCreation1hTokens: t.cacheCreation1hTokens,
      serviceTier: t.serviceTier,
    });
    totalInput += t.inputTokens;
    totalOutput += t.outputTokens;
    totalCacheRead += t.cacheReadTokens;
    totalCacheCreation += t.cacheCreationTokens;
    totalCost += cost;
    toolCallCount += t.toolCalls.length;
    return {
      id: t.id,
      session_id: parsed.id,
      parent_uuid: t.parentUuid,
      sequence: t.sequence ?? idx,
      timestamp: t.timestamp,
      model: t.model,
      input_tokens: t.inputTokens,
      output_tokens: t.outputTokens,
      cache_read_tokens: t.cacheReadTokens,
      cache_creation_tokens: t.cacheCreationTokens,
      cache_creation_5m_tokens: t.cacheCreation5mTokens,
      cache_creation_1h_tokens: t.cacheCreation1hTokens,
      service_tier: t.serviceTier,
      cost_usd: cost,
      stop_reason: t.stopReason,
      user_prompt: t.userPrompt,
      assistant_text: t.assistantText,
      tool_uses_json: JSON.stringify(
        t.toolCalls.map((tc) => ({ id: tc.id, name: tc.toolName })),
      ),
    };
  });

  const sessionRow = {
    id: parsed.id,
    slug: null as string | null,
    cwd: parsed.cwd,
    project: parsed.project ?? deriveProjectName(parsed.cwd),
    git_branch: parsed.gitBranch,
    cc_version: parsed.ccVersion,
    started_at: parsed.startedAt,
    ended_at: parsed.endedAt,
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    total_cache_read_tokens: totalCacheRead,
    total_cache_creation_tokens: totalCacheCreation,
    total_cost_usd: Math.round(totalCost * 1e6) / 1e6,
    turn_count: parsed.turns.length,
    tool_call_count: toolCallCount,
    source_file: sourceFile,
    ingested_at: Date.now(),
  };

  const toolCallRows: Array<{
    id: string;
    turn_id: string;
    tool_name: string;
    input_json: string;
    result_json: string | null;
    result_is_error: number;
  }> = [];
  for (const t of parsed.turns) {
    for (const tc of t.toolCalls) {
      toolCallRows.push({
        id: tc.id,
        turn_id: t.id,
        tool_name: tc.toolName,
        input_json: tc.inputJson,
        result_json: tc.resultJson,
        result_is_error: tc.resultIsError ? 1 : 0,
      });
    }
  }

  const tx = db.transaction(() => {
    stmts.insertSession.run(sessionRow);
    for (const row of turnRows) {
      stmts.insertTurn.run(row);
    }
    for (const row of toolCallRows) {
      stmts.insertToolCall.run(row);
    }
    // Compaction events are part of the same session-level transaction so a
    // failure anywhere rolls back the whole upsert (no half-written session).
    for (const event of parsed.compactionEvents) {
      stmts.insertCompactionEvent.run({
        session_id: parsed.id,
        source_file: sourceFile,
        sequence_in_file: event.sequence_in_file,
        trigger: event.trigger,
        pre_tokens: event.pre_tokens,
        post_tokens: event.post_tokens,
        ts: event.ts,
      });
    }
  });
  tx();

  // Sessions can span multiple JSONL files (sub-agents, transcript rotation).
  // After the upserts, renumber sequences chronologically and recompute
  // rollup columns from the actual stored rows so session.turn_count et al
  // reflect reality across all files — not just the last one ingested.
  reconcileSession(db, parsed.id);

  // If OTEL has already scraped this session, upgrade total_cost_usd_otel.
  // Scrapes from the current run are already in the DB because ingestAll
  // runs OTEL fetch/write BEFORE the JSONL loop.
  const otelCost = getOtelCostForSession(db, parsed.id);
  if (otelCost !== null && otelCost > 0) {
    stmts.updateSessionOtelCost.run(otelCost, parsed.id);
  }
}

export function writeOtelScrapes(db: Database, rows: OtelScrape[]): void {
  if (rows.length === 0) return;
  const stmts = getStatements(db);
  const tx = db.transaction(() => {
    for (const r of rows) {
      stmts.insertOtel.run({
        scraped_at: r.scrapedAt,
        metric_name: r.metricName,
        labels_json: JSON.stringify(r.labels),
        value: Number.isFinite(r.value) ? r.value : 0,
      });
    }
  });
  tx();
}

/**
 * Outcome of ingesting a single `.jsonl` file. Discriminated union so
 * callers (the ingestAll loop + the chokidar watcher) can handle each
 * branch without re-coding the per-file decision tree.
 *
 * - `processed`: parsed + written successfully; counts available.
 * - `skipped-unchanged`: file's mtime hasn't advanced since last ingest
 *   — the per-file gate via `ingested_files(path, mtime_ms)`.
 * - `skipped-error`: parse or write failed; `error` carries a short
 *   message suitable for a summary row.
 */
export type IngestSingleOutcome =
  | {
      kind: 'processed';
      sessionId: string;
      turnsUpserted: number;
      toolCallsUpserted: number;
    }
  | { kind: 'skipped-unchanged' }
  | { kind: 'skipped-error'; error: string };

/**
 * Ingest exactly one `.jsonl` file: checks the mtime gate, parses,
 * writes, and upserts the `ingested_files` bookkeeping row. Never
 * throws — errors funnel through the `skipped-error` branch so the
 * caller (loop, watcher) stays single-threaded on failure handling.
 */
export function ingestSingleFile(
  db: Database,
  absPath: string,
): IngestSingleOutcome {
  const stmts = getStatements(db);

  let mtimeMs: number | null = null;
  try {
    mtimeMs = statSync(absPath).mtimeMs;
  } catch {
    // Race with file removal between listing and stat; fall through to
    // the parser which will surface its own error.
  }
  if (mtimeMs !== null) {
    const prev = stmts.lookupIngestedFile.get(absPath) as
      | { mtime_ms: number }
      | undefined;
    if (prev && mtimeMs <= prev.mtime_ms) {
      return { kind: 'skipped-unchanged' };
    }
  }

  const result = parseTranscriptFile(absPath, (msg) => log.warn(msg));
  if (!result.ok) {
    return { kind: 'skipped-error', error: result.error.message };
  }
  try {
    writeSession(db, result.value, absPath);
    if (mtimeMs !== null) {
      stmts.upsertIngestedFile.run(absPath, mtimeMs, Date.now());
    }
    const toolCallsUpserted = result.value.turns.reduce(
      (acc, t) => acc + t.toolCalls.length,
      0,
    );
    return {
      kind: 'processed',
      sessionId: result.value.id,
      turnsUpserted: result.value.turns.length,
      toolCallsUpserted,
    };
  } catch (err) {
    return {
      kind: 'skipped-error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function ingestAll(options?: {
  db?: Database;
  transcriptsRoot?: string;
  otelUrl?: string;
  fetchFn?: typeof fetch;
  otelTimeoutMs?: number;
  otelOptional?: boolean;
  /**
   * When true, bypass the 30-day cutoff in the outcome sweep and re-evaluate
   * EVERY session in the DB, regardless of `last_evaluated_at`. Wired from
   * `pnpm ingest --force-outcomes` via `scripts/ingest.ts` (REQ-13).
   */
  forceOutcomes?: boolean;
}): Promise<IngestSummary> {
  const db = options?.db ?? getDb();
  migrate(db);

  const summary: IngestSummary = {
    filesProcessed: 0,
    filesSkipped: 0,
    sessionsUpserted: 0,
    turnsUpserted: 0,
    toolCallsUpserted: 0,
    otelScrapes: 0,
    otelCostsUpgraded: 0,
    calibrationFamiliesWritten: 0,
    calibrationSkipped: 0,
    errors: [],
  };

  // OTEL FIRST: fetch + persist scrapes before JSONL processing so
  // writeSession's per-session upgrade finds the current-run data.
  if (options?.otelUrl) {
    const otelResult = await fetchAndParse(options.otelUrl, options.fetchFn, {
      timeoutMs: options.otelTimeoutMs,
    });
    if (otelResult.ok) {
      writeOtelScrapes(db, otelResult.value);
      summary.otelScrapes = otelResult.value.length;
    } else if (!options.otelOptional) {
      summary.errors.push({
        file: options.otelUrl,
        error: otelResult.error.message,
      });
    }
  }

  const files = await listTranscriptFiles(options?.transcriptsRoot);
  log.info(`[ingest] found ${files.length} transcript file(s)`);

  let skippedUnchanged = 0;
  for (const file of files) {
    const outcome = ingestSingleFile(db, file);
    if (outcome.kind === 'skipped-unchanged') skippedUnchanged += 1;
    else if (outcome.kind === 'skipped-error') {
      summary.filesSkipped += 1;
      summary.errors.push({ file, error: outcome.error });
    } else {
      summary.filesProcessed += 1;
      summary.sessionsUpserted += 1;
      summary.turnsUpserted += outcome.turnsUpserted;
      summary.toolCallsUpserted += outcome.toolCallsUpserted;
    }
  }

  // Final sweep: update total_cost_usd_otel for any session whose OTEL
  // value differs from what's stored (covers sessions whose JSONL was
  // mtime-gated away but whose OTEL scrape arrived in this run).
  const stmts = getStatements(db);
  const otelMap = getOtelCostBySession(db);
  const sweepTx = db.transaction(() => {
    for (const [sessionId, cost] of otelMap) {
      const existing = stmts.readSessionOtelCost.get(sessionId) as
        | { v: number | null }
        | undefined;
      if (!existing) continue; // session doesn't exist — skip
      if (existing.v === cost) continue;
      stmts.updateSessionOtelCost.run(cost, sessionId);
      summary.otelCostsUpgraded += 1;
    }
  });
  sweepTx();

  // Learned calibration from OTEL-bearing sessions.
  const calib = recomputeCostCalibration(db);
  summary.calibrationFamiliesWritten = calib.familiesWritten;
  summary.calibrationSkipped = calib.skippedOutOfBounds;

  // Outcome sweep — REQ-12. Re-evaluate sessions whose `last_evaluated_at`
  // is missing OR older than the session's `ended_at`. By default the
  // sweep is bounded to the last 30 days; `forceOutcomes` removes that
  // guard so older sessions are re-checked too (REQ-13). Each evaluation
  // runs in its own try/catch — a single session's git failure must not
  // abort the sweep.
  runOutcomeSweep(db, { forceOutcomes: options?.forceOutcomes ?? false });

  log.info(
    `[ingest] done: ${summary.filesProcessed} processed, ${skippedUnchanged} unchanged, ${summary.filesSkipped} skipped, ${summary.otelScrapes} otel rows, ${summary.otelCostsUpgraded} otel-cost upgrades, calibration ${summary.calibrationFamiliesWritten} families (${summary.calibrationSkipped} skipped), ${summary.errors.length} errors`,
  );

  return summary;
}

/**
 * Outcome-sweep SQL variants. Hoisted to module-level so the strings are
 * not re-allocated per call, and prepared lazily via `getSweepPrepared`
 * (REQ-16, C-7). Both variants share the same column projection; only the
 * WHERE clause's date guard differs.
 */
const OUTCOME_SWEEP_FORCE_SQL = `SELECT s.id AS id, s.cwd AS cwd, s.started_at AS started_at, s.ended_at AS ended_at
       FROM sessions s
       LEFT JOIN session_outcomes so ON so.session_id = s.id
       WHERE so.last_evaluated_at IS NULL OR so.last_evaluated_at < s.ended_at`;

const OUTCOME_SWEEP_WITH_CUTOFF_SQL = `SELECT s.id AS id, s.cwd AS cwd, s.started_at AS started_at, s.ended_at AS ended_at
       FROM sessions s
       LEFT JOIN session_outcomes so ON so.session_id = s.id
       WHERE (so.last_evaluated_at IS NULL OR so.last_evaluated_at < s.ended_at)
         AND s.ended_at >= ?`;

type OutcomeSweepPrepared = Readonly<{
  force: Statement;
  withCutoff: Statement<[number]>;
}>;

const outcomeSweepCache = new WeakMap<Database, OutcomeSweepPrepared>();

const getOutcomeSweepPrepared = (db: Database): OutcomeSweepPrepared => {
  let cached = outcomeSweepCache.get(db);
  if (cached) return cached;
  cached = {
    force: db.prepare(OUTCOME_SWEEP_FORCE_SQL),
    withCutoff: db.prepare(OUTCOME_SWEEP_WITH_CUTOFF_SQL),
  };
  outcomeSweepCache.set(db, cached);
  return cached;
};

/**
 * Test-only probe: returns 2 once the outcome-sweep cache holds both
 * prepared statements for `db`, 0 otherwise. The `__` prefix marks this as
 * internal — production code must not depend on it. See TC-I-13 (REQ-16).
 */
export const __getOutcomeSweepPrepareCount = (db: Database): number =>
  outcomeSweepCache.has(db) ? 2 : 0;

/**
 * Execute the outcome sweep at the end of `ingestAll` (REQ-12). Selects
 * sessions whose outcome row is stale or missing and runs the git evaluator
 * for each. Failures are isolated per-session: an exception inside
 * `evaluateSessionOutcome` is caught and logged so the sweep continues.
 *
 * - Default: only sessions with `ended_at >= now - 30d` are considered.
 * - `forceOutcomes: true`: 30d guard removed; every stale/missing-outcome
 *   session is re-evaluated regardless of age (REQ-13).
 *
 * The candidate predicate is identical in both modes:
 *   `session_outcomes.last_evaluated_at IS NULL OR
 *    session_outcomes.last_evaluated_at < sessions.ended_at`
 * (a missing row is implicitly stale via the LEFT JOIN).
 *
 * Prepared statements are cached per-DB in a module-level WeakMap so
 * repeated calls don't re-prepare the SQL (REQ-16, C-7).
 */
const runOutcomeSweep = (
  db: Database,
  opts: { forceOutcomes: boolean },
): void => {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const prep = getOutcomeSweepPrepared(db);
  const rows = (
    opts.forceOutcomes ? prep.force.all() : prep.withCutoff.all(cutoff)
  ) as ReadonlyArray<EvaluatorSession>;

  let evaluated = 0;
  let failed = 0;
  for (const session of rows) {
    try {
      evaluateSessionOutcome(db, session);
      evaluated += 1;
    } catch (err) {
      failed += 1;
      // Per-session try/catch (REQ-12). Log session id only — never
      // commit messages or diff bodies (REQ-17 PII rule).
      log.warn('[outcome-sweep] failed', {
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info(
    `[outcome-sweep] evaluated ${evaluated} session(s)${failed > 0 ? `, ${failed} failed` : ''}${
      opts.forceOutcomes ? ' (force)' : ''
    }`,
  );
};

/**
 * Test-only alias for `runOutcomeSweep`. The `__` prefix signals internal
 * usage — production callers go through `ingestAll`. Exposed so TC-I-13
 * (REQ-16) can drive the sweep directly without spinning up a full ingest.
 */
export const __runOutcomeSweep = runOutcomeSweep;
