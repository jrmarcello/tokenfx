import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DB } from '@/lib/db/client';
import { migrate } from '@/lib/db/migrate';
import { getUserSettings } from '@/lib/queries/quota';
import { executeQuotaSettingsUpdate } from './actions.core';

function freshDb(): DB {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

describe('executeQuotaSettingsUpdate', () => {
  let db: DB;
  beforeEach(() => {
    db = freshDb();
  });

  it('TC-I-13 (REQ-6, happy): valid payload persists and returns ok', () => {
    const now = 1_700_000_000_000;
    const result = executeQuotaSettingsUpdate(
      db,
      {
        quotaTokens5h: 50_000,
        quotaTokens7d: 500_000,
        quotaSessions5h: null,
        quotaSessions7d: null,
      },
      now
    );
    expect(result).toEqual({ ok: true });
    const saved = getUserSettings(db);
    expect(saved).toEqual({
      quotaTokens5h: 50_000,
      quotaTokens7d: 500_000,
      quotaSessions5h: null,
      quotaSessions7d: null,
      updatedAt: now,
    });
  });

  it('TC-I-14 (REQ-5, validation): -1 input rejected, nothing written', () => {
    const now = 1_700_000_000_000;
    const result = executeQuotaSettingsUpdate(
      db,
      {
        quotaTokens5h: -1,
        quotaTokens7d: null,
        quotaSessions5h: null,
        quotaSessions7d: null,
      },
      now
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.field).toBe('quotaTokens5h');
    expect(typeof result.error.message).toBe('string');
    expect(result.error.message.length).toBeGreaterThan(0);

    // Settings table untouched: getUserSettings returns the empty shape.
    const saved = getUserSettings(db);
    expect(saved).toEqual({
      quotaTokens5h: null,
      quotaTokens7d: null,
      quotaSessions5h: null,
      quotaSessions7d: null,
      updatedAt: null,
    });
  });
});
