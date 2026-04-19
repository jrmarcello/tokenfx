export type ModelPricing = {
  input: number; // $ per 1M tokens
  output: number; // $ per 1M tokens
  cacheRead: number; // $ per 1M tokens
  cacheCreation5m: number; // $ per 1M tokens (5-minute TTL, 1.25× input)
  cacheCreation1h: number; // $ per 1M tokens (1-hour TTL, 2× input)
};

/**
 * Last time the pricing table below was reviewed against
 * https://www.anthropic.com/pricing. Update this constant alongside any
 * price change — the CLI logs a warning when the table is older than
 * {@link STALE_THRESHOLD_DAYS} so stale costs don't silently accumulate.
 *
 * Anthropic does not expose a pricing API. Auto-scraping the pricing page
 * is fragile (the markup is not a stable contract). The practical path is:
 * a quick manual audit every ~30–60 days + this staleness check.
 */
export const PRICING_LAST_UPDATED = '2026-04-18';
export const STALE_THRESHOLD_DAYS = 90;

/**
 * Days since `PRICING_LAST_UPDATED`. Used by the ingest CLI to emit a
 * gentle warning if the table hasn't been audited in a while.
 */
export function getPricingAgeDays(now: number = Date.now()): number {
  const updatedAt = Date.parse(PRICING_LAST_UPDATED);
  if (Number.isNaN(updatedAt)) return 0;
  return Math.floor((now - updatedAt) / 86_400_000);
}

const OPUS: ModelPricing = {
  input: 15,
  output: 75,
  cacheRead: 1.5,
  cacheCreation5m: 18.75,
  cacheCreation1h: 30,
};

const SONNET: ModelPricing = {
  input: 3,
  output: 15,
  cacheRead: 0.3,
  cacheCreation5m: 3.75,
  cacheCreation1h: 6,
};

const HAIKU: ModelPricing = {
  input: 1,
  output: 5,
  cacheRead: 0.1,
  cacheCreation5m: 1.25,
  cacheCreation1h: 2,
};

export const PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-1": OPUS,
  "claude-opus-4-7": OPUS,
  "claude-sonnet-4-5": SONNET,
  "claude-sonnet-4-6": SONNET,
  "claude-haiku-4-5": HAIKU,
};

/**
 * Normalize a model string for lookup:
 * - lowercase
 * - strip `[1m]` (and similar bracket suffixes)
 * - strip trailing date suffix `-YYYYMMDD`
 */
function normalizeModel(model: string): string {
  let s = model.toLowerCase().trim();
  // Strip any bracket suffix e.g. "[1m]"
  s = s.replace(/\[[^\]]*\]$/, "");
  // Strip trailing date-like suffix "-YYYYMMDD"
  s = s.replace(/-\d{8}$/, "");
  return s.trim();
}

/**
 * Family-prefix match: `claude-opus-*` → OPUS, etc. This keeps future
 * Claude releases priced correctly without requiring a table update on
 * every minor version bump (which otherwise silently cost $0 — a
 * previously shipped bug where 22k+ `claude-opus-4-6` turns were
 * recorded at zero cost).
 */
const FAMILY_PATTERN = /^claude-(opus|sonnet|haiku)\b/;
const FAMILY_PRICING: Record<'opus' | 'sonnet' | 'haiku', ModelPricing> = {
  opus: OPUS,
  sonnet: SONNET,
  haiku: HAIKU,
};

export function getPricing(model: string): ModelPricing | null {
  if (!model) return null;
  const key = normalizeModel(model);
  const direct = PRICING[key];
  if (direct) return direct;
  // Also try exact lowercase lookup in case the table key has unusual suffix
  const exact = PRICING[model.toLowerCase()];
  if (exact) return exact;
  // Family-prefix fallback — catches unreleased-at-audit-time versions
  // (e.g. claude-opus-4-8) as long as Anthropic keeps family pricing stable.
  const familyMatch = FAMILY_PATTERN.exec(key);
  if (familyMatch) {
    return FAMILY_PRICING[familyMatch[1] as 'opus' | 'sonnet' | 'haiku'];
  }
  return null;
}

/**
 * Service-tier multiplier applied to the final cost.
 * - `standard` (default): 1.0
 * - `batch`: 0.5 (Anthropic batch API = 50% off)
 * - `priority`: 1.0 (permissive — Anthropic hasn't documented the exact
 *   multiplier; keep list price until they do)
 * - anything else: 1.0 (permissive fallback; never crash on unknown tier)
 */
function serviceTierMultiplier(tier: string | undefined): number {
  if (tier === "batch") return 0.5;
  // standard, priority, unknown → 1.0
  return 1.0;
}

export function computeCost(args: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreation5mTokens?: number;
  cacheCreation1hTokens?: number;
  /**
   * Legacy aggregate — assumed to be 100% 5m TTL when provided AND
   * `cacheCreation5mTokens` is NOT provided. Never summed with the split
   * params (REQ-12 priority).
   */
  cacheCreationTokens?: number;
  serviceTier?: 'standard' | 'batch' | 'priority' | string;
}): number {
  const pricing = getPricing(args.model);
  if (!pricing) return 0;

  // Resolve cache-creation tokens per REQ-12 priority:
  // 1. split param wins (use cacheCreation5mTokens + cacheCreation1hTokens ?? 0)
  // 2. else legacy aggregate (treat as 100% 5m, 1h = 0)
  // 3. else both 0
  let tokens5m = 0;
  let tokens1h = 0;
  if (args.cacheCreation5mTokens !== undefined) {
    tokens5m = args.cacheCreation5mTokens;
    tokens1h = args.cacheCreation1hTokens ?? 0;
  } else if (args.cacheCreation1hTokens !== undefined) {
    // Only 1h provided (no split-5m, no legacy) — treat 5m as 0.
    tokens5m = 0;
    tokens1h = args.cacheCreation1hTokens;
  } else if (args.cacheCreationTokens !== undefined) {
    tokens5m = args.cacheCreationTokens;
    tokens1h = 0;
  }

  const rawCost =
    (args.inputTokens / 1_000_000) * pricing.input +
    (args.outputTokens / 1_000_000) * pricing.output +
    (args.cacheReadTokens / 1_000_000) * pricing.cacheRead +
    (tokens5m / 1_000_000) * pricing.cacheCreation5m +
    (tokens1h / 1_000_000) * pricing.cacheCreation1h;

  const multiplier = serviceTierMultiplier(args.serviceTier);
  const cost = rawCost * multiplier;
  return Math.round(cost * 1e6) / 1e6;
}
