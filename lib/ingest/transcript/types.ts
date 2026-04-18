import { z } from 'zod';

/**
 * Result type mirrors `lib/db/types.ts`. Intentionally redefined here so this
 * parser stays independent of the database module.
 */
export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

// --------- Boundary schemas (Zod) -----------------------------------------

const AssistantContentBlockSchema = z.union([
  z.object({
    type: z.literal('text'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  // permissive fallback for unknown block types
  z.object({ type: z.string() }).passthrough(),
]);

export const AssistantMessageSchema = z.object({
  id: z.string().optional(),
  role: z.literal('assistant'),
  model: z.string(),
  stop_reason: z.string().nullish(),
  content: z.array(AssistantContentBlockSchema),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
    })
    .passthrough()
    .optional(),
});

const UserContentBlockSchema = z.union([
  z.object({
    type: z.literal('text'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.unknown().optional(),
    is_error: z.boolean().optional(),
  }),
  z.object({ type: z.string() }).passthrough(),
]);

export const UserMessageSchema = z.object({
  role: z.literal('user'),
  content: z.union([z.string(), z.array(UserContentBlockSchema)]),
});

export const TranscriptLineSchema = z
  .object({
    type: z.string(),
    uuid: z.string(),
    parentUuid: z.string().nullable().optional(),
    sessionId: z.string(),
    timestamp: z.string(),
    cwd: z.string().optional(),
    version: z.string().optional(),
    gitBranch: z.string().optional(),
    message: z.unknown().optional(),
  })
  .passthrough();

export type TranscriptLine = z.infer<typeof TranscriptLineSchema>;
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;
export type UserMessage = z.infer<typeof UserMessageSchema>;

// --------- Domain types (plain TS) ----------------------------------------

export type ParsedToolCall = {
  id: string;
  toolName: string;
  inputJson: string;
  resultJson: string | null;
  resultIsError: boolean;
};

export type ParsedTurn = {
  id: string;
  parentUuid: string | null;
  sequence: number;
  timestamp: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  stopReason: string | null;
  userPrompt: string | null;
  assistantText: string | null;
  toolCalls: ParsedToolCall[];
};

export type ParsedSession = {
  id: string;
  cwd: string;
  project: string;
  gitBranch: string | null;
  ccVersion: string | null;
  startedAt: number;
  endedAt: number;
  turns: ParsedTurn[];
};
