import { z } from 'zod';

// Token fields: nullable; positive integer (excludes 0 — use null to disable);
// capped at 1 billion (1_000_000_000) as a generous upper bound.
const tokenField = z.number().int().positive().max(1_000_000_000).nullable();

// Session fields: nullable; positive integer; capped at 10_000.
const sessionField = z.number().int().positive().max(10_000).nullable();

export const QuotaSettingsSchema = z.object({
  quotaTokens5h: tokenField,
  quotaTokens7d: tokenField,
  quotaSessions5h: sessionField,
  quotaSessions7d: sessionField,
});

export type QuotaSettingsInput = z.infer<typeof QuotaSettingsSchema>;
