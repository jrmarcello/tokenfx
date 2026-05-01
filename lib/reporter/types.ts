import { z } from 'zod';

// SafeInt — accepts only integers in [0, MAX_SAFE_INTEGER]. Excludes NaN/Infinity.
const safeIntNonNeg = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .finite();

const modelBreakdownEntry = z
  .object({
    model: z.string().max(128),
    input_tokens: safeIntNonNeg,
    output_tokens: safeIntNonNeg,
    cache_read_tokens: safeIntNonNeg,
    cache_creation_tokens: safeIntNonNeg,
    cost_usd: z.number().min(0).finite(),
  })
  .strict();

export const SanitizedSessionPayload = z
  .object({
    session_id: z.string().min(1).max(128),
    started_at: safeIntNonNeg,
    ended_at: safeIntNonNeg,
    project_slug: z.string().regex(/^slug:[0-9a-f]{16}$/),
    git_branch: z.string().max(255).nullable(),
    cc_version: z.string().max(64).nullable(),
    total_input_tokens: safeIntNonNeg,
    total_output_tokens: safeIntNonNeg,
    total_cache_read_tokens: safeIntNonNeg,
    total_cache_creation_tokens: safeIntNonNeg,
    total_cost_usd: z.number().min(0).finite(),
    total_cost_usd_otel: z.number().min(0).finite().nullable(),
    turn_count: z.number().int().min(0).finite(),
    tool_call_count: z.number().int().min(0).finite(),
    model_breakdown: z.array(modelBreakdownEntry),
    tool_counts: z.record(
      z.string().max(64),
      z.number().int().min(0).max(1_000_000).finite(),
    ),
    avg_rating: z.number().min(-1).max(1).finite().nullable(),
    cache_hit_ratio: z.number().min(0).max(1).finite().nullable(),
    output_input_ratio: z.number().min(0).finite().nullable(),
    subagent_usage_ratio: z.number().min(0).max(1).finite().nullable(),
  })
  .strict()
  .refine((p) => p.started_at <= p.ended_at, {
    message: 'started_at > ended_at',
  });

export type SanitizedSessionPayload = z.infer<typeof SanitizedSessionPayload>;

export type SanitizeError =
  | { kind: 'zod-validation'; issues: z.ZodIssue[] }
  | { kind: 'empty-cwd' }
  | { kind: 'invalid-input'; reason: string };
