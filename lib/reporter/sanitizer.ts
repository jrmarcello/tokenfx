import { createHmac } from 'node:crypto';
import { type Result } from '@/lib/result';
import { SanitizedSessionPayload, type SanitizeError } from './types';

/**
 * Input shape consumed by the sanitizer — the raw DB row joined with its
 * aggregates. The sanitizer NEVER spreads this object: every allowlisted
 * field is read explicitly, so any extra keys (e.g. `user_prompt`,
 * `assistant_text`, `tool_uses_json`) are stripped at the boundary.
 */
export type SessionWithAggs = {
  id: string;
  cwd: string;
  started_at: number;
  ended_at: number;
  git_branch: string | null;
  cc_version: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  total_cost_usd: number;
  total_cost_usd_otel: number | null;
  turn_count: number;
  tool_call_count: number;
  model_breakdown: Array<{
    model: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    cost_usd: number;
  }>;
  tool_counts: Record<string, number>;
  avg_rating: number | null;
  cache_hit_ratio: number | null;
  output_input_ratio: number | null;
  subagent_usage_ratio: number | null;
};

/**
 * REQ-2: Derive a non-correlatable project slug from the cwd's last path
 * segment + a per-install secret. HMAC-SHA256 → first 16 hex chars.
 *
 * Throws when the cwd has no usable path segment; callers should map to
 * a SanitizeError of kind 'empty-cwd'.
 */
export const deriveProjectSlug = (
  cwd: string,
  projectSecret: string,
): string => {
  const segment = cwd.split('/').filter(Boolean).pop();
  if (!segment) {
    throw new Error('cwd-empty');
  }
  const hash = createHmac('sha256', projectSecret).update(segment).digest('hex');
  return `slug:${hash.slice(0, 16)}`;
};

/**
 * REQ-1 / REQ-3 / REQ-4: Sanitize a session row + aggregates into the
 * allowlisted payload. Each output field is constructed explicitly — never
 * spread from the input — so injected fields cannot leak. The output is
 * then re-validated by Zod's `.strict()` schema as a defence-in-depth check.
 */
export const sanitizeSession = (
  input: SessionWithAggs,
  ctx: { projectSecret: string },
): Result<SanitizedSessionPayload, SanitizeError> => {
  let projectSlug: string;
  try {
    projectSlug = deriveProjectSlug(input.cwd, ctx.projectSecret);
  } catch {
    return { ok: false, error: { kind: 'empty-cwd' } };
  }

  const candidate = {
    session_id: input.id,
    started_at: input.started_at,
    ended_at: input.ended_at,
    project_slug: projectSlug,
    git_branch: input.git_branch,
    cc_version: input.cc_version,
    total_input_tokens: input.total_input_tokens,
    total_output_tokens: input.total_output_tokens,
    total_cache_read_tokens: input.total_cache_read_tokens,
    total_cache_creation_tokens: input.total_cache_creation_tokens,
    total_cost_usd: input.total_cost_usd,
    total_cost_usd_otel: input.total_cost_usd_otel,
    turn_count: input.turn_count,
    tool_call_count: input.tool_call_count,
    model_breakdown: input.model_breakdown.map((m) => ({
      model: m.model,
      input_tokens: m.input_tokens,
      output_tokens: m.output_tokens,
      cache_read_tokens: m.cache_read_tokens,
      cache_creation_tokens: m.cache_creation_tokens,
      cost_usd: m.cost_usd,
    })),
    tool_counts: { ...input.tool_counts },
    avg_rating: input.avg_rating,
    cache_hit_ratio: input.cache_hit_ratio,
    output_input_ratio: input.output_input_ratio,
    subagent_usage_ratio: input.subagent_usage_ratio,
  };

  const parsed = SanitizedSessionPayload.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      error: { kind: 'zod-validation', issues: parsed.error.issues },
    };
  }
  return { ok: true, value: parsed.data };
};
