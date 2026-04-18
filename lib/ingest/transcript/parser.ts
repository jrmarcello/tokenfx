import fs from 'node:fs';
import path from 'node:path';
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
      if (block.type === 'tool_result') {
        const b = block as {
          type: 'tool_result';
          tool_use_id: string;
          content?: unknown;
          is_error?: boolean;
        };
        toolResultMap.set(b.tool_use_id, {
          content: b.content,
          isError: b.is_error === true,
        });
      }
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

    const usage = msg.data.usage ?? {};
    turns.push({
      id: e.uuid,
      parentUuid: e.parentUuid ?? null,
      sequence: null,
      timestamp: Date.parse(e.timestamp),
      model: msg.data.model,
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
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
