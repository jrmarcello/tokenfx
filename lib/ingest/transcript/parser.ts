import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { correctionPenalties } from '@/lib/analytics/scoring';
import {
  AssistantMessageSchema,
  TranscriptLineSchema,
  UserMessageSchema,
  type ParsedSession,
  type ParsedToolCall,
  type ParsedTurn,
  type Result,
  type TranscriptLine,
} from './types';

// Local schema for the tool_result sub-shape of UserContentBlock. The union
// in types.ts isn't a discriminatedUnion (the third passthrough arm accepts
// any type:string), so TS can't narrow on block.type alone. safeParsing
// here gives us typed access to tool_use_id/content/is_error without a cast.
const ToolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.unknown().optional(),
  is_error: z.boolean().optional(),
});

// Claude Code's .jsonl transcripts interleave model turns with many
// infrastructure event types (`permission-mode`, `file-history-snapshot`,
// `queue-operation`, `todo`, …) that don't carry `uuid`/`sessionId`/
// `timestamp`. Downstream parsing only ever reads `user` and `assistant`
// entries — those plus their required fields are the real boundary we
// want Zod to enforce. Whitelisting by type before the schema check
// keeps the strict validation focused where it matters: a malformed
// user/assistant entry still surfaces a warn (real data problem),
// while new infra types added by future Claude Code releases are
// skipped silently without this list needing maintenance.
const CONSUMED_TYPES = new Set<string>(['user', 'assistant']);

type WarnFn = (msg: string) => void;
const noopWarn: WarnFn = () => {};

export function parseTranscriptFile(
  filePath: string,
  onWarn: WarnFn = noopWarn,
): Result<ParsedSession, Error> {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return parseTranscriptString(content, filePath, onWarn);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
  }
}

export function parseTranscriptString(
  content: string,
  sourcePath?: string,
  onWarn: WarnFn = noopWarn,
): Result<ParsedSession, Error> {
  const warn = onWarn;
  const rawLines = content.split('\n');
  const entries: TranscriptLine[] = [];

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i].trim();
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      warn(
        `[transcript] line ${i + 1}${sourcePath ? ` of ${sourcePath}` : ''}: invalid JSON (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      continue;
    }

    const typeField = (parsed as { type?: unknown } | null)?.type;
    if (typeof typeField !== 'string' || !CONSUMED_TYPES.has(typeField)) {
      continue;
    }
    const result = TranscriptLineSchema.safeParse(parsed);
    if (!result.success) {
      warn(`[transcript] line ${i + 1}: schema mismatch (${result.error.message})`);
      continue;
    }
    entries.push(result.data);
  }

  if (entries.length === 0) {
    return { ok: false, error: new Error('No valid transcript lines found') };
  }

  // Session id consistency
  let sessionId: string | null = null;
  for (const e of entries) {
    if (sessionId === null) sessionId = e.sessionId;
    else if (e.sessionId !== sessionId) {
      return {
        ok: false,
        error: new Error(
          `Inconsistent sessionId across lines: ${sessionId} vs ${e.sessionId}`,
        ),
      };
    }
  }
  if (!sessionId) {
    return { ok: false, error: new Error('No sessionId found in transcript') };
  }

  // tool_result map: tool_use_id -> { content, is_error }
  const toolResultMap = new Map<
    string,
    { content: unknown; isError: boolean }
  >();
  for (const e of entries) {
    if (e.type !== 'user') continue;
    const msg = UserMessageSchema.safeParse(e.message);
    if (!msg.success) continue;
    if (typeof msg.data.content === 'string') continue;
    for (const block of msg.data.content) {
      const tr = ToolResultBlockSchema.safeParse(block);
      if (!tr.success) continue;
      toolResultMap.set(tr.data.tool_use_id, {
        content: tr.data.content,
        isError: tr.data.is_error === true,
      });
    }
  }

  // Build turns from assistant entries (in file order). `sequence` is left
  // null here — a session can span multiple JSONL files (sub-agents, rotation)
  // and per-file numbering would collide. The writer's reconcile pass assigns
  // 1..N chronologically after all files are ingested.
  const turns: ParsedTurn[] = [];
  for (let idx = 0; idx < entries.length; idx++) {
    const e = entries[idx];
    if (e.type !== 'assistant') continue;
    const msg = AssistantMessageSchema.safeParse(e.message);
    if (!msg.success) {
      warn(`[transcript] assistant line ${e.uuid}: invalid message (${msg.error.message})`);
      continue;
    }

    const textParts: string[] = [];
    const toolCalls: ParsedToolCall[] = [];
    for (const block of msg.data.content) {
      if (block.type === 'text' && 'text' in block) {
        textParts.push(block.text as string);
      } else if (block.type === 'tool_use' && 'id' in block && 'name' in block) {
        const tu = block as { id: string; name: string; input: unknown };
        const linked = toolResultMap.get(tu.id);
        toolCalls.push({
          id: tu.id,
          toolName: tu.name,
          inputJson: JSON.stringify(tu.input ?? null),
          resultJson: linked ? JSON.stringify(linked.content ?? null) : null,
          resultIsError: linked ? linked.isError : false,
        });
      }
    }

    // find the most recent user prompt (plain text) before this assistant entry
    let userPrompt: string | null = null;
    for (let j = idx - 1; j >= 0; j--) {
      const prev = entries[j];
      if (prev.type !== 'user') continue;
      const pm = UserMessageSchema.safeParse(prev.message);
      if (!pm.success) continue;
      if (typeof pm.data.content === 'string') {
        userPrompt = pm.data.content;
        break;
      }
      // array: skip lines that are tool_result-only
      const hasToolResult = pm.data.content.some((b) => b.type === 'tool_result');
      if (hasToolResult) continue;
      const textOnly = pm.data.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && 'text' in b)
        .map((b) => b.text)
        .join('\n');
      if (textOnly.length > 0) {
        userPrompt = textOnly;
        break;
      }
    }

    const usage = (msg.data.usage ?? {}) as Record<string, unknown>;
    // REQ-12 priority: split (cache_creation.ephemeral_*) > legacy aggregate > zero.
    // Never sum the two. When split has at least one of its sub-fields set
    // (including as 0), split wins; legacy is ignored entirely.
    const split = usage.cache_creation as
      | {
          ephemeral_5m_input_tokens?: number;
          ephemeral_1h_input_tokens?: number;
        }
      | undefined;
    const legacyAggregate =
      typeof usage.cache_creation_input_tokens === 'number'
        ? (usage.cache_creation_input_tokens as number)
        : undefined;
    let cacheCreation5mTokens = 0;
    let cacheCreation1hTokens = 0;
    let cacheCreationAggregate = 0;
    if (split !== undefined) {
      cacheCreation5mTokens = split.ephemeral_5m_input_tokens ?? 0;
      cacheCreation1hTokens = split.ephemeral_1h_input_tokens ?? 0;
      cacheCreationAggregate = cacheCreation5mTokens + cacheCreation1hTokens;
    } else if (legacyAggregate !== undefined) {
      cacheCreation5mTokens = legacyAggregate;
      cacheCreationAggregate = legacyAggregate;
    }
    const serviceTier =
      typeof usage.service_tier === 'string' ? (usage.service_tier as string) : 'standard';
    turns.push({
      id: e.uuid,
      parentUuid: e.parentUuid ?? null,
      sequence: null,
      timestamp: Date.parse(e.timestamp),
      model: msg.data.model,
      inputTokens:
        typeof usage.input_tokens === 'number' ? (usage.input_tokens as number) : 0,
      outputTokens:
        typeof usage.output_tokens === 'number' ? (usage.output_tokens as number) : 0,
      cacheReadTokens:
        typeof usage.cache_read_input_tokens === 'number'
          ? (usage.cache_read_input_tokens as number)
          : 0,
      cacheCreationTokens: cacheCreationAggregate,
      cacheCreation5mTokens,
      cacheCreation1hTokens,
      serviceTier,
      stopReason: msg.data.stop_reason ?? null,
      userPrompt,
      assistantText: textParts.length > 0 ? textParts.join('\n') : null,
      toolCalls,
    });
  }

  const timestamps = entries
    .map((e) => Date.parse(e.timestamp))
    .filter((n) => !Number.isNaN(n));
  const startedAt = timestamps.length > 0 ? Math.min(...timestamps) : 0;
  const endedAt = timestamps.length > 0 ? Math.max(...timestamps) : 0;

  const firstWithCwd = entries.find((e) => typeof e.cwd === 'string' && e.cwd.length > 0);
  const cwd = firstWithCwd?.cwd ?? '';
  const project = cwd ? path.basename(cwd) : '';

  const firstWithBranch = entries.find(
    (e) => typeof e.gitBranch === 'string' && e.gitBranch.length > 0,
  );
  const gitBranch = firstWithBranch?.gitBranch ?? null;

  const firstWithVersion = entries.find(
    (e) => typeof e.version === 'string' && e.version.length > 0,
  );
  const ccVersion = firstWithVersion?.version ?? null;

  return {
    ok: true,
    value: {
      id: sessionId,
      cwd,
      project,
      gitBranch,
      ccVersion,
      startedAt,
      endedAt,
      turns,
    },
  };
}

/**
 * Re-export of the correction heuristic from the analytics module, kept under
 * its legacy name so transcript-layer callers don't need to reach into
 * analytics. The regex and scoring logic live in `lib/analytics/scoring.ts`.
 */
export function detectCorrectionPenalty(
  turns: ParsedTurn[],
): Map<string, number> {
  return correctionPenalties(turns);
}
