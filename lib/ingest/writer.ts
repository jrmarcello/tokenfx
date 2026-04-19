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
import { computeCost } from '@/lib/analytics/pricing';
import {
  getOtelCostBySession,
  getOtelCostForSession,
} from '@/lib/queries/otel';
import { recomputeCostCalibration } from '@/lib/queries/calibration';
import { deriveProjectName, listTranscriptFiles } from '@/lib/fs-paths';
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

export async function ingestAll(options?: {
  db?: Database;
  transcriptsRoot?: string;
  otelUrl?: string;
  fetchFn?: typeof fetch;
  otelTimeoutMs?: number;
  otelOptional?: boolean;
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

  const stmts = getStatements(db);
  let skippedUnchanged = 0;

  for (const file of files) {
    // Per-file gate: skip parsing when mtime hasn't advanced since our
    // last ingest of this exact path. Auto-ingest fires on every SSR
    // render, so without this gate a healthy dashboard re-parses every
    // .jsonl on every navigation.
    let mtimeMs: number | null = null;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      // Race with file removal between listing and stat; fall through to
      // the parser which will surface its own error.
    }
    if (mtimeMs !== null) {
      const prev = stmts.lookupIngestedFile.get(file) as
        | { mtime_ms: number }
        | undefined;
      if (prev && mtimeMs <= prev.mtime_ms) {
        skippedUnchanged += 1;
        continue;
      }
    }

    const result = parseTranscriptFile(file, (msg) => log.warn(msg));
    if (!result.ok) {
      summary.filesSkipped += 1;
      summary.errors.push({ file, error: result.error.message });
      continue;
    }
    try {
      writeSession(db, result.value, file);
      summary.filesProcessed += 1;
      summary.sessionsUpserted += 1;
      summary.turnsUpserted += result.value.turns.length;
      summary.toolCallsUpserted += result.value.turns.reduce(
        (acc, t) => acc + t.toolCalls.length,
        0,
      );
      if (mtimeMs !== null) {
        stmts.upsertIngestedFile.run(file, mtimeMs, Date.now());
      }
    } catch (err) {
      summary.filesSkipped += 1;
      summary.errors.push({
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Final sweep: update total_cost_usd_otel for any session whose OTEL
  // value differs from what's stored (covers sessions whose JSONL was
  // mtime-gated away but whose OTEL scrape arrived in this run).
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

  log.info(
    `[ingest] done: ${summary.filesProcessed} processed, ${skippedUnchanged} unchanged, ${summary.filesSkipped} skipped, ${summary.otelScrapes} otel rows, ${summary.otelCostsUpgraded} otel-cost upgrades, calibration ${summary.calibrationFamiliesWritten} families (${summary.calibrationSkipped} skipped), ${summary.errors.length} errors`,
  );

  return summary;
}
