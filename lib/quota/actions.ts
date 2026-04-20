'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/lib/db/client';
import {
  executeQuota5hResetCalibrationUpdate,
  executeQuota7dResetCalibrationUpdate,
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

/**
 * Server Action for the 5h reset calibration dialog. Accepts
 * `{ quota5hResetAt: number | null }`. Preserves all other settings.
 */
export async function updateQuota5hResetCalibration(
  input: unknown
): Promise<UpdateQuotaSettingsResult> {
  const result = executeQuota5hResetCalibrationUpdate(
    getDb(),
    input,
    Date.now()
  );
  if (result.ok) {
    revalidatePath('/', 'layout');
  }
  return result;
}

/**
 * Server Action for the 7d reset calibration dialog. Accepts
 * `{ quota7dResetAt: number | null }`. Preserves all other settings.
 */
export async function updateQuota7dResetCalibration(
  input: unknown
): Promise<UpdateQuotaSettingsResult> {
  const result = executeQuota7dResetCalibrationUpdate(
    getDb(),
    input,
    Date.now()
  );
  if (result.ok) {
    revalidatePath('/', 'layout');
  }
  return result;
}
