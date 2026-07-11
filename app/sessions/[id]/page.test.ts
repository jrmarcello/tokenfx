// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Env contract (lib/ingest/auto.ts + lib/db/client.ts): both vars must be set
// BEFORE the page module (and its transitive getDb/ensureFreshIngest imports)
// is loaded, so the module-level singletons bind to the temp DB and the
// auto-ingest short-circuits deterministically.
const tempDir = mkdtempSync(path.join(tmpdir(), 'tokenfx-session-page-'));
process.env.DASHBOARD_DB_PATH = path.join(tempDir, 'test.db');
process.env.TOKENFX_DISABLE_AUTO_INGEST = '1';

import { getDb, resetDbSingleton, type DB } from '@/lib/db/client';
import { generateMetadata } from './page';

const seedSession = (db: DB, id: string, project: string): void => {
  db.prepare(
    `INSERT INTO sessions (
      id, slug, cwd, project, git_branch, cc_version,
      started_at, ended_at,
      total_input_tokens, total_output_tokens, total_cache_read_tokens, total_cache_creation_tokens,
      total_cost_usd, total_cost_usd_otel, turn_count, tool_call_count,
      source_file, ingested_at
    ) VALUES (?, NULL, '/tmp/cwd', ?, 'main', '1.0.0', ?, ?, 1000, 500, 2000, 100, 1.5, NULL, 3, 2, ?, ?)`,
  ).run(id, project, Date.now() - 60_000, Date.now(), `file-${id}.jsonl`, Date.now());
};

describe('sessions/[id] generateMetadata', () => {
  beforeAll(() => {
    seedSession(getDb(), 'seeded-session-1', 'tokenfx-demo');
  });

  afterAll(() => {
    resetDbSingleton();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects with Next notFound error (HTTP 404 digest) for a nonexistent session id', async () => {
    const promise = generateMetadata({
      params: Promise.resolve({ id: 'does-not-exist' }),
    });
    await expect(promise).rejects.toSatisfy((err: unknown) => {
      const digest =
        typeof err === 'object' && err !== null && 'digest' in err
          ? String((err as { digest: unknown }).digest)
          : '';
      expect(digest).toContain('NEXT_HTTP_ERROR_FALLBACK;404');
      return true;
    });
  });

  it('resolves with a title containing the session project for an existing session', async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ id: 'seeded-session-1' }),
    });
    expect(metadata.title).toContain('tokenfx-demo');
  });

  it('propagates DB failures instead of swallowing them (closed database handle)', async () => {
    // Hand-simulated infra failure: close the singleton handle so the next
    // prepared-statement call inside getSession throws. getDb() returns the
    // same (now unusable) instance because DASHBOARD_DB_PATH is unchanged.
    getDb().close();
    const promise = generateMetadata({
      params: Promise.resolve({ id: 'any-id-after-db-failure' }),
    });
    await expect(promise).rejects.toSatisfy((err: unknown) => {
      // Must be a real DB error, NOT a swallowed nullish result and NOT a 404.
      const digest =
        typeof err === 'object' && err !== null && 'digest' in err
          ? String((err as { digest: unknown }).digest)
          : '';
      expect(digest).not.toContain('404');
      expect(err).toBeInstanceOf(Error);
      return true;
    });
  });
});
