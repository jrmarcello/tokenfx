import type { DB } from '@/lib/db/client';
import {
  getUserSettings,
  upsertUserSettings,
  type UserSettings,
} from '@/lib/queries/quota';
import {
  QuotaSettingsSchema,
  Quota5hResetCalibrationSchema,
  Quota7dResetCalibrationSchema,
} from './schema';

export type UpdateQuotaSettingsResult =
  | { ok: true }
  | { ok: false; error: { message: string; field?: string } };

/**
 * Pure, testable core of the `updateQuotaSettings` Server Action. Validates
 * the input with Zod, upserts when valid, returns a discriminated union.
 *
 * Kept separate from `actions.ts` so unit/integration tests can exercise the
 * logic without dragging in `next/cache` (which is not usable in Vitest).
 *
 * Preserves the existing `quota5hResetAt` / `quota7dResetAt` calibrations
 * — those fields have their own dedicated update actions and must not be
 * clobbered when the user edits token thresholds.
 */
export const executeQuotaSettingsUpdate = (
  db: DB,
  input: unknown,
  now: number
): UpdateQuotaSettingsResult => {
  const parsed = QuotaSettingsSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: {
        message: first?.message ?? 'Invalid input',
        field: first?.path.join('.') || undefined,
      },
    };
  }
  const prior = getUserSettings(db);
  // REQ-2: sessions fields are no longer tracked (removed from the Zod
  // schema in TASK-2). Hard-wire both to `null` so the next save clears any
  // legacy non-null values a prior version of the app may have written.
  const settings: UserSettings = {
    quotaTokens5h: parsed.data.quotaTokens5h,
    quotaTokens7d: parsed.data.quotaTokens7d,
    quotaSessions5h: null,
    quotaSessions7d: null,
    quota5hResetAt: prior.quota5hResetAt,
    quota7dResetAt: prior.quota7dResetAt,
    updatedAt: now,
  };
  upsertUserSettings(db, settings, now);
  return { ok: true };
};

/**
 * Dedicated action for the 5h reset calibration (value copied from Claude.ai).
 * Preserves all token/session settings and the 7d calibration.
 * Nullable payload: `null` clears the calibration, reverting to the
 * activity-based heuristic.
 */
export const executeQuota5hResetCalibrationUpdate = (
  db: DB,
  input: unknown,
  now: number
): UpdateQuotaSettingsResult => {
  const parsed = Quota5hResetCalibrationSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: {
        message: first?.message ?? 'Invalid input',
        field: first?.path.join('.') || undefined,
      },
    };
  }
  const prior = getUserSettings(db);
  const settings: UserSettings = {
    quotaTokens5h: prior.quotaTokens5h,
    quotaTokens7d: prior.quotaTokens7d,
    quotaSessions5h: null,
    quotaSessions7d: null,
    quota5hResetAt: parsed.data.quota5hResetAt,
    quota7dResetAt: prior.quota7dResetAt,
    updatedAt: now,
  };
  upsertUserSettings(db, settings, now);
  return { ok: true };
};

/**
 * Dedicated action for the 7d reset calibration (value copied from Claude.ai).
 * Preserves all token/session settings and the 5h calibration.
 * Nullable payload: `null` clears the calibration, reverting to the
 * activity-based heuristic.
 */
export const executeQuota7dResetCalibrationUpdate = (
  db: DB,
  input: unknown,
  now: number
): UpdateQuotaSettingsResult => {
  const parsed = Quota7dResetCalibrationSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: {
        message: first?.message ?? 'Invalid input',
        field: first?.path.join('.') || undefined,
      },
    };
  }
  const prior = getUserSettings(db);
  const settings: UserSettings = {
    quotaTokens5h: prior.quotaTokens5h,
    quotaTokens7d: prior.quotaTokens7d,
    quotaSessions5h: null,
    quotaSessions7d: null,
    quota5hResetAt: prior.quota5hResetAt,
    quota7dResetAt: parsed.data.quota7dResetAt,
    updatedAt: now,
  };
  upsertUserSettings(db, settings, now);
  return { ok: true };
};
