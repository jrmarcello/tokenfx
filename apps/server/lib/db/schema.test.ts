import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('migrations 0000_init.sql', () => {
  const sqlPath = join(__dirname, 'migrations', '0000_init.sql');
  const sqlContents = readFileSync(sqlPath, 'utf8');

  const expectedTables = [
    'orgs',
    'teams',
    'users',
    'user_machines',
    'sessions_agg',
    'model_breakdown_agg',
    'tool_count_agg',
    'cost_calibration_per_user',
    'ingestion_log',
  ] as const;

  it.each(expectedTables)('contains CREATE TABLE for %s', (table) => {
    expect(sqlContents).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
  });

  it('declares all 9 expected tables (no extras)', () => {
    const matches = sqlContents.match(/CREATE TABLE IF NOT EXISTS (\w+)/g) ?? [];
    expect(matches).toHaveLength(expectedTables.length);
  });

  it('adds compound FKs for model_breakdown_agg and tool_count_agg', () => {
    expect(sqlContents).toContain('fk_mba_session');
    expect(sqlContents).toContain('fk_tca_session');
    expect(sqlContents).toContain('REFERENCES sessions_agg(user_id, session_id)');
  });

  it('declares the secondary indexes used by query plans', () => {
    expect(sqlContents).toContain('idx_sessions_agg_started');
    expect(sqlContents).toContain('idx_sessions_agg_user_started');
    expect(sqlContents).toContain('idx_ingestion_log_received');
    expect(sqlContents).toContain('idx_ingestion_log_user');
  });

  it('enforces the users.role check constraint', () => {
    expect(sqlContents).toContain('users_role_check');
    expect(sqlContents).toContain("'member'");
    expect(sqlContents).toContain("'manager'");
    expect(sqlContents).toContain("'admin'");
  });
});
