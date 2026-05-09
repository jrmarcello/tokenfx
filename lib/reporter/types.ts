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

// Outcome status enum — hardcoded 4 values from local `session_outcomes.status`.
// Drift policy (manager-dashboard-v3-outcomes spec REQ-3): if the local schema
// gains a 5th value, server-side Zod rejects ONLY that session item (per-item
// parse, not batch). Operator discovers via ingestion_log error rows; no
// graceful fallback — explicit failure beats silent data loss.
const outcomeStatusEnum = z.enum([
  'evaluated',
  'cwd-missing',
  'not-a-git-repo',
  'no-user-email',
]);

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

    // ---- v3 outcome fields ----------------------------------------------
    // All 7 fields are `.optional().nullable()` (manager-dashboard-v3-outcomes
    // REQ-7): old reporters omit the keys entirely (.optional handles absence);
    // new reporters with no outcome row send literal null (.nullable handles
    // null); new reporters with an evaluated outcome send the integer/enum.
    // .optional() is LOAD-BEARING — without it, .strict() rejects old payloads.
    commit_count: safeIntNonNeg.nullable().optional(),
    loc_added: safeIntNonNeg.nullable().optional(),
    loc_removed: safeIntNonNeg.nullable().optional(),
    files_changed: safeIntNonNeg.nullable().optional(),
    reverts_within_7d: safeIntNonNeg.nullable().optional(),
    merged_pr_count: safeIntNonNeg.nullable().optional(),
    outcome_status: outcomeStatusEnum.nullable().optional(),
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

/**
 * Wire envelope POSTed to the central server's `/api/ingest` route.
 *
 * Renamed from `SignedEnvelope` (and dropped the `signature` field) when the
 * reporter auth model moved from HMAC-signed payloads to `Authorization:
 * Bearer <secret>` + bcrypt-at-rest (central-server-onboarding spec, REQ-6/7).
 * Payload integrity in transit is provided by TLS; per-payload authenticity
 * is provided by the bearer token tied to `key_id`.
 */
export type IngestEnvelope = {
  version: 1;
  key_id: string;
  machine_id: string;
  payload: SanitizedSessionPayload[];
};
