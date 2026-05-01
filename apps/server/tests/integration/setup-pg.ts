/**
 * Vitest globalSetup for Postgres-backed integration tests (REQ-22).
 *
 * Spins up a single Postgres 16 Testcontainer shared across the entire
 * `apps/server/tests/integration/**` suite, runs Drizzle migrations once,
 * and exposes `DATABASE_URL` on `process.env` so individual tests can
 * connect via `lib/db/client.ts`.
 *
 * To skip the Postgres-backed suite (e.g. local dev without Docker), set
 * `SKIP_PG_TESTS=1`. Tests that touch Postgres should guard their
 * `describe`/`it` with the idiom below so unit-only runs still pass:
 *
 *   import { describe, it } from 'vitest';
 *   const skipIfNoPg = process.env.SKIP_PG_TESTS === '1' ? describe.skip : describe;
 *   skipIfNoPg('with Postgres', () => {
 *     it('does the thing', async () => {
 *       // ...
 *     });
 *   });
 *
 * Vitest invokes the exported `setup` once before any test file runs and
 * `teardown` once after the entire suite finishes.
 */
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

let container: StartedPostgreSqlContainer | null = null;

export const setup = async (): Promise<void> => {
  if (process.env.SKIP_PG_TESTS === '1') {
    console.log('[setup-pg] SKIP_PG_TESTS=1 — skipping Postgres setup');
    return;
  }

  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('tokenfx_test')
    .withUsername('test')
    .withPassword('test')
    .start();

  process.env.DATABASE_URL = container.getConnectionUri();

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const migrationsFolder = path.resolve(__dirname, '../../lib/db/migrations');
  const journalPath = path.join(migrationsFolder, 'meta', '_journal.json');
  try {
    if (existsSync(journalPath)) {
      // Drizzle-kit-managed migrations (production path).
      const db = drizzle(pool);
      await migrate(db, { migrationsFolder });
    } else {
      // Hand-crafted .sql files without a Drizzle journal — apply directly.
      // This keeps TASK-11 working until `drizzle-kit generate` is wired up
      // in CI to produce the journal alongside committed SQL.
      const files = readdirSync(migrationsFolder)
        .filter((f) => f.endsWith('.sql'))
        .sort();
      for (const file of files) {
        const sql = readFileSync(path.join(migrationsFolder, file), 'utf8');
        await pool.query(sql);
      }
    }
  } finally {
    await pool.end();
  }
};

export const teardown = async (): Promise<void> => {
  if (container) {
    await container.stop();
    container = null;
  }
};
