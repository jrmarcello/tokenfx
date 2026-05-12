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

      // Apply any hand-crafted .sql migrations not yet registered in the
      // journal. The journal entry is produced by a dedicated TASK-SNAPSHOT
      // step at the END of the SDD spec; until that lands, sibling Batch-2+
      // tasks still need the schema to be present in the test DB to validate.
      // Raw pool.query() does NOT wrap in a transaction, so statements like
      // `ALTER TYPE ... ADD VALUE` (forbidden inside a tx) execute cleanly.
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
        entries: { tag: string }[];
      };
      const knownTags = new Set(journal.entries.map((e) => e.tag));
      const orphans = readdirSync(migrationsFolder)
        .filter((f) => f.endsWith('.sql'))
        .filter((f) => !knownTags.has(f.replace(/\.sql$/, '')))
        .sort();
      for (const file of orphans) {
        const sql = readFileSync(path.join(migrationsFolder, file), 'utf8');
        // Drizzle-style `--> statement-breakpoint` separators split a single
        // migration into discrete statements. Without splitting, pg's parser
        // treats the breakpoint marker (a comment) followed by the next
        // statement as one query string — fine for most DDL, but fatal for
        // a file containing `ALTER TYPE ... ADD VALUE` (which must be the
        // first statement in its own simple-query). Split + filter empties.
        // Split ONLY on lines that are literally `--> statement-breakpoint`
        // (possibly surrounded by whitespace). The marker also appears
        // mid-comment as documentation (e.g. backtick-quoted `--> ...`) — a
        // naive `.split('--> statement-breakpoint')` would chop those too,
        // landing a stray fragment of comment text at the start of the next
        // chunk and crashing the PG parser at position 1.
        const stmts = sql
          .split(/^[ \t]*-->[ \t]+statement-breakpoint[ \t]*$/m)
          .map((s) => s.trim())
          // Filter out empty chunks AND chunks that are pure SQL line
          // comments (`-- ...` only). Postgres' simple-query parser rejects
          // a query that contains no executable token.
          .filter((s) => {
            if (s.length === 0) return false;
            const stripped = s
              .split('\n')
              .map((l) => l.trim())
              .filter((l) => l.length > 0 && !l.startsWith('--'))
              .join('\n');
            if (stripped.length === 0) return false;
            // Skip statements that use psql client-side variable substitution
            // (e.g. `:"app_role"`). These are executed via psql in production
            // but pg-node's simple-query protocol does not parse them. The
            // affected statements (REVOKE/GRANT against role placeholders)
            // are production hardening with no test-time semantics.
            if (/:"[A-Za-z_][A-Za-z0-9_]*"/.test(stripped)) return false;
            return true;
          });
        for (const stmt of stmts) {
          await pool.query(stmt);
        }
      }
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
