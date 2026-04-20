import { z } from 'zod';

// Token fields: nullable; positive integer (excludes 0 — use null to disable);
// capped at 1 billion (1_000_000_000) as a generous upper bound.
const tokenField = z.number().int().positive().max(1_000_000_000).nullable();

export const QuotaSettingsSchema = z.object({
  quotaTokens5h: tokenField,
  quotaTokens7d: tokenField,
});

export type QuotaSettingsInput = z.infer<typeof QuotaSettingsSchema>;

// Optional calibrations for the rolling quota windows. Stored as epoch ms;
// must be finite integers. Nullable so clearing a calibration reverts to the
// activity-based heuristic for that window.
const resetCalibrationField = z.number().int().finite().nullable();

export const Quota5hResetCalibrationSchema = z.object({
  quota5hResetAt: resetCalibrationField,
});

export type Quota5hResetCalibrationInput = z.infer<
  typeof Quota5hResetCalibrationSchema
>;

export const Quota7dResetCalibrationSchema = z.object({
  quota7dResetAt: resetCalibrationField,
});

export type Quota7dResetCalibrationInput = z.infer<
  typeof Quota7dResetCalibrationSchema
>;
