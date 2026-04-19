'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/lib/db/client';
import {
  executeQuotaSettingsUpdate,
  type UpdateQuotaSettingsResult,
} from './actions.core';

/**
 * Server Action invoked from the QuotaForm. Thin wrapper around
 * `executeQuotaSettingsUpdate`: runs the pure logic, then revalidates the
 * root layout so the nav widget (and any consumer) sees the new settings.
 */
export async function updateQuotaSettings(
  input: unknown
): Promise<UpdateQuotaSettingsResult> {
  const result = executeQuotaSettingsUpdate(getDb(), input, Date.now());
  if (result.ok) {
    revalidatePath('/', 'layout');
  }
  return result;
}
