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
      quota5hResetAt: null,
      quota7dResetAt: null,
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
      quota5hResetAt: null,
      quota7dResetAt: null,
      updatedAt: null,
    });
  });

  it('TC-I-01 (REQ-2, happy): hard-wires session fields to null on fresh db', () => {
    const now = 1_700_000_000_000;
    const result = executeQuotaSettingsUpdate(
      db,
      { quotaTokens5h: 500_000, quotaTokens7d: null },
      now
    );
    expect(result).toEqual({ ok: true });
    const saved = getUserSettings(db);
    expect(saved).toEqual({
      quotaTokens5h: 500_000,
      quotaTokens7d: null,
      quotaSessions5h: null,
      quotaSessions7d: null,
      quota5hResetAt: null,
      quota7dResetAt: null,
      updatedAt: now,
    });
  });

  it('TC-I-02 (REQ-2, business): clears legacy non-null session values on next save', () => {
    // Seed a pre-existing row as if written by an older version of the app.
    db.prepare(
      `INSERT INTO user_settings (
        id, quota_tokens_5h, quota_tokens_7d,
        quota_sessions_5h, quota_sessions_7d, updated_at
      ) VALUES (1, ?, ?, ?, ?, ?)`
    ).run(50_000, null, 100, null, 1_699_000_000_000);

    // Sanity: legacy value is present.
    const legacy = db
      .prepare(
        `SELECT quota_sessions_5h AS s5h FROM user_settings WHERE id = 1`
      )
      .get() as { s5h: number | null };
    expect(legacy.s5h).toBe(100);

    const now = 1_700_000_000_000;
    const result = executeQuotaSettingsUpdate(
      db,
      { quotaTokens5h: 700_000, quotaTokens7d: null },
      now
    );
    expect(result).toEqual({ ok: true });

    const saved = getUserSettings(db);
    expect(saved.quotaTokens5h).toBe(700_000);
    expect(saved.quotaSessions5h).toBeNull();
    expect(saved.quotaSessions7d).toBeNull();
    expect(saved.updatedAt).toBe(now);

    // Proof via raw SQL: legacy column is null after the save.
    const raw = db
      .prepare(
        `SELECT quota_sessions_5h AS s5h FROM user_settings WHERE id = 1`
      )
      .get() as { s5h: number | null };
    expect(raw.s5h).toBeNull();
  });
});
