import type { DB } from '@/lib/db/client';
import { upsertUserSettings, type UserSettings } from '@/lib/queries/quota';
import { QuotaSettingsSchema } from './schema';

export type UpdateQuotaSettingsResult =
  | { ok: true }
  | { ok: false; error: { message: string; field?: string } };

/**
 * Pure, testable core of the `updateQuotaSettings` Server Action. Validates
 * the input with Zod, upserts when valid, returns a discriminated union.
 *
 * Kept separate from `actions.ts` so unit/integration tests can exercise the
 * logic without dragging in `next/cache` (which is not usable in Vitest).
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
  const settings: UserSettings = {
    quotaTokens5h: parsed.data.quotaTokens5h,
    quotaTokens7d: parsed.data.quotaTokens7d,
    quotaSessions5h: parsed.data.quotaSessions5h,
    quotaSessions7d: parsed.data.quotaSessions7d,
    updatedAt: now,
  };
  upsertUserSettings(db, settings, now);
  return { ok: true };
};
