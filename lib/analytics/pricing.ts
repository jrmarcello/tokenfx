export type ModelPricing = {
  input: number; // $ per 1M tokens
  output: number; // $ per 1M tokens
  cacheRead: number; // $ per 1M tokens
  cacheCreation: number; // $ per 1M tokens (5-minute TTL variant)
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
  cacheCreation: 18.75,
};

const SONNET: ModelPricing = {
  input: 3,
  output: 15,
  cacheRead: 0.3,
  cacheCreation: 3.75,
};

const HAIKU: ModelPricing = {
  input: 1,
  output: 5,
  cacheRead: 0.1,
  cacheCreation: 1.25,
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

export function getPricing(model: string): ModelPricing | null {
  if (!model) return null;
  const key = normalizeModel(model);
  const direct = PRICING[key];
  if (direct) return direct;
  // Also try exact lowercase lookup in case the table key has unusual suffix
  const exact = PRICING[model.toLowerCase()];
  return exact ?? null;
}

export function computeCost(args: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}): number {
  const pricing = getPricing(args.model);
  if (!pricing) return 0;
  const cost =
    (args.inputTokens / 1_000_000) * pricing.input +
    (args.outputTokens / 1_000_000) * pricing.output +
    (args.cacheReadTokens / 1_000_000) * pricing.cacheRead +
    (args.cacheCreationTokens / 1_000_000) * pricing.cacheCreation;
  return Math.round(cost * 1e6) / 1e6;
}
